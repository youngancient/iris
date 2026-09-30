// Loads agent/kb/relaypay-knowledge-base.md into kb_chunks. Safe to re-run:
// only new or changed chunks are embedded, and chunks no longer in the file are removed.
import { readFileSync } from "node:fs";
import { chunkKnowledgeBase } from "../src/kb/chunk.js";
import { loadOrExit, loadRetrievalConfig } from "../src/config.js";
import { createVoyageEmbedder } from "../src/kb/voyage.js";
import { supabase } from "../src/supabase.js";

const { voyageKey, voyageModel } = loadOrExit(loadRetrievalConfig);

const markdown = readFileSync(new URL("../kb/relaypay-knowledge-base.md", import.meta.url), "utf8");
const chunks = chunkKnowledgeBase(markdown);
const sourceVersion = new Date().toISOString().slice(0, 10);

const { data: existing, error: readError } = await supabase.from("kb_chunks").select("id, content_hash");
if (readError) throw new Error(`reading kb_chunks: ${readError.message}`);

const existingHashes = new Set(existing.map((r) => r.content_hash));
const wantedHashes = new Set(chunks.map((c) => c.content_hash));
const toAdd = chunks.filter((c) => !existingHashes.has(c.content_hash));
const staleIds = existing.filter((r) => !wantedHashes.has(r.content_hash)).map((r) => r.id);

if (toAdd.length > 0) {
  const embed = createVoyageEmbedder(voyageKey, voyageModel);
  // Embed title + content so a question phrased like the heading still matches.
  const embeddings = await embed(toAdd.map((c) => `${c.title}\n${c.content}`), "document", 30_000);
  const rows = toAdd.map((c, i) => ({ ...c, source_version: sourceVersion, embedding: JSON.stringify(embeddings[i]) }));
  const { error } = await supabase.from("kb_chunks").upsert(rows, { onConflict: "content_hash", ignoreDuplicates: true });
  if (error) throw new Error(`inserting kb_chunks: ${error.message}`);
}

// New rows go in before stale ones come out, so search never sees an empty knowledge base.
if (staleIds.length > 0) {
  const { error } = await supabase.from("kb_chunks").delete().in("id", staleIds);
  if (error) throw new Error(`deleting stale kb_chunks: ${error.message}`);
}

console.log(
  `kb_chunks: ${chunks.length} in file, ${toAdd.length} embedded, ${staleIds.length} removed, ` +
    `${chunks.length - toAdd.length} unchanged`,
);
