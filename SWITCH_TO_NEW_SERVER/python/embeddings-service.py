from fastapi import FastAPI
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer

app = FastAPI()
model = SentenceTransformer('intfloat/multilingual-e5-small')

class EmbeddingRequest(BaseModel):
    text: str

@app.post('/embed')
def embed(request: EmbeddingRequest):
    vec = model.encode(request.text, normalize_embeddings=True)
    return {'embedding': vec.tolist()}

@app.get('/health')
def health():
    return {'status': 'ok'}
