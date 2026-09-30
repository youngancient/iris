import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createRetriever, formatForPrompt, type RetrievalLog, type RetrievedChunk } from "../src/agent/retrieval.js";
import { chunkKnowledgeBase, summarize } from "../src/kb/chunk.js";

const kb = readFileSync(new URL("../kb/relaypay-knowledge-base.md", import.meta.url), "utf8");

describe("chunkKnowledgeBase", () => {
  const chunks = chunkKnowledgeBase(kb);

  it("makes one chunk per ### heading plus section intros, and skips the document preamble", () => {
    const titles = chunks.map((c) => c.title);
    expect(titles).toContain("How Does RelayPay Charge Fees?");
    expect(titles).toContain("Policies And Compliance"); // section intro text
    expect(chunks.some((c) => c.content.includes("Week 6 capstone"))).toBe(false);
    expect(chunks.length).toBeGreaterThan(30);
  });

  it("keeps each chunk's content with its own heading", () => {
    const fees = chunks.find((c) => c.title === "How Does RelayPay Charge Fees?")!;
    expect(fees.section).toBe("Frequently Asked Questions");
    expect(fees.content).toMatch(/transaction type, corridor, and payment method/);
    expect(fees.summary).toBe("Fees vary based on transaction type, corridor, and payment method.");
  });

  it("has unique, stable hashes", () => {
    expect(new Set(chunks.map((c) => c.content_hash)).size).toBe(chunks.length);
    expect(chunkKnowledgeBase(kb).map((c) => c.content_hash)).toEqual(chunks.map((c) => c.content_hash));
  });

  it("never produces an empty chunk", () => {
    for (const c of chunks) expect(c.content.trim().length).toBeGreaterThan(0);
  });
});

describe("summarize", () => {
  it("takes the opening sentence when it says enough", () => {
    expect(summarize("Fees vary based on transaction type, corridor, and payment method. More.")).toBe(
      "Fees vary based on transaction type, corridor, and payment method.",
    );
  });
  it("extends a too-short opening", () => {
    expect(summarize("No. RelayPay does not guarantee any payment timelines. Extra.")).toBe("No. RelayPay does not guarantee any payment timelines.");
  });
  it("joins list items", () => {
    expect(summarize("Restrictions apply when:\n- documents are missing\n- activity is unusual")).toBe(
      "Restrictions apply when: documents are missing; activity is unusual.",
    );
  });
});

const chunk = (id: number, score: number): RetrievedChunk => ({ id, section: "FAQ", title: `T${id}`, content: `C${id}`, summary: `S${id}`, score });

function setup(overrides: Partial<Parameters<typeof createRetriever>[0]> = {}) {
  const logs: RetrievalLog[] = [];
  const retrieve = createRetriever({
    embed: async () => [[0.1, 0.2]],
    vectorSearch: async () => [chunk(1, 0.8), chunk(2, 0.6), chunk(3, 0.3)],
    ftsSearch: async () => [chunk(9, 0.1)],
    log: async (row) => void logs.push(row),
    similarityThreshold: 0.5,
    embedTimeoutMs: 1000,
    ...overrides,
  });
  return { retrieve, logs };
}

describe("createRetriever", () => {
  const scope = { conversationId: "c1", turnIndex: 3 };

  it("keeps only chunks above the threshold and logs them", async () => {
    const { retrieve, logs } = setup();
    const result = await retrieve("what fees?", scope);
    expect(result).toMatchObject({ matched: true, method: "vector", topScore: 0.8 });
    expect(result.chunks.map((c) => c.id)).toEqual([1, 2]);
    expect(logs[0]).toMatchObject({
      conversation_id: "c1", turn_index: 3, chunk_ids: [1, 2], source_titles: ["T1", "T2"],
      source_summary: "S1 | S2", matched: true, method: "vector",
    });
  });

  it("a weak best match counts as no match, and is still logged", async () => {
    const { retrieve, logs } = setup({ vectorSearch: async () => [chunk(1, 0.3)] });
    const result = await retrieve("weather?", scope);
    expect(result).toMatchObject({ matched: false, chunks: [], topScore: 0.3 });
    expect(logs[0]).toMatchObject({ matched: false, top_similarity: 0.3 });
    expect(formatForPrompt(result)).toMatch(/No approved knowledge/);
  });

  it("falls back to full-text search when embeddings fail", async () => {
    const { retrieve, logs } = setup({ embed: async () => { throw new Error("voyage down"); } });
    const result = await retrieve("fees", scope);
    expect(result).toMatchObject({ method: "fts_fallback", matched: true });
    expect(logs[0].method).toBe("fts_fallback");
  });

  it("a logging failure doesn't fail retrieval", async () => {
    const { retrieve } = setup({ log: async () => { throw new Error("db down"); } });
    await expect(retrieve("fees", scope)).resolves.toMatchObject({ matched: true });
  });

  it("waits for the turn claim before writing the log row", async () => {
    const order: string[] = [];
    const { retrieve } = setup({ log: async () => void order.push("log") });
    let release!: () => void;
    const ready = new Promise<void>((r) => (release = r)).then(() => void order.push("claimed"));
    const pending = retrieve("fees", { ...scope, ready });
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual([]);
    release();
    await pending;
    expect(order).toEqual(["claimed", "log"]);
  });
});
