import { getDocChunks } from "../docs/service.js";
import { getEmbedding } from "./embeddings.js";
import { insertDocChunk, searchDocChunks, clearDocChunks } from "../liveapi/storage.js";
export async function indexAllDocs(onProgress) {
    const chunks = getDocChunks();
    clearDocChunks();
    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const embedding = await getEmbedding(chunk.content);
        const embBuffer = embedding ? Buffer.from(embedding.buffer) : null;
        insertDocChunk(chunk.filePath, i, chunk.content, embBuffer);
        onProgress?.(i + 1, chunks.length);
    }
}
export async function searchDocs(query, limit = 10) {
    const embedding = await getEmbedding(query);
    if (!embedding) {
        return [];
    }
    return searchDocChunks(embedding, limit);
}
//# sourceMappingURL=service.js.map