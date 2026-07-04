export interface Chunk {
  chunkIndex: number;
  content: string;
}

// Rough token estimate: ~4 characters per token for English prose. Good
// enough for chunk sizing — we don't need exact tokenization here, just
// consistent, reasonably-sized chunks (per the approved spec: "simple
// fixed-size chunking is fine — don't over-engineer this").
const CHARS_PER_TOKEN = 4;
const TARGET_TOKENS = 800;
const OVERLAP_TOKENS = 100;
const TARGET_CHARS = TARGET_TOKENS * CHARS_PER_TOKEN;
const OVERLAP_CHARS = OVERLAP_TOKENS * CHARS_PER_TOKEN;

// Splits text into ~800-token chunks with ~100-token overlap, preferring to
// break on paragraph boundaries so a chunk doesn't get cut mid-sentence when
// avoidable. Falls back to a hard character cut only when a single
// paragraph is itself larger than the target chunk size.
export function chunkText(text: string): Chunk[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];

  const paragraphs = normalized.split(/\n\s*\n/).filter((p) => p.trim().length > 0);

  const chunks: Chunk[] = [];
  let current = "";

  const pushCurrent = () => {
    const trimmed = current.trim();
    if (trimmed.length > 0) {
      chunks.push({ chunkIndex: chunks.length, content: trimmed });
    }
    current = "";
  };

  for (const paragraph of paragraphs) {
    // A single paragraph bigger than the whole target chunk: flush what we
    // have, then hard-split the oversized paragraph on its own.
    if (paragraph.length > TARGET_CHARS) {
      pushCurrent();
      let start = 0;
      while (start < paragraph.length) {
        const end = Math.min(start + TARGET_CHARS, paragraph.length);
        chunks.push({ chunkIndex: chunks.length, content: paragraph.slice(start, end).trim() });
        start += TARGET_CHARS - OVERLAP_CHARS;
      }
      continue;
    }

    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length > TARGET_CHARS && current.length > 0) {
      // Carry the tail of the outgoing chunk forward so the next chunk
      // opens with ~100 tokens of overlap context, then flush.
      const overlapTail = current.slice(Math.max(0, current.length - OVERLAP_CHARS));
      pushCurrent();
      current = `${overlapTail}\n\n${paragraph}`;
    } else {
      current = candidate;
    }
  }
  pushCurrent();

  return chunks;
}
