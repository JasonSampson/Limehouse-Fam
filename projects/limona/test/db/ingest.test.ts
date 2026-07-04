import path from "node:path";
import fs from "node:fs/promises";
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { getTestPool, truncateAllTables, closeTestPool } from "../support/testDb.js";
import { installFakeAiProviders, hashToUnitVector } from "../support/fakeAiProviders.js";

installFakeAiProviders();

// The real embeddings module loads a local transformer model — slow and not
// what these tests are verifying (they verify SQL/transaction/storage
// logic). Stub it out with the same deterministic hash-based fake vectors
// used for Anthropic, at the new local model's 384-dimension output.
vi.mock("../../src/rag/embeddings.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/rag/embeddings.js")>();
  return {
    ...original,
    embedChunks: async (texts: string[]) => texts.map((t) => hashToUnitVector(t, 384)),
    embedQuery: async (text: string) => hashToUnitVector(text, 384),
  };
});

// Import AFTER stubbing fetch and setting env, so every module that reads
// loadEnv()/getPool() picks up the test configuration.
const { ingestDocument, absoluteOriginalPath } = await import("../../src/rag/ingest.js");
const { loadEnv } = await import("../../src/config/env.js");

function makeDocxBuffer(text: string): Buffer {
  // We don't need a real .docx binary for these tests — extractText.ts is
  // exercised directly in test/unit; here we care about ingest's DB/storage
  // orchestration. Stub extractText via vi.mock at the top of a test file
  // that needs it; this file instead uses tiny real .docx-shaped content
  // isn't necessary because we mock extractText below instead.
  return Buffer.from(text, "utf8");
}

vi.mock("../../src/rag/extractText.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/rag/extractText.js")>();
  return {
    ...original,
    // Real mammoth/pdf-parse need real file formats; ingest.test.ts is
    // testing the surrounding orchestration (storage write, DB rows,
    // supersede transaction), not text extraction itself (covered by
    // test/unit/chunkText.test.ts and manual testing with real files).
    // So we bypass real parsing and just decode the buffer as plain text.
    extractText: async (buffer: Buffer) => buffer.toString("utf8"),
  };
});

