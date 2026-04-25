import { CONFIG } from "../utils/config.js";

export async function getEmbedding(text: string): Promise<Float32Array | null> {
  try {
    const response = await fetch(`${CONFIG.embeddingsUrl}/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return null;
    const data = await response.json() as { embedding: number[] };
    return new Float32Array(data.embedding);
  } catch {
    return null;
  }
}

export async function getEmbeddings(texts: string[]): Promise<Float32Array[]> {
  const embeddings: Float32Array[] = [];
  for (const text of texts) {
    const emb = await getEmbedding(text);
    if (emb) embeddings.push(emb);
  }
  return embeddings;
}
