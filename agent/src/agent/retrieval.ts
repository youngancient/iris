import type { SupabaseClient } from "@supabase/supabase-js";
import type { Embedder } from "../kb/voyage.js";

// Knowledge-base search (design §2 step 3b, §7.1). Vector search first; if the
// embedding provider is down or slow, Postgres full-text search instead.

export type RetrievedChunk = {
  id: number;
  section: string;
  title: string;
  content: string;
  summary: string | null;
  score: number;
};

export type RetrievalResult = {
  chunks: RetrievedChunk[];
  matched: boolean;
  method: "vector" | "fts_fallback";
  topScore: number | null;
};

export type RetrievalLog = {
  conversation_id: string | null;
  turn_index: number | null;
  query: string;
  chunk_ids: number[];
  source_titles: string[];
  source_summary: string | null;
  top_similarity: number | null;
  matched: boolean;
  method: "vector" | "fts_fallback";
};

export type RetrievalDeps = {
  embed: Embedder;
  vectorSearch: (embedding: number[], count: number) => Promise<RetrievedChunk[]>;
  ftsSearch: (query: string, count: number) => Promise<RetrievedChunk[]>;
  log: (row: RetrievalLog) => Promise<void>;
  /** Minimum cosine similarity for a vector hit to count as a match. Tuned by the evals. */
  similarityThreshold: number;
  embedTimeoutMs: number;
  matchCount?: number;
};

export type RetrievalScope = {
  conversationId: string | null;
  turnIndex: number | null;
  /** The log row references the conversation, so it waits until the turn is claimed. */
  ready?: Promise<unknown>;
};

export function createRetriever(deps: RetrievalDeps) {
  const matchCount = deps.matchCount ?? 4;

  return async function retrieve(query: string, scope: RetrievalScope): Promise<RetrievalResult> {
    let result: RetrievalResult;
    try {
      const [embedding] = await deps.embed([query], "query", deps.embedTimeoutMs);
      const hits = await deps.vectorSearch(embedding, matchCount);
      const topScore = hits[0]?.score ?? null;
      const matched = topScore !== null && topScore >= deps.similarityThreshold;
      result = { chunks: matched ? hits.filter((h) => h.score >= deps.similarityThreshold) : [], matched, method: "vector", topScore };
    } catch (err) {
      console.error(JSON.stringify({ level: "warn", msg: "vector search failed, using full-text fallback", err: String(err) }));
      const hits = await deps.ftsSearch(query, matchCount);
      result = { chunks: hits, matched: hits.length > 0, method: "fts_fallback", topScore: hits[0]?.score ?? null };
    }

    // Logging never blocks or fails the answer.
    await Promise.resolve(scope.ready).catch(() => {});
    await deps
      .log({
        conversation_id: scope.conversationId,
        turn_index: scope.turnIndex,
        query,
        chunk_ids: result.chunks.map((c) => c.id),
        source_titles: result.chunks.map((c) => c.title),
        source_summary: result.chunks.map((c) => c.summary).filter(Boolean).join(" | ") || null,
        top_similarity: result.topScore,
        matched: result.matched,
        method: result.method,
      })
      .catch((err) => console.error(JSON.stringify({ level: "error", msg: "retrieval log failed", err: String(err) })));

    return result;
  };
}

/** Supabase-backed search functions (match_kb_chunks / search_kb_chunks_fts from migration 003). */
export function supabaseSearch(supabase: SupabaseClient) {
  return {
    async vectorSearch(embedding: number[], count: number): Promise<RetrievedChunk[]> {
      const { data, error } = await supabase.rpc("match_kb_chunks", { query_embedding: JSON.stringify(embedding), match_count: count });
      if (error) throw new Error(`match_kb_chunks: ${error.message}`);
      return (data as (Omit<RetrievedChunk, "score"> & { similarity: number })[]).map(({ similarity, ...c }) => ({ ...c, score: similarity }));
    },
    async ftsSearch(query: string, count: number): Promise<RetrievedChunk[]> {
      const { data, error } = await supabase.rpc("search_kb_chunks_fts", { query, match_count: count });
      if (error) throw new Error(`search_kb_chunks_fts: ${error.message}`);
      return (data as (Omit<RetrievedChunk, "score"> & { rank: number })[]).map(({ rank, ...c }) => ({ ...c, score: rank }));
    },
    async log(row: RetrievalLog) {
      const { error } = await supabase.from("retrieval_logs").insert(row);
      if (error) throw new Error(`retrieval_logs: ${error.message}`);
    },
  };
}

/** Format retrieved chunks for the model's context. */
export function formatForPrompt(result: RetrievalResult): string {
  if (!result.matched || result.chunks.length === 0) {
    return "No approved knowledge matches this question. Do not answer it from general knowledge: decline or escalate.";
  }
  return result.chunks.map((c) => `[${c.section} › ${c.title}]\n${c.content}`).join("\n\n");
}
