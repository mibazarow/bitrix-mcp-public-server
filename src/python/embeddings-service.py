"""Embedding service for bxmcp and BXADMIN-S.

One model process serves several consumers with different "profiles".
A profile fixes the task instruction prefix (which the model requires) and
the output dimensionality (Matryoshka truncation), so the same weights answer
MCP documentation queries and site-content queries differently.

Modalities:
  text   — always available
  image  — enabled by default, shares the 768-d space with text, so a text
           query can retrieve images and vice versa
  audio  — disabled; the harness does not need it and it costs 300M params

Enabling the vision encoder does NOT change text embeddings (verified: max
absolute difference 0.0 against a text-only load), so switching modalities
never requires reindexing a text corpus.

Environment:
  EMBEDDING_MODEL         model id (default google/embeddinggemma-2)
  EMBEDDING_DIM           default output dimension (default 256)
  EMBEDDING_MAX_SEQ       max tokens per text input (default 512)
  EMBEDDING_THREADS       torch intra-op threads (default 2)
  EMBEDDING_TEXT_ONLY     "1" disables the vision encoder (default 0)
  EMBEDDING_IMAGE_TOKENS  vision soft tokens per image, 70..1120 (default 280)
  EMBEDDING_BATCH         max texts per /embed/batch call (default 32)
  HF_HOME                 model cache directory
"""

import base64
import binascii
import io
import os
import threading
import time
from contextlib import asynccontextmanager
from typing import Literal

import torch
from fastapi import FastAPI, HTTPException
from PIL import Image
from pydantic import BaseModel, Field
from sentence_transformers import SentenceTransformer

MODEL_ID = os.environ.get("EMBEDDING_MODEL", "google/embeddinggemma-2")
DEFAULT_DIM = int(os.environ.get("EMBEDDING_DIM", "256"))
MAX_SEQ = int(os.environ.get("EMBEDDING_MAX_SEQ", "512"))
THREADS = int(os.environ.get("EMBEDDING_THREADS", "2"))
TEXT_ONLY = os.environ.get("EMBEDDING_TEXT_ONLY", "0") == "1"
IMAGE_TOKENS = int(os.environ.get("EMBEDDING_IMAGE_TOKENS", "280"))
MAX_BATCH = int(os.environ.get("EMBEDDING_BATCH", "32"))
MAX_IMAGE_BYTES = int(os.environ.get("EMBEDDING_MAX_IMAGE_BYTES", str(12 * 1024 * 1024)))

ALLOWED_DIMS = (128, 256, 512, 768)
ALLOWED_IMAGE_TOKENS = (70, 140, 280, 560, 1120)

PROFILES = {
    "docs_query": "SearchQuery",
    "docs_passage": "Document",
    "site_query": "SearchQuery",
    "site_passage": "Document",
    "code_query": "CodeRetrieval",
    "generic": None,
}

ProfileName = Literal[
    "docs_query", "docs_passage", "site_query", "site_passage", "code_query", "generic"
]

model: SentenceTransformer | None = None
encode_lock = threading.Lock()
load_seconds: float = 0.0
encode_count: int = 0
encode_seconds: float = 0.0
image_count: int = 0
image_seconds: float = 0.0


def load_model() -> SentenceTransformer:
    torch.set_num_threads(THREADS)
    config_kwargs = {"vision_config": None, "audio_config": None} if TEXT_ONLY else {"audio_config": None}
    m = SentenceTransformer(
        MODEL_ID,
        model_kwargs={"torch_dtype": torch.float32},
        config_kwargs=config_kwargs,
    )
    m.max_seq_length = MAX_SEQ
    if not TEXT_ONLY:
        processor = m[0].processor.image_processor
        processor.max_soft_tokens = IMAGE_TOKENS
        processor.image_seq_length = IMAGE_TOKENS
    return m


@asynccontextmanager
async def lifespan(app: FastAPI):
    global model, load_seconds
    started = time.time()
    model = load_model()
    load_seconds = round(time.time() - started, 2)
    yield
    model = None


app = FastAPI(title="bxmcp embeddings", lifespan=lifespan)


class EmbeddingRequest(BaseModel):
    text: str
    profile: ProfileName = "generic"
    dim: int | None = Field(default=None, description="128, 256, 512 or 768")


class BatchEmbeddingRequest(BaseModel):
    texts: list[str]
    profile: ProfileName = "generic"
    dim: int | None = Field(default=None, description="128, 256, 512 or 768")


class ImageEmbeddingRequest(BaseModel):
    image_base64: str = Field(description="Image bytes, base64 encoded (raw or data URL)")
    dim: int | None = Field(default=None, description="128, 256, 512 or 768")
    image_tokens: int | None = Field(default=None, description="70, 140, 280, 560 or 1120")


