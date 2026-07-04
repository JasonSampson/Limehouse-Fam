import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { getTestPool, truncateAllTables, closeTestPool } from "../support/testDb.js";
import { installFakeAiProviders, hashToUnitVector } from "../support/fakeAiProviders.js";
import { toVectorLiteral } from "../../src/rag/embeddings.js";

installFakeAiProviders();

// The real embeddings module loads a local transformer model — slow and not
// what these tests are verifying. Stub it out with the same deterministic
// hash-based fake vectors used for Anthropic, at the local model's
// 384-dimension output, so distance-based retrieval logic is still exercised
// without needing a real embedding model to judge semantic similarity.
// embedQuery is wrapped in vi.fn() (rather than a plain async function) so
// individual tests can override it with mockResolvedValueOnce() when they
// need a hand-constructed query vector instead of the hash — see the
// threshold-before-limit regression test below.
vi.mock("../../src/rag/embeddings.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/rag/embeddings.js")>();
  return {
    ...original,
    embedChunks: async (texts: string[]) => texts.map((t) => hashToUnitVector(t, 384)),
    embedQuery: vi.fn(async (text: string) => hashToUnitVector(text, 384)),
  };
});

vi.mock("../../src/rag/extractText.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/rag/extractText.js")>();
  return { ...original, extractText: async (buffer: Buffer) => buffer.toString("utf8") };
});

const { ingestDocument } = await import("../../src/rag/ingest.js");
const { retrieveRelevantChunks } = await import("../../src/rag/retrieve.js");

