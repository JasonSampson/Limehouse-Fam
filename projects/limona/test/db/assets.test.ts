import path from "node:path";
import fs from "node:fs/promises";
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { getTestPool, truncateAllTables, closeTestPool } from "../support/testDb.js";
import { loginAsLimeHqUser } from "../support/testAuth.js";

process.env.SESSION_COOKIE_SECRET ||= "test-secret-at-least-32-characters-long";

const { buildTestApp } = await import("../support/testApp.js");
const { ingestAsset, absoluteAssetOriginalPath } = await import("../../src/rag/assetIngest.js");
const { loadEnv } = await import("../../src/config/env.js");

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
});