def resolve_dim(dim: int | None) -> int:
    value = DEFAULT_DIM if dim is None else dim
    if value not in ALLOWED_DIMS:
        raise HTTPException(status_code=422, detail=f"dim must be one of {ALLOWED_DIMS}")
    return value


def require_model() -> SentenceTransformer:
    if model is None:
        raise HTTPException(status_code=503, detail="model is not loaded")
    return model


def encode(texts: list[str], profile: str, dim: int) -> list[list[float]]:
    global encode_count, encode_seconds
    m = require_model()
    prompt_name = PROFILES[profile]
    started = time.time()
    with encode_lock:
        vectors = m.encode(
            texts,
            prompt_name=prompt_name,
            truncate_dim=dim,
            normalize_embeddings=True,
            batch_size=min(len(texts), MAX_BATCH),
            show_progress_bar=False,
        )
    elapsed = time.time() - started
    encode_count += len(texts)
    encode_seconds += elapsed
    return [v.tolist() for v in vectors]


def decode_image(payload: str) -> Image.Image:
    if payload.startswith("data:"):
        _, _, payload = payload.partition(",")
    try:
        raw = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(status_code=422, detail="image_base64 is not valid base64")
    if len(raw) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail=f"image exceeds {MAX_IMAGE_BYTES} bytes")
    try:
        return Image.open(io.BytesIO(raw)).convert("RGB")
    except Exception:
        raise HTTPException(status_code=422, detail="image_base64 is not a decodable image")


@app.post("/embed")
def embed(request: EmbeddingRequest):
    dim = resolve_dim(request.dim)
    vector = encode([request.text], request.profile, dim)[0]
    return {"embedding": vector, "dim": dim, "profile": request.profile, "model": MODEL_ID}


@app.post("/embed/batch")
def embed_batch(request: BatchEmbeddingRequest):
    if not request.texts:
        return {"embeddings": [], "dim": resolve_dim(request.dim), "profile": request.profile, "model": MODEL_ID}
    if len(request.texts) > MAX_BATCH:
        raise HTTPException(status_code=422, detail=f"batch is limited to {MAX_BATCH} texts")
    dim = resolve_dim(request.dim)
    vectors = encode(request.texts, request.profile, dim)
    return {"embeddings": vectors, "dim": dim, "profile": request.profile, "model": MODEL_ID}


@app.post("/embed/image")
def embed_image(request: ImageEmbeddingRequest):
    global image_count, image_seconds
    m = require_model()
    if TEXT_ONLY:
        raise HTTPException(status_code=503, detail="vision encoder is disabled (EMBEDDING_TEXT_ONLY=1)")
    tokens = IMAGE_TOKENS if request.image_tokens is None else request.image_tokens
    if tokens not in ALLOWED_IMAGE_TOKENS:
        raise HTTPException(status_code=422, detail=f"image_tokens must be one of {ALLOWED_IMAGE_TOKENS}")
    dim = resolve_dim(request.dim)
    image = decode_image(request.image_base64)

    processor = m[0].processor.image_processor
    started = time.time()
    with encode_lock:
        processor.max_soft_tokens = tokens
        processor.image_seq_length = tokens
        vector = m.encode(image, truncate_dim=dim, normalize_embeddings=True)
    elapsed = time.time() - started
    image_count += 1
    image_seconds += elapsed
    return {
        "embedding": vector.tolist(),
        "dim": dim,
        "image_tokens": tokens,
        "model": MODEL_ID,
        "elapsed_ms": round(elapsed * 1000),
    }


@app.get("/health")
def health():
    return {
        "status": "ok" if model is not None else "loading",
        "model": MODEL_ID,
        "dim": DEFAULT_DIM,
        "max_seq_length": MAX_SEQ,
        "threads": THREADS,
        "modalities": {"text": True, "image": not TEXT_ONLY, "audio": False},
        "image_tokens": None if TEXT_ONLY else IMAGE_TOKENS,
        "profiles": {name: prompt for name, prompt in PROFILES.items()},
        "load_seconds": load_seconds,
        "encoded_texts": encode_count,
        "avg_ms_per_text": round(encode_seconds / encode_count * 1000, 1) if encode_count else None,
        "encoded_images": image_count,
        "avg_ms_per_image": round(image_seconds / image_count * 1000) if image_count else None,
    }


@app.get("/profiles")
def profiles():
    return {
        "default_dim": DEFAULT_DIM,
        "allowed_dims": list(ALLOWED_DIMS),
        "allowed_image_tokens": list(ALLOWED_IMAGE_TOKENS),
        "profiles": {
            name: {"prompt_name": prompt, "prefix": (model.prompts.get(prompt) if (model and prompt) else "")}
            for name, prompt in PROFILES.items()
        },
    }
