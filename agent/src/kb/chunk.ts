import { createHash } from "node:crypto";

export type KbChunk = {
  section: string;
  title: string;
  content: string;
  summary: string;
  content_hash: string;
};

const SUMMARY_MAX = 200;

const SUMMARY_MIN_WORDS = 8;

/**
 * One-line "source summary" for retrieval logs (PRD): the opening sentence(s),
 * extended until it says something (so "No." becomes "No. RelayPay does not…").
 * List items are joined with "; ". Deterministic and free: re-ingesting never
 * costs an LLM call.
 */
export function summarize(content: string): string {
  const text = content
    .split("\n")
    .map((l) => l.trim().replace(/^[-*]\s+/, ""))
    .filter(Boolean)
    .map((l) => (/[.!?:]$/.test(l) ? l : `${l};`))
    .join(" ")
    .replace(/:\s/g, ": ");
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [text];
  let summary = "";
  for (const sentence of sentences) {
    summary = `${summary} ${sentence.trim()}`.trim();
    if (summary.split(/\s+/).length >= SUMMARY_MIN_WORDS) break;
  }
  summary = summary.replace(/;$/, ".");
  return summary.length > SUMMARY_MAX ? `${summary.slice(0, SUMMARY_MAX - 1).trimEnd()}…` : summary;
}

export const hashChunk = (section: string, title: string, content: string) =>
  createHash("sha256").update(`${section}\n${title}\n${content}`).digest("hex");

/**
 * Split the knowledge base into one chunk per "###" heading. Text between a
 * "##" heading and its first "###" becomes its own chunk titled with the
 * section name. The "#" document preamble (notes about the source) is skipped.
 */
export function chunkKnowledgeBase(markdown: string): KbChunk[] {
  const chunks: KbChunk[] = [];
  let section: string | null = null;
  let title: string | null = null;
  let lines: string[] = [];

  const flush = () => {
    const content = lines.join("\n").trim();
    if (section && title && content) {
      chunks.push({ section, title, content, summary: summarize(content), content_hash: hashChunk(section, title, content) });
    }
    lines = [];
  };

  for (const line of markdown.split("\n")) {
    const h2 = /^##\s+(.+)$/.exec(line);
    const h3 = /^###\s+(.+)$/.exec(line);
    if (h3) {
      flush();
      title = h3[1].trim();
    } else if (h2) {
      flush();
      section = h2[1].trim();
      title = section;
    } else if (/^#\s/.test(line)) {
      flush();
      section = null;
      title = null;
    } else {
      lines.push(line);
    }
  }
  flush();
  return chunks;
}
