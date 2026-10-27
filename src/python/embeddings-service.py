"""Embedding service for bxmcp and BXADMIN-S.

One model process serves several consumers with different "profiles".
A profile fixes the task instruction prefix (which the model requires) and
the output dimensionality (Matryoshka truncation), so the same weights answer
MCP documentation queries and site-content queries differently.

Environment:
  EMBEDDING_MODEL       model id (default google/embeddinggemma-2)
  EMBEDDING_DIM         default output dimension (default 256)
  EMBEDDING_MAX_SEQ     max tokens per input (default 512)
  EMBEDDING_THREADS     torch intra-op threads (default 2)
  EMBEDDING_TEXT_ONLY   "1" disables vision/audio encoders (default 1)
  EMBEDDING_BATCH       max inputs per /embed/batch call (default 32)
  HF_HOME               model cache directory
"""

import os
import threading
import time
from contextlib import asynccontextmanager
from typing import Literal

import torch
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from sentence_transformers import SentenceTransformer

MODEL_ID = os.environ.get("EMBEDDING_MODEL", "google/embeddinggemma-2")
DEFAULT_DIM = int(os.environ.get("EMBEDDING_DIM", "256"))
MAX_SEQ = int(os.environ.get("EMBEDDING_MAX_SEQ", "512"))
THREADS = int(os.environ.get("EMBEDDING_THREADS", "2"))
TEXT_ONLY = os.environ.get("EMBEDDING_TEXT_ONLY", "1") == "1"
MAX_BATCH = int(os.environ.get("EMBEDDING_BATCH", "32"))

ALLOWED_DIMS = (128, 256, 512, 768)

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


def load_model() -> SentenceTransformer:
    torch.set_num_threads(THREADS)
    config_kwargs = {"vision_config": None, "audio_config": None} if TEXT_ONLY else {}
    m = SentenceTransformer(
        MODEL_ID,
        model_kwargs={"torch_dtype": torch.float32},
        config_kwargs=config_kwargs,
    )
    m.max_seq_length = MAX_SEQ
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


def resolve_dim(dim: int | None) -> int:
    value = DEFAULT_DIM if dim is None else dim
    if value not in ALLOWED_DIMS:
        raise HTTPException(status_code=422, detail=f"dim must be one of {ALLOWED_DIMS}")
    return value


def encode(texts: list[str], profile: str, dim: int) -> list[list[float]]:
    global encode_count, encode_seconds
    if model is None:
        raise HTTPException(status_code=503, detail="model is not loaded")
    prompt_name = PROFILES[profile]
    started = time.time()
    with encode_lock:
        vectors = model.encode(
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


@app.get("/health")
def health():
    return {
        "status": "ok" if model is not None else "loading",
        "model": MODEL_ID,
        "dim": DEFAULT_DIM,
        "max_seq_length": MAX_SEQ,
        "threads": THREADS,
        "text_only": TEXT_ONLY,
        "profiles": {name: prompt for name, prompt in PROFILES.items()},
        "load_seconds": load_seconds,
        "encoded_texts": encode_count,
        "avg_ms_per_text": round(encode_seconds / encode_count * 1000, 1) if encode_count else None,
    }


@app.get("/profiles")
def profiles():
    return {
        "default_dim": DEFAULT_DIM,
        "allowed_dims": list(ALLOWED_DIMS),
        "profiles": {
            name: {"prompt_name": prompt, "prefix": (model.prompts.get(prompt) if (model and prompt) else "")}
            for name, prompt in PROFILES.items()
        },
    }
