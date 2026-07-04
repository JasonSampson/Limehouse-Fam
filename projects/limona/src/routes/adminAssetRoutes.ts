import { Router } from "express";
import fs from "node:fs";
import { z } from "zod";
import { getPool } from "../db/pool.js";
import { requireAdmin } from "../auth/middleware.js";
import { ingestAsset, absoluteAssetOriginalPath } from "../rag/assetIngest.js";
import { logError } from "../lib/logger.js";
import { upload } from "../lib/uploadConfig.js";

export const adminAssetRoutes = Router();
adminAssetRoutes.use(requireAdmin);

adminAssetRoutes.get("/api/admin/assets", async (_req, res) => {
  const result = await getPool().query(
    `SELECT id, filename, description, category, size_bytes, created_at, updated_at
     FROM assets ORDER BY created_at DESC`
  );
  res.json({ assets: result.rows });
});

const uploadFieldsSchema = z.object({
  description: z.string().min(1, "A description is required."),
  category: z.string().min(1, "A category is required."),
});

adminAssetRoutes.post("/api/admin/assets/upload", upload.single("file"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "No file uploaded." });
    return;
  }
  const parsed = uploadFieldsSchema.safeParse({
    description: req.body.description,
    category: req.body.category,
  });
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input." });
    return;
  }

  try {
    const result = await ingestAsset({
      originalFilename: req.file.originalname,
      description: parsed.data.description,
      category: parsed.data.category,
      uploadedBy: req.user!.id,
      fileBuffer: req.file.buffer,
    });
    res.json({ ok: true, assetId: result.assetId });
  } catch (err) {
    logError("Asset upload failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: err instanceof Error ? err.message : "Upload failed." });
  }
});

// Same "always get your exact original file back" guarantee as documents.
adminAssetRoutes.get("/api/admin/assets/:id/download", async (req, res) => {
  const result = await getPool().query("SELECT filename, storage_path FROM assets WHERE id = $1", [
    req.params.id,
  ]);
  const row = result.rows[0];
  if (!row) {
    res.status(404).json({ error: "Asset not found." });
    return;
  }
  const absPath = absoluteAssetOriginalPath(row.storage_path);
  if (!fs.existsSync(absPath)) {
    res.status(404).json({ error: "Original file is missing from storage." });
    return;
  }
  res.download(absPath, row.filename);
});

// Unlike documents (soft-delete via 'superseded' status, since retrieval
// must keep working around re-uploads), assets have no retrieval/versioning
// concern — a hard delete of the row is simplest. The file is left on disk
// (matches the "nothing here deletes bytes" convention from documents) since
// disk cleanup was never asked for and deleting the wrong file has real
// downside with no corresponding benefit at this scale.
adminAssetRoutes.delete("/api/admin/assets/:id", async (req, res) => {
  const result = await getPool().query("DELETE FROM assets WHERE id = $1 RETURNING id", [req.params.id]);
  if (result.rows.length === 0) {
    res.status(404).json({ error: "Asset not found." });
    return;
  }
  res.json({ ok: true });
});