describe("ingestDocument", () => {
  const pool = getTestPool();

  beforeEach(async () => {
    await truncateAllTables();
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it("produces a ready document with chunks written to document_chunks", async () => {
    const text = Array.from({ length: 5 }, (_, i) => `Paragraph ${i}. ${"content ".repeat(50)}`).join("\n\n");

    const result = await ingestDocument({
      originalFilename: "test-policy.docx",
      categoryId: 6, // SOP
      uploadedBy: null,
      fileBuffer: makeDocxBuffer(text),
    });

    expect(result.status).toBe("ready");
    expect(result.chunkCount).toBeGreaterThan(0);

    const docRow = await pool.query("SELECT status, filename, category_id FROM documents WHERE id = $1", [
      result.documentId,
    ]);
    expect(docRow.rows[0].status).toBe("ready");
    expect(docRow.rows[0].filename).toBe("test-policy.docx");
    expect(docRow.rows[0].category_id).toBe(6);

    const chunkRows = await pool.query("SELECT count(*)::int AS n FROM document_chunks WHERE document_id = $1", [
      result.documentId,
    ]);
    expect(chunkRows.rows[0].n).toBe(result.chunkCount);
  });

  it("marks the document failed (not crashing) when there is no extractable text", async () => {
    const result = await ingestDocument({
      originalFilename: "empty.docx",
      categoryId: 1,
      uploadedBy: null,
      fileBuffer: makeDocxBuffer("   "),
    });

    expect(result.status).toBe("failed");
    const docRow = await pool.query("SELECT status FROM documents WHERE id = $1", [result.documentId]);
    expect(docRow.rows[0].status).toBe("failed");
  });

  it("re-upload supersedes the old version and old chunks stop being retrievable", async () => {
    const originalText = Array.from({ length: 5 }, (_, i) => `Original v1 paragraph ${i}. ${"alpha ".repeat(50)}`).join(
      "\n\n"
    );
    const first = await ingestDocument({
      originalFilename: "sop-late-rent.docx",
      categoryId: 6,
      uploadedBy: null,
      fileBuffer: makeDocxBuffer(originalText),
    });
    expect(first.status).toBe("ready");

    const updatedText = Array.from({ length: 5 }, (_, i) => `Updated v2 paragraph ${i}. ${"bravo ".repeat(50)}`).join(
      "\n\n"
    );
    const second = await ingestDocument({
      originalFilename: "sop-late-rent.docx",
      categoryId: 6,
      uploadedBy: null,
      fileBuffer: makeDocxBuffer(updatedText),
      replacesDocumentId: first.documentId,
    });
    expect(second.status).toBe("ready");

    const oldDoc = await pool.query("SELECT status, version FROM documents WHERE id = $1", [first.documentId]);
    expect(oldDoc.rows[0].status).toBe("superseded");

    const newDoc = await pool.query("SELECT status, version, replaces_document_id FROM documents WHERE id = $1", [
      second.documentId,
    ]);
    expect(newDoc.rows[0].status).toBe("ready");
    expect(newDoc.rows[0].version).toBe(2);
    expect(newDoc.rows[0].replaces_document_id).toBe(first.documentId);

    // The retrieval path (used by both admin listing and chat) filters
    // WHERE status = 'ready' — confirm the old document's rows are excluded
    // by that same filter, i.e. stale content can never surface.
    const readyDocs = await pool.query(
      "SELECT id FROM documents WHERE filename = 'sop-late-rent.docx' AND status = 'ready'"
    );
    expect(readyDocs.rows.map((r) => r.id)).toEqual([second.documentId]);

    const retrievableChunks = await pool.query(
      `SELECT dc.id FROM document_chunks dc
       JOIN documents d ON d.id = dc.document_id
       WHERE d.status = 'ready' AND d.filename = 'sop-late-rent.docx'`
    );
    const oldChunkIds = await pool.query("SELECT id FROM document_chunks WHERE document_id = $1", [
      first.documentId,
    ]);
    const retrievableIds = new Set(retrievableChunks.rows.map((r) => r.id));
    for (const row of oldChunkIds.rows) {
      expect(retrievableIds.has(row.id)).toBe(false);
    }
  });

  // Regression test for a path-traversal bug: req.file.originalname comes
  // straight from the client (multer does not sanitize it), and was used
  // unsanitized to build the on-disk path for the uploaded file. A crafted
  // filename like "../../../evil.docx" could make path.join walk back out
  // of storage/documents/<uuid>/original/ and write anywhere the process
  // has permission to write. Covers both "/" and "\" style traversal since
  // the two path separator conventions are handled differently by Node's
  // path module depending on platform.
  it.each([
    ["forward-slash traversal", "../../evil.docx"],
    ["backslash traversal", "..\\..\\evil.docx"],
    ["deep forward-slash traversal", "../../../../../etc/passwd.docx"],
  ])("sanitizes %s in the uploaded filename so the file stays inside its documents/<id>/original folder", async (_label, maliciousName) => {
    const result = await ingestDocument({
      originalFilename: maliciousName,
      categoryId: 1,
      uploadedBy: null,
      fileBuffer: makeDocxBuffer("some content that is long enough to extract as a real chunk of text here"),
    });

    expect(result.status).toBe("ready");

    const docRow = await pool.query("SELECT storage_path FROM documents WHERE id = $1", [result.documentId]);
    const storagePath: string = docRow.rows[0].storage_path;

    // The stored relative path must stay inside documents/<documentId>/original/
    // and must not contain any leftover ".." segments that escaped it.
    const expectedDir = path.join("documents", result.documentId, "original");
    expect(storagePath.startsWith(expectedDir)).toBe(true);
    expect(storagePath).not.toMatch(/\.\./);

    // The file actually written to disk must resolve to inside the storage
    // root, not somewhere above/outside it.
    const absPath = absoluteOriginalPath(storagePath);
    const storageRoot = path.resolve(loadEnv().STORAGE_DIR);
    const relativeFromRoot = path.relative(storageRoot, absPath);
    expect(relativeFromRoot.startsWith("..")).toBe(false);
    expect(path.isAbsolute(relativeFromRoot)).toBe(false);

    const stat = await fs.stat(absPath);
    expect(stat.isFile()).toBe(true);
  });
});
