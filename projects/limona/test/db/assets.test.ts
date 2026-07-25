import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { getTestPool, truncateAllTables, closeTestPool } from "../support/testDb.js";
import { loginAsLimeHqUser } from "../support/testAuth.js";

process.env.SESSION_COOKIE_SECRET ||= "test-secret-at-least-32-characters-long";

const { buildTestApp } = await import("../support/testApp.js");
const { ingestAsset, absoluteAssetOriginalPath } = await import("../../src/rag/assetIngest.js");
const { loadEnv } = await import("../../src/config/env.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(__dirname, "../fixtures");

function buildXlsxBuffer(): Buffer {
  const ws = XLSX.utils.aoa_to_sheet([
    ["Name", "Age"],
    ["Alice", "30"],
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

function loginAsAdmin(app: ReturnType<typeof buildTestApp>) {
  return loginAsLimeHqUser(app, { id: 1, email: "admin@limehousepm.com", displayName: "Admin Person" });
}

describe("ingestAsset", () => {
  const pool = getTestPool();

  beforeEach(async () => {
    await truncateAllTables();
  });

  it("writes the file to disk and inserts a row with no chunking/status pipeline", async () => {
    const result = await ingestAsset({
      originalFilename: "logo.png",
      description: "Company logo, transparent background",
      category: "Marketing",
      uploadedBy: null,
      fileBuffer: Buffer.from("fake-png-bytes"),
    });

    const row = await pool.query("SELECT filename, description, category, size_bytes, storage_path FROM assets WHERE id = $1", [
      result.assetId,
    ]);
    expect(row.rows[0].filename).toBe("logo.png");
    expect(row.rows[0].description).toBe("Company logo, transparent background");
    expect(row.rows[0].category).toBe("Marketing");
    expect(Number(row.rows[0].size_bytes)).toBe(Buffer.from("fake-png-bytes").length);

    const absPath = absoluteAssetOriginalPath(row.rows[0].storage_path);
    const stat = await fs.stat(absPath);
    expect(stat.isFile()).toBe(true);
  });

  // Regression test matching the exact path-traversal pattern already covered
  // for documents (test/db/ingest.test.ts) — assetIngest.ts reuses the same
  // sanitizeFilename() shape rather than reimplementing it, so it must be
  // just as safe against a crafted originalname.
  it.each([
    ["forward-slash traversal", "../../evil.png"],
    ["backslash traversal", "..\\..\\evil.png"],
    ["deep forward-slash traversal", "../../../../../etc/passwd.png"],
  ])("sanitizes %s in the uploaded filename so the file stays inside its assets/<id>/original folder", async (_label, maliciousName) => {
    const result = await ingestAsset({
      originalFilename: maliciousName,
      description: "test",
      category: "Marketing",
      uploadedBy: null,
      fileBuffer: Buffer.from("some bytes"),
    });

    const row = await pool.query("SELECT storage_path FROM assets WHERE id = $1", [result.assetId]);
    const storagePath: string = row.rows[0].storage_path;

    const expectedDir = path.join("assets", result.assetId, "original");
    expect(storagePath.startsWith(expectedDir)).toBe(true);
    expect(storagePath).not.toMatch(/\.\./);

    const absPath = absoluteAssetOriginalPath(storagePath);
    const storageRoot = path.resolve(loadEnv().STORAGE_DIR);
    const relativeFromRoot = path.relative(storageRoot, absPath);
    expect(relativeFromRoot.startsWith("..")).toBe(false);
    expect(path.isAbsolute(relativeFromRoot)).toBe(false);

    const stat = await fs.stat(absPath);
    expect(stat.isFile()).toBe(true);
  });
});

describe("admin asset routes", () => {
  const pool = getTestPool();
  const app = buildTestApp();

  beforeEach(async () => {
    await truncateAllTables();
  });

  // closeTestPool() is called once here (not in the "ingestAsset" describe
  // above) — both describes in this file share the same module-level pool
  // singleton (see test/support/testDb.ts), so closing it in the first
  // block's afterAll would break every test in this later block.
  afterAll(async () => {
    await closeTestPool();
  });

  it("blocks an unauthenticated request", async () => {
    const res = await request(app).get("/api/admin/assets");
    expect(res.status).toBe(401);
  });

  it("uploads, lists, downloads, and deletes an asset end-to-end", async () => {
    const agent = await loginAsAdmin(app);

    const uploadRes = await agent
      .post("/api/admin/assets/upload")
      .field("description", "Pricing calculator")
      .field("category", "Calculators")
      .attach("file", Buffer.from("spreadsheet bytes"), "pricing.xlsx");
    expect(uploadRes.status).toBe(200);
    const assetId = uploadRes.body.assetId;
    expect(assetId).toBeTruthy();

    const listRes = await agent.get("/api/admin/assets");
    expect(listRes.status).toBe(200);
    expect(listRes.body.assets).toHaveLength(1);
    expect(listRes.body.assets[0].filename).toBe("pricing.xlsx");
    expect(listRes.body.assets[0].description).toBe("Pricing calculator");
    expect(listRes.body.assets[0].category).toBe("Calculators");

    const downloadRes = await agent.get(`/api/admin/assets/${assetId}/download`);
    expect(downloadRes.status).toBe(200);
    expect(downloadRes.text).toBe("spreadsheet bytes");

    const deleteRes = await agent.delete(`/api/admin/assets/${assetId}`);
    expect(deleteRes.status).toBe(200);

    const afterDelete = await pool.query("SELECT id FROM assets WHERE id = $1", [assetId]);
    expect(afterDelete.rows).toHaveLength(0);
  });

  it("rejects upload with no file", async () => {
    const agent = await loginAsAdmin(app);
    const res = await agent.post("/api/admin/assets/upload").field("description", "x").field("category", "y");
    expect(res.status).toBe(400);
  });

  it("rejects upload missing description or category", async () => {
    const agent = await loginAsAdmin(app);
    const res = await agent
      .post("/api/admin/assets/upload")
      .field("category", "Marketing")
      .attach("file", Buffer.from("bytes"), "a.png");
    expect(res.status).toBe(400);
  });

  it("404s on download/delete for an unknown asset id", async () => {
    const agent = await loginAsAdmin(app);
    const fakeId = "00000000-0000-0000-0000-000000000000";
    const downloadRes = await agent.get(`/api/admin/assets/${fakeId}/download`);
    expect(downloadRes.status).toBe(404);
    const deleteRes = await agent.delete(`/api/admin/assets/${fakeId}`);
    expect(deleteRes.status).toBe(404);
  });

  it("GET /api/admin/asset-categories returns distinct category strings actually in use, not a fixed list, and never mixes with documents' categories", async () => {
    const agent = await loginAsAdmin(app);
    await ingestAsset({
      originalFilename: "a.png",
      description: "d",
      category: "Marketing",
      uploadedBy: null,
      fileBuffer: Buffer.from("a"),
    });
    await ingestAsset({
      originalFilename: "b.png",
      description: "d",
      category: "Calculators",
      uploadedBy: null,
      fileBuffer: Buffer.from("b"),
    });
    await ingestAsset({
      originalFilename: "c.png",
      description: "d",
      category: "Marketing",
      uploadedBy: null,
      fileBuffer: Buffer.from("c"),
    });
    // A document with a category not used by any asset — must not leak into
    // the assets categories list, since the two are independent sets.
    await pool.query(
      `INSERT INTO documents (filename, category, description, file_size_bytes, file_ext, storage_path, status)
       VALUES ('doc.txt', 'SOP', 'd', 10, 'txt', 'documents/doc/original/doc.txt', 'ready')`
    );

    const res = await agent.get("/api/admin/asset-categories");
    expect(res.status).toBe(200);
    expect(res.body.categories).toEqual(["Calculators", "Marketing"]);
  });

  describe("PATCH /:id/category", () => {
    it("updates the category text", async () => {
      const agent = await loginAsAdmin(app);
      const { assetId } = await ingestAsset({
        originalFilename: "a.png",
        description: "d",
        category: "Marketing",
        uploadedBy: null,
        fileBuffer: Buffer.from("a"),
      });

      const res = await agent.patch(`/api/admin/assets/${assetId}/category`).send({ category: "Calculators" });
      expect(res.status).toBe(200);

      const row = await pool.query("SELECT category FROM assets WHERE id = $1", [assetId]);
      expect(row.rows[0].category).toBe("Calculators");
    });

    it("rejects an empty-string category (an asset must always belong to some category)", async () => {
      const agent = await loginAsAdmin(app);
      const { assetId } = await ingestAsset({
        originalFilename: "a.png",
        description: "d",
        category: "Marketing",
        uploadedBy: null,
        fileBuffer: Buffer.from("a"),
      });

      const res = await agent.patch(`/api/admin/assets/${assetId}/category`).send({ category: "" });
      expect(res.status).toBe(400);

      const row = await pool.query("SELECT category FROM assets WHERE id = $1", [assetId]);
      expect(row.rows[0].category).toBe("Marketing");
    });

    it("404s for an unknown asset", async () => {
      const agent = await loginAsAdmin(app);
      const res = await agent
        .patch("/api/admin/assets/00000000-0000-0000-0000-000000000000/category")
        .send({ category: "Marketing" });
      expect(res.status).toBe(404);
    });

    it("blocks an unauthenticated request", async () => {
      const { assetId } = await ingestAsset({
        originalFilename: "a.png",
        description: "d",
        category: "Marketing",
        uploadedBy: null,
        fileBuffer: Buffer.from("a"),
      });
      const res = await request(app).patch(`/api/admin/assets/${assetId}/category`).send({ category: "Nope" });
      expect(res.status).toBe(401);
    });
  });

  describe("PATCH /:id/description", () => {
    it("updates the description text", async () => {
      const agent = await loginAsAdmin(app);
      const { assetId } = await ingestAsset({
        originalFilename: "a.png",
        description: "Original description",
        category: "Marketing",
        uploadedBy: null,
        fileBuffer: Buffer.from("a"),
      });

      const res = await agent.patch(`/api/admin/assets/${assetId}/description`).send({ description: "Updated description" });
      expect(res.status).toBe(200);

      const row = await pool.query("SELECT description FROM assets WHERE id = $1", [assetId]);
      expect(row.rows[0].description).toBe("Updated description");
    });

    it("clears the description back to an empty string", async () => {
      const agent = await loginAsAdmin(app);
      const { assetId } = await ingestAsset({
        originalFilename: "a.png",
        description: "Original description",
        category: "Marketing",
        uploadedBy: null,
        fileBuffer: Buffer.from("a"),
      });

      const res = await agent.patch(`/api/admin/assets/${assetId}/description`).send({ description: "" });
      expect(res.status).toBe(200);

      const row = await pool.query("SELECT description FROM assets WHERE id = $1", [assetId]);
      expect(row.rows[0].description).toBe("");
    });

    it("404s for an unknown asset", async () => {
      const agent = await loginAsAdmin(app);
      const res = await agent
        .patch("/api/admin/assets/00000000-0000-0000-0000-000000000000/description")
        .send({ description: "Anything" });
      expect(res.status).toBe(404);
    });

    it("blocks an unauthenticated request", async () => {
      const { assetId } = await ingestAsset({
        originalFilename: "a.png",
        description: "d",
        category: "Marketing",
        uploadedBy: null,
        fileBuffer: Buffer.from("a"),
      });
      const res = await request(app).patch(`/api/admin/assets/${assetId}/description`).send({ description: "Nope" });
      expect(res.status).toBe(401);
    });
  });

  // Assets accept ANY file type on upload — unlike documents, there is no
  // extToSupportedExt() gate in adminAssetRoutes.ts. Covers a file type with
  // an extension that documents explicitly rejects (.zip) and a file with no
  // extension at all, both of which must upload successfully.
  it("accepts an upload with no restriction on file type", async () => {
    const agent = await loginAsAdmin(app);

    const zipRes = await agent
      .post("/api/admin/assets/upload")
      .field("description", "Archived brand kit")
      .field("category", "Marketing")
      .attach("file", Buffer.from("PK\x03\x04fake-zip-bytes"), "brand-kit.zip");
    expect(zipRes.status).toBe(200);

    const noExtRes = await agent
      .post("/api/admin/assets/upload")
      .field("description", "Font file with no extension")
      .field("category", "Marketing")
      .attach("file", Buffer.from("fake-font-bytes"), "customfont");
    expect(noExtRes.status).toBe(200);

    const listRes = await agent.get("/api/admin/assets");
    expect(listRes.body.assets.map((a: { filename: string }) => a.filename).sort()).toEqual([
      "brand-kit.zip",
      "customfont",
    ]);
  });

  describe("GET /:id/preview", () => {
    it("404s for an unknown asset", async () => {
      const agent = await loginAsAdmin(app);
      const res = await agent.get("/api/admin/assets/00000000-0000-0000-0000-000000000000/preview");
      expect(res.status).toBe(404);
    });

    it("renders a .png image inline with the correct content type", async () => {
      const agent = await loginAsAdmin(app);
      const { assetId } = await ingestAsset({
        originalFilename: "logo.png",
        description: "Company logo",
        category: "Marketing",
        uploadedBy: null,
        fileBuffer: Buffer.from("fake-png-bytes"),
      });

      const res = await agent.get(`/api/admin/assets/${assetId}/preview`);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/image\/png/);
      expect(res.headers["content-disposition"]).toMatch(/inline/);
    });

    it("renders a .pdf inline (Content-Type: application/pdf, Content-Disposition: inline)", async () => {
      const agent = await loginAsAdmin(app);
      const pdfBytes = Buffer.from("%PDF-1.4\n%fake-pdf-bytes-for-preview-test\n%%EOF");
      const { assetId } = await ingestAsset({
        originalFilename: "onepager.pdf",
        description: "One pager",
        category: "Marketing",
        uploadedBy: null,
        fileBuffer: pdfBytes,
      });

      const res = await agent.get(`/api/admin/assets/${assetId}/preview`);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/application\/pdf/);
      expect(res.headers["content-disposition"]).toMatch(/inline/);
    });

    it("renders a .docx as converted HTML", async () => {
      const agent = await loginAsAdmin(app);
      const buffer = await fs.readFile(path.join(fixturesDir, "sample.docx"));
      const { assetId } = await ingestAsset({
        originalFilename: "color-guide.docx",
        description: "Brand color guide",
        category: "Marketing",
        uploadedBy: null,
        fileBuffer: buffer,
      });

      const res = await agent.get(`/api/admin/assets/${assetId}/preview`);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/html/);
      expect(res.text).toContain("<p>");
    });

    it("renders an .xlsx as an HTML table", async () => {
      const agent = await loginAsAdmin(app);
      const { assetId } = await ingestAsset({
        originalFilename: "pricing.xlsx",
        description: "Pricing calculator",
        category: "Calculators",
        uploadedBy: null,
        fileBuffer: buildXlsxBuffer(),
      });

      const res = await agent.get(`/api/admin/assets/${assetId}/preview`);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/html/);
      expect(res.text).toContain("<table");
      expect(res.text).toContain("Alice");
    });

    it("renders a .csv as an HTML table", async () => {
      const agent = await loginAsAdmin(app);
      const { assetId } = await ingestAsset({
        originalFilename: "data.csv",
        description: "Raw data",
        category: "Calculators",
        uploadedBy: null,
        fileBuffer: Buffer.from("name,age\nBob,25\n"),
      });

      const res = await agent.get(`/api/admin/assets/${assetId}/preview`);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/html/);
      expect(res.text).toContain("<table");
      expect(res.text).toContain("Bob");
    });

    // Core security property under test: a .zip (a stand-in for "any
    // unrenderable/exotic type") must never be served inline with a guessed
    // content-type — it should behave exactly like /download.
    it("falls back to a download for an unhandled file type (.zip)", async () => {
      const agent = await loginAsAdmin(app);
      const { assetId } = await ingestAsset({
        originalFilename: "brand-kit.zip",
        description: "Archived brand kit",
        category: "Marketing",
        uploadedBy: null,
        fileBuffer: Buffer.from("PK\x03\x04fake-zip-bytes"),
      });

      const previewRes = await agent.get(`/api/admin/assets/${assetId}/preview`);
      const downloadRes = await agent.get(`/api/admin/assets/${assetId}/download`);

      expect(previewRes.status).toBe(200);
      expect(previewRes.headers["content-disposition"]).not.toMatch(/inline/);
      expect(previewRes.headers["content-disposition"]).toMatch(/attachment/);
      expect(previewRes.headers["content-disposition"]).toBe(downloadRes.headers["content-disposition"]);
      expect(previewRes.text).toBe(downloadRes.text);
    });

    // The other core security property under test: .svg is technically an
    // image, but can carry an embedded <script>, so it must NEVER come back
    // with Content-Disposition: inline (the browser rendering it as a page
    // in our origin is the actual danger, regardless of what Content-Type
    // the response reports) — it must behave like /download instead, exactly
    // like the .zip case above.
    it("never serves an .svg inline — falls back to download (Content-Disposition: attachment) instead", async () => {
      const agent = await loginAsAdmin(app);
      const svgBytes = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`);
      const { assetId } = await ingestAsset({
        originalFilename: "icon.svg",
        description: "Icon",
        category: "Marketing",
        uploadedBy: null,
        fileBuffer: svgBytes,
      });

      const previewRes = await agent.get(`/api/admin/assets/${assetId}/preview`);
      const downloadRes = await agent.get(`/api/admin/assets/${assetId}/download`);

      expect(previewRes.status).toBe(200);
      expect(previewRes.headers["content-disposition"]).not.toMatch(/inline/);
      expect(previewRes.headers["content-disposition"]).toMatch(/attachment/);
      expect(previewRes.headers["content-disposition"]).toBe(downloadRes.headers["content-disposition"]);
      expect(previewRes.text).toBe(downloadRes.text);
    });
  });
});
