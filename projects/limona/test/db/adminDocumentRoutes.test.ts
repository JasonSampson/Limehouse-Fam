import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { getTestPool, truncateAllTables, closeTestPool } from "../support/testDb.js";
import { loginAsLimeHqUser } from "../support/testAuth.js";
import { installFakeAiProviders } from "../support/fakeAiProviders.js";

process.env.SESSION_COOKIE_SECRET ||= "test-secret-at-least-32-characters-long";

installFakeAiProviders();

// Real embeddings load a local transformer model — slow, and not what these
// tests verify (they verify route validation, storage, and preview
// rendering). Stubbed out the same way test/db/ingest.test.ts does it.
// extractText is deliberately left REAL (not mocked) here, unlike
// ingest.test.ts — these tests exercise the actual upload endpoint end-to-end
// for the newly-supported file types (xlsx/csv/txt/md), so real extraction
// running against real bytes is exactly what's being verified.
vi.mock("../../src/rag/embeddings.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/rag/embeddings.js")>();
  return {
    ...original,
    embedChunks: async (texts: string[]) => texts.map(() => new Array(384).fill(0.01)),
    embedQuery: async () => new Array(384).fill(0.01),
  };
});

const { buildTestApp } = await import("../support/testApp.js");
const { absoluteOriginalPath } = await import("../../src/rag/ingest.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(__dirname, "../fixtures");

function loginAsAdmin(app: ReturnType<typeof buildTestApp>) {
  return loginAsLimeHqUser(app, { id: 1, email: "admin@limehousepm.com", displayName: "Admin Person" });
}

function buildXlsxBuffer(): Buffer {
  const ws = XLSX.utils.aoa_to_sheet([
    ["Name", "Age"],
    ["Alice", "30"],
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

// Directly writes a "ready" document to disk + DB, bypassing the
// upload/ingest pipeline (no chunking/embedding needed to test preview
// rendering) — same approach test/db/retrieve.test.ts uses for its
// hand-constructed fixture rows.
async function seedReadyDocument(
  pool: ReturnType<typeof getTestPool>,
  { filename, ext, buffer, category = "SOP" }: { filename: string; ext: string; buffer: Buffer; category?: string }
): Promise<string> {
  const id = crypto.randomUUID();
  const relPath = path.join("documents", id, "original", filename);
  const absPath = absoluteOriginalPath(relPath);
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, buffer);
  await pool.query(
    `INSERT INTO documents (id, filename, category, file_size_bytes, file_ext, storage_path, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'ready')`,
    [id, filename, category, buffer.length, ext, relPath]
  );
  return id;
}

describe("admin document routes", () => {
  const pool = getTestPool();
  const app = buildTestApp();

  beforeEach(async () => {
    await truncateAllTables();
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it("blocks an unauthenticated request", async () => {
    const res = await request(app).get("/api/admin/documents");
    expect(res.status).toBe(401);
  });

  // CHANGED [today], per Jason directly: Document Library browsing is open
  // to any Limona user, not just limona.documents.manage holders — this was
  // the real bug (Lea, a plain-staff test run, couldn't see it at all).
  // Uploading/editing/removing stays manage-only.
  it("lets a plain staff account (chat access only) browse and download, but not upload/edit/remove", async () => {
    const admin = await loginAsAdmin(app);
    const uploadRes = await admin
      .post("/api/admin/documents/upload")
      .field("category", "SOP")
      .field("description", "Late rent notice procedure")
      .attach("file", Buffer.from("Policy text, long enough to chunk.", "utf-8"), "policy.txt");
    expect(uploadRes.status).toBe(200);
    const docId = uploadRes.body.documentId;

    const staff = await loginAsLimeHqUser(app, {
      id: 2,
      email: "staff@limehousepm.com",
      displayName: "Staff Person",
      permissions: ["limona.chat.access"],
    });

    const listRes = await staff.get("/api/admin/documents");
    expect(listRes.status).toBe(200);
    expect(listRes.body.documents).toHaveLength(1);

    const downloadRes = await staff.get(`/api/admin/documents/${docId}/download`);
    expect(downloadRes.status).toBe(200);

    const uploadAttempt = await staff
      .post("/api/admin/documents/upload")
      .field("category", "SOP")
      .field("description", "Should be rejected")
      .attach("file", Buffer.from("irrelevant", "utf-8"), "nope.txt");
    expect(uploadAttempt.status).toBe(403);

    const categoryAttempt = await staff.patch(`/api/admin/documents/${docId}/category`).send({ category: "Other" });
    expect(categoryAttempt.status).toBe(403);

    const deleteAttempt = await staff.delete(`/api/admin/documents/${docId}`);
    expect(deleteAttempt.status).toBe(403);
  });

  it("uploads a document with category/description/documentCreatedAt and lists it back as text fields", async () => {
    const agent = await loginAsAdmin(app);

    const uploadRes = await agent
      .post("/api/admin/documents/upload")
      .field("category", "SOP")
      .field("description", "Late rent notice procedure")
      .field("documentCreatedAt", "2026-01-15")
      .attach("file", Buffer.from("Some late rent notice policy text, long enough to chunk.", "utf-8"), "policy.txt");
    expect(uploadRes.status).toBe(200);
    expect(uploadRes.body.status).toBe("ready");

    const listRes = await agent.get("/api/admin/documents");
    expect(listRes.status).toBe(200);
    expect(listRes.body.documents).toHaveLength(1);
    const doc = listRes.body.documents[0];
    expect(doc.category).toBe("SOP");
    expect(doc.description).toBe("Late rent notice procedure");
    expect(doc.document_created_at).toMatch(/^2026-01-15/);
    expect(typeof doc.category).toBe("string");
  });

  it.each(["xlsx", "csv", "md"])("accepts a .%s upload", async (ext) => {
    const agent = await loginAsAdmin(app);
    const buffer =
      ext === "xlsx" ? buildXlsxBuffer() : Buffer.from(`some ${ext} content that is long enough to extract a real chunk of text from`, "utf-8");

    const res = await agent
      .post("/api/admin/documents/upload")
      .field("category", "SOP")
      .field("description", "Test upload")
      .attach("file", buffer, `sample.${ext}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ready");
  });

  it("rejects an unsupported file extension", async () => {
    const agent = await loginAsAdmin(app);
    const res = await agent
      .post("/api/admin/documents/upload")
      .field("category", "SOP")
      .field("description", "Test upload")
      .attach("file", Buffer.from("bytes"), "virus.exe");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/pdf|docx|xlsx|csv|txt|md/i);
  });

  it("rejects an upload missing a description", async () => {
    const agent = await loginAsAdmin(app);
    const res = await agent
      .post("/api/admin/documents/upload")
      .field("category", "SOP")
      .attach("file", Buffer.from("some content"), "note.txt");
    expect(res.status).toBe(400);
  });

  it("rejects an upload with an empty-string description (exercises the custom validation message)", async () => {
    const agent = await loginAsAdmin(app);
    const res = await agent
      .post("/api/admin/documents/upload")
      .field("category", "SOP")
      .field("description", "")
      .attach("file", Buffer.from("some content"), "note.txt");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/description/i);
  });

  it("rejects an upload missing a category", async () => {
    const agent = await loginAsAdmin(app);
    const res = await agent
      .post("/api/admin/documents/upload")
      .field("description", "A description")
      .attach("file", Buffer.from("some content"), "note.txt");
    expect(res.status).toBe(400);
  });

  it("rejects an upload with a malformed documentCreatedAt", async () => {
    const agent = await loginAsAdmin(app);
    const res = await agent
      .post("/api/admin/documents/upload")
      .field("category", "SOP")
      .field("description", "A description")
      .field("documentCreatedAt", "not-a-date")
      .attach("file", Buffer.from("some content"), "note.txt");
    expect(res.status).toBe(400);
  });

  it("GET /api/admin/categories returns distinct category strings actually in use, not a fixed list", async () => {
    const agent = await loginAsAdmin(app);
    await pool.query(
      `INSERT INTO documents (filename, category, description, file_size_bytes, file_ext, storage_path, status)
       VALUES ('a.txt', 'SOP', 'd', 10, 'txt', 'documents/a/original/a.txt', 'ready'),
              ('b.txt', 'Vendors', 'd', 10, 'txt', 'documents/b/original/b.txt', 'ready'),
              ('c.txt', 'SOP', 'd', 10, 'txt', 'documents/c/original/c.txt', 'ready')`
    );
    const res = await agent.get("/api/admin/categories");
    expect(res.status).toBe(200);
    expect(res.body.categories).toEqual(["SOP", "Vendors"]);
  });

  it("PATCH /:id/category updates the category text", async () => {
    const agent = await loginAsAdmin(app);
    const id = await seedReadyDocument(pool, { filename: "a.txt", ext: "txt", buffer: Buffer.from("hi") });

    const res = await agent.patch(`/api/admin/documents/${id}/category`).send({ category: "Vendors" });
    expect(res.status).toBe(200);

    const row = await pool.query("SELECT category FROM documents WHERE id = $1", [id]);
    expect(row.rows[0].category).toBe("Vendors");
  });

  it("PATCH /:id/category 404s for an unknown document", async () => {
    const agent = await loginAsAdmin(app);
    const res = await agent
      .patch("/api/admin/documents/00000000-0000-0000-0000-000000000000/category")
      .send({ category: "Vendors" });
    expect(res.status).toBe(404);
  });

  it("PATCH /:id/document-created-at sets and clears the date", async () => {
    const agent = await loginAsAdmin(app);
    const id = await seedReadyDocument(pool, { filename: "a.txt", ext: "txt", buffer: Buffer.from("hi") });

    const setRes = await agent
      .patch(`/api/admin/documents/${id}/document-created-at`)
      .send({ documentCreatedAt: "2025-06-01" });
    expect(setRes.status).toBe(200);
    let row = await pool.query("SELECT document_created_at FROM documents WHERE id = $1", [id]);
    expect(row.rows[0].document_created_at.toISOString().slice(0, 10)).toBe("2025-06-01");

    const clearRes = await agent
      .patch(`/api/admin/documents/${id}/document-created-at`)
      .send({ documentCreatedAt: null });
    expect(clearRes.status).toBe(200);
    row = await pool.query("SELECT document_created_at FROM documents WHERE id = $1", [id]);
    expect(row.rows[0].document_created_at).toBeNull();
  });

  it("PATCH /:id/document-created-at rejects a malformed date", async () => {
    const agent = await loginAsAdmin(app);
    const id = await seedReadyDocument(pool, { filename: "a.txt", ext: "txt", buffer: Buffer.from("hi") });
    const res = await agent
      .patch(`/api/admin/documents/${id}/document-created-at`)
      .send({ documentCreatedAt: "06/01/2025" });
    expect(res.status).toBe(400);
  });

  it("PATCH /:id/description updates the description text", async () => {
    const agent = await loginAsAdmin(app);
    const id = await seedReadyDocument(pool, { filename: "a.txt", ext: "txt", buffer: Buffer.from("hi") });

    const res = await agent.patch(`/api/admin/documents/${id}/description`).send({ description: "Updated description" });
    expect(res.status).toBe(200);

    const row = await pool.query("SELECT description FROM documents WHERE id = $1", [id]);
    expect(row.rows[0].description).toBe("Updated description");
  });

  it("PATCH /:id/description clears the description back to an empty string", async () => {
    const agent = await loginAsAdmin(app);
    const id = await seedReadyDocument(pool, { filename: "a.txt", ext: "txt", buffer: Buffer.from("hi") });
    await pool.query("UPDATE documents SET description = $1 WHERE id = $2", ["Original description", id]);

    const res = await agent.patch(`/api/admin/documents/${id}/description`).send({ description: "" });
    expect(res.status).toBe(200);

    const row = await pool.query("SELECT description FROM documents WHERE id = $1", [id]);
    expect(row.rows[0].description).toBe("");
  });

  it("PATCH /:id/description 404s for an unknown document", async () => {
    const agent = await loginAsAdmin(app);
    const res = await agent
      .patch("/api/admin/documents/00000000-0000-0000-0000-000000000000/description")
      .send({ description: "Anything" });
    expect(res.status).toBe(404);
  });

  it("PATCH /:id/description blocks an unauthenticated request", async () => {
    const id = await seedReadyDocument(pool, { filename: "a.txt", ext: "txt", buffer: Buffer.from("hi") });
    const res = await request(app).patch(`/api/admin/documents/${id}/description`).send({ description: "Nope" });
    expect(res.status).toBe(401);
  });

  describe("GET /:id/preview", () => {
    it("404s for an unknown document", async () => {
      const agent = await loginAsAdmin(app);
      const res = await agent.get("/api/admin/documents/00000000-0000-0000-0000-000000000000/preview");
      expect(res.status).toBe(404);
    });

    it("renders a .pdf inline (Content-Type: application/pdf, Content-Disposition: inline)", async () => {
      const agent = await loginAsAdmin(app);
      const pdfBytes = Buffer.from("%PDF-1.4\n%fake-pdf-bytes-for-preview-test\n%%EOF");
      const id = await seedReadyDocument(pool, { filename: "a.pdf", ext: "pdf", buffer: pdfBytes });

      const res = await agent.get(`/api/admin/documents/${id}/preview`);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/application\/pdf/);
      expect(res.headers["content-disposition"]).toMatch(/inline/);
    });

    it("renders a .txt inline as text/plain", async () => {
      const agent = await loginAsAdmin(app);
      const id = await seedReadyDocument(pool, {
        filename: "a.txt",
        ext: "txt",
        buffer: Buffer.from("Plain text preview content."),
      });

      const res = await agent.get(`/api/admin/documents/${id}/preview`);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/plain/);
      expect(res.headers["content-disposition"]).toMatch(/inline/);
      expect(res.text).toBe("Plain text preview content.");
    });

    it("renders a .md inline as text/plain", async () => {
      const agent = await loginAsAdmin(app);
      const id = await seedReadyDocument(pool, {
        filename: "a.md",
        ext: "md",
        buffer: Buffer.from("# A heading\n\nSome markdown."),
      });

      const res = await agent.get(`/api/admin/documents/${id}/preview`);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/plain/);
      expect(res.text).toContain("# A heading");
    });

    it("renders a .docx as converted HTML", async () => {
      const agent = await loginAsAdmin(app);
      const buffer = await fs.readFile(path.join(fixturesDir, "sample.docx"));
      const id = await seedReadyDocument(pool, { filename: "sample.docx", ext: "docx", buffer });

      const res = await agent.get(`/api/admin/documents/${id}/preview`);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/html/);
      expect(res.text).toContain("<p>");
    });

    it("renders an .xlsx as an HTML table", async () => {
      const agent = await loginAsAdmin(app);
      const id = await seedReadyDocument(pool, { filename: "sample.xlsx", ext: "xlsx", buffer: buildXlsxBuffer() });

      const res = await agent.get(`/api/admin/documents/${id}/preview`);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/html/);
      expect(res.text).toContain("<table");
      expect(res.text).toContain("Alice");
    });

    it("renders a .csv as an HTML table", async () => {
      const agent = await loginAsAdmin(app);
      const csv = Buffer.from("name,age\nBob,25\n");
      const id = await seedReadyDocument(pool, { filename: "sample.csv", ext: "csv", buffer: csv });

      const res = await agent.get(`/api/admin/documents/${id}/preview`);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/html/);
      expect(res.text).toContain("<table");
      expect(res.text).toContain("Bob");
    });
  });
});