describe("retrieveRelevantChunks", () => {
  const pool = getTestPool();

  beforeAll(async () => {
    await truncateAllTables();
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it("returns answered: false with no chunks when nothing has been uploaded at all", async () => {
    const result = await retrieveRelevantChunks("What is the late rent notice process?");
    expect(result.answered).toBe(false);
    expect(result.chunks).toEqual([]);
  });

  it("returns answered: true with matching chunks once a relevant document is ingested", async () => {
    // Short text (one paragraph) so chunkText produces exactly one chunk
    // whose content we know exactly — the fake embedding hash (see
    // test/support/fakeAiProviders.ts) is deterministic per exact input
    // string, so asking the EXACT chunk text back gives distance 0 (a
    // perfect match) without needing a real embedding model to judge
    // semantic similarity.
    const chunkContent = "Late rent notice paragraph: after 14 days, a notice is generated automatically.";
    const result = await ingestDocument({
      originalFilename: "late-rent-sop.docx",
      categoryId: 6,
      uploadedBy: null,
      fileBuffer: Buffer.from(chunkContent, "utf8"),
    });
    expect(result.status).toBe("ready");
    expect(result.chunkCount).toBe(1);

    const retrieval = await retrieveRelevantChunks(chunkContent);
    expect(retrieval.answered).toBe(true);
    expect(retrieval.chunks.length).toBeGreaterThan(0);
    expect(retrieval.chunks[0].documentFilename).toBe("late-rent-sop.docx");
  });

  it("only considers status='ready' documents — a 'failed' document's chunks (if any existed) never surface", async () => {
    await truncateAllTables();
    // A document with no extractable text ends up 'failed' with zero chunks
    // — confirm retrieval sees nothing from it and reports don't-know.
    const failed = await ingestDocument({
      originalFilename: "blank.docx",
      categoryId: 1,
      uploadedBy: null,
      fileBuffer: Buffer.from("   ", "utf8"),
    });
    expect(failed.status).toBe("failed");

    const retrieval = await retrieveRelevantChunks("Anything at all");
    expect(retrieval.answered).toBe(false);
  });

  it("surfaces an in-threshold chunk even when 10+ other chunks rank closer on raw distance (regression: threshold-before-limit)", async () => {
    // Reproduces the exact bug TARS found in production: the real SOP chunk
    // for "14-day late rent notice" scored distance 0.4959 (under the 0.5
    // cutoff) but ranked 11th, so the OLD query — `ORDER BY ... LIMIT 5`,
    // filtered by MAX_DISTANCE only *after* fetching — never gave it a
    // chance, since it was never in the 5 rows Postgres returned in the
    // first place. The fix moves the threshold filter into the WHERE clause
    // (so it runs across the whole candidate pool before any row-count cap)
    // and raises the final cap (TOP_K) from 5 to 20, so a relevant chunk
    // ranked well outside a naive top-5 window still survives.
    //
    // hashToUnitVector's outputs are effectively random unit vectors, which
    // are near-orthogonal in 384 dimensions (cosine distance clusters
    // tightly around 1.0) — there's no way to pick real text whose hash
    // lands at a specific distance like 0.49. So this test bypasses the
    // embedding model/hash entirely and inserts document_chunks rows
    // directly with hand-constructed unit vectors at exact, known distances
    // from the query vector: one relevant chunk at distance 0.49 (inside the
    // 0.5 cutoff, but ranked 13th out of 14 total candidates — well outside
    // the old TOP_K=5 window) plus 12 filler chunks all closer to the query
    // (distances 0.10-0.32) standing in for "unrelated chunks that merely
    // happen to score closer on raw vector distance."
    await truncateAllTables();

    const pool = getTestPool();

    // Unit vector query = [1, 0, 0, ...]. A vector at cosine distance d from
    // it is [cos(theta), sin(theta), 0, ...] where cos(theta) = 1 - d — see
    // pgvector's <=> operator, which is 1 - cosine_similarity for normalized
    // vectors.
    const dim = 384;
    function vectorAtDistance(distance: number): number[] {
      const cosTheta = 1 - distance;
      const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
      const v = new Array(dim).fill(0);
      v[0] = cosTheta;
      v[1] = sinTheta;
      return v;
    }
    const queryVector = new Array(dim).fill(0);
    queryVector[0] = 1;

    const categoryResult = await pool.query<{ id: number }>(
      "SELECT id FROM document_categories ORDER BY id LIMIT 1"
    );
    const categoryId = categoryResult.rows[0].id;

    async function insertChunk(filename: string, content: string, distance: number): Promise<void> {
      const docResult = await pool.query<{ id: string }>(
        `INSERT INTO documents (filename, category_id, file_size_bytes, file_ext, storage_path, status)
         VALUES ($1, $2, 0, 'docx', 'documents/test/original/test.docx', 'ready')
         RETURNING id`,
        [filename, categoryId]
      );
      const documentId = docResult.rows[0].id;
      await pool.query(
        `INSERT INTO document_chunks (document_id, chunk_index, content, embedding)
         VALUES ($1, 0, $2, $3::vector)`,
        [documentId, content, toVectorLiteral(vectorAtDistance(distance))]
      );
    }

    // 12 fillers all closer to the query than the relevant chunk (distances
    // 0.10-0.32) — none semantically relevant, but under the old bug's
    // ORDER BY + LIMIT they'd fill the entire TOP_K=5 window before the
    // threshold check ever ran.
    for (let i = 0; i < 12; i++) {
      await insertChunk(`unrelated-${i}.docx`, `Unrelated filler content number ${i} about parking permits.`, 0.1 + i * 0.02);
    }

    // The relevant chunk: distance 0.49, comfortably under MAX_DISTANCE
    // (0.5), but ranked 13th of 14 total candidates by raw distance.
    await insertChunk(
      "Limehouse SOP Late Rent 14 day notice V2 10 June 2026.docx",
      "14-day late rent notice process: on day 5 past due, generate and send the statutory 14-day pay-or-quit notice to the tenant per Virginia code.",
      0.49
    );

    // One more filler further away than the relevant chunk but still
    // in-range-adjacent, just to confirm ordering isn't accidentally
    // reversed.
    await insertChunk("unrelated-far.docx", "Unrelated filler far away.", 0.6);

    const { embedQuery } = await import("../../src/rag/embeddings.js");
    vi.mocked(embedQuery).mockResolvedValueOnce(queryVector);

    const retrieval = await retrieveRelevantChunks("What's the process for a 14-day late rent notice?");
    expect(retrieval.answered).toBe(true);
    const filenames = retrieval.chunks.map((c) => c.documentFilename);
    expect(filenames).toContain("Limehouse SOP Late Rent 14 day notice V2 10 June 2026.docx");
    // The far-away filler (distance 0.6) must never appear — confirms the
    // fix filters by threshold, it doesn't just widen the limit indefinitely.
    expect(filenames).not.toContain("unrelated-far.docx");
  });
});
