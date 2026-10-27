import { CONFIG } from "../utils/config.js";

export type EmbeddingProfile =
  | "docs_query"
  | "docs_passage"
  | "site_query"
  | "site_passage"
  | "code_query"
  | "generic";

const TIMEOUT_MS = 60000;

async function postEmbed(text: string, profile: EmbeddingProfile): Promise<Float32Array | null> {
  try {
    const response = await fetch(`${CONFIG.embeddingsUrl}/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, profile, dim: CONFIG.embeddingDim }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const data = await response.json() as { embedding: number[] };
    return new Float32Array(data.embedding);
  } catch {
    return null;
  }
}

export async function getEmbedding(
  text: string,
  profile: EmbeddingProfile = "docs_passage"
): Promise<Float32Array | null> {
  return postEmbed(text, profile);
}

export async function getEmbeddings(
  texts: string[],
  profile: EmbeddingProfile = "docs_passage"
): Promise<(Float32Array | null)[]> {
  const result: (Float32Array | null)[] = [];
  for (const text of texts) {
    result.push(await postEmbed(text, profile));
  }
  return result;
}
