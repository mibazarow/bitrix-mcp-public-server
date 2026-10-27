import { getDocChunks } from "../docs/service.js";
import { getEmbedding } from "./embeddings.js";
import {
  searchDocChunks,
  clearDocChunks,
  loadEmbeddingsCache,
  getDocChunkContents,
  replaceDocChunk,
  deleteDocChunk,
  getMeta,
  setMeta,
  chunkKey,
} from "../liveapi/storage.js";
import { CONFIG } from "../utils/config.js";

export function embeddingsSignature(): string {
  return `${CONFIG.embeddingModel}@${CONFIG.embeddingDim}`;
}

export async function indexAllDocs(
  onProgress?: (current: number, total: number, embedded: number) => void
): Promise<{ total: number; embedded: number; skipped: number; removed: number }> {
  const signature = embeddingsSignature();
  const storedSignature = getMeta("embeddings_signature");
  let removed = 0;

  if (storedSignature !== signature) {
    clearDocChunks();
    setMeta("embeddings_signature", signature);
  }

  const existing = storedSignature === signature ? getDocChunkContents() : new Map();
  const chunks = getDocChunks();
  const seen = new Set<string>();
  let embedded = 0;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const key = chunkKey(chunk.filePath, i);
    seen.add(key);

    const previous = existing.get(key);
    if (previous && previous.content === chunk.content && previous.hasEmbedding) {
      onProgress?.(i + 1, chunks.length, embedded);
      continue;
    }

    const embedding = await getEmbedding(chunk.content, "docs_passage");
    replaceDocChunk(chunk.filePath, i, chunk.content, embedding ? Buffer.from(embedding.buffer) : null);
    embedded++;
    onProgress?.(i + 1, chunks.length, embedded);
  }

  for (const key of existing.keys()) {
    if (seen.has(key)) continue;
    const separator = key.indexOf("\u0000");
    const filePath = key.slice(0, separator);
    const chunkIndex = parseInt(key.slice(separator + 1), 10);
    deleteDocChunk(filePath, chunkIndex);
    removed++;
  }

  loadEmbeddingsCache();
  return { total: chunks.length, embedded, skipped: chunks.length - embedded, removed };
}

export async function searchDocs(query: string, limit: number = 10): Promise<any[]> {
  const embedding = await getEmbedding(query, "docs_query");
  if (!embedding) {
    return [];
  }
  return searchDocChunks(embedding, limit);
}
