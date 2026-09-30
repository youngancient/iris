// Voyage embeddings over plain fetch. 512 dimensions to match kb_chunks.embedding.

export const EMBEDDING_DIMENSIONS = 512;
export type Embedder = (texts: string[], inputType: "document" | "query", timeoutMs?: number) => Promise<number[][]>;

export function createVoyageEmbedder(apiKey: string, model: string): Embedder {
  return async (texts, inputType, timeoutMs = 10_000) => {
    const res = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ input: texts, model, input_type: inputType, output_dimension: EMBEDDING_DIMENSIONS }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      // Body can contain request details but never the key; keep it short.
      throw new Error(`Voyage embeddings failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    const body = (await res.json()) as { data: { index: number; embedding: number[] }[] };
    return body.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  };
}
