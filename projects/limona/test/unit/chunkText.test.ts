import { describe, it, expect } from "vitest";
import { chunkText } from "../../src/rag/chunkText.js";

describe("chunkText", () => {
  it("returns no chunks for empty or whitespace-only text", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n\n   ")).toEqual([]);
  });

  it("returns a single chunk for short text", () => {
    const chunks = chunkText("This is a short paragraph.\n\nAnd a second short one.");
    expect(chunks.length).toBe(1);
    expect(chunks[0].chunkIndex).toBe(0);
    expect(chunks[0].content).toContain("short paragraph");
    expect(chunks[0].content).toContain("second short one");
  });

  it("splits long text into multiple chunks with contiguous chunkIndex", () => {
    // Build enough paragraphs to comfortably exceed one ~800-token (~3200 char) chunk.
    const paragraphs = Array.from({ length: 20 }, (_, i) => `Paragraph ${i}: ${"word ".repeat(100)}`);
    const chunks = chunkText(paragraphs.join("\n\n"));

    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((c, i) => expect(c.chunkIndex).toBe(i));
  });

  it("carries overlap text from the end of one chunk into the start of the next", () => {
    const paragraphs = Array.from({ length: 10 }, (_, i) => `Paragraph ${i}: ${"word ".repeat(150)}`);
    const chunks = chunkText(paragraphs.join("\n\n"));
    expect(chunks.length).toBeGreaterThan(1);

    // The last few words of chunk N should reappear near the start of
    // chunk N+1 (the overlap window), proving a reader isn't missing
    // context right at a chunk boundary.
    const lastWordsOfChunk0 = chunks[0].content.trim().split(/\s+/).slice(-5).join(" ");
    expect(chunks[1].content).toContain(lastWordsOfChunk0);
  });

  it("hard-splits a single paragraph that is itself larger than one chunk", () => {
    const hugeParagraph = "word ".repeat(2000); // ~10000 chars, well over one chunk
    const chunks = chunkText(hugeParagraph);
    expect(chunks.length).toBeGreaterThan(1);
  });
});
