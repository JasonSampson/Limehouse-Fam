import { Router } from "express";
import multer from "multer";
import fs from "node:fs";
import { z } from "zod";
import { getPool } from "../db/pool.js";
import { requireAdmin } from "../auth/middleware.js";
import { ingestDocument, absoluteOriginalPath } from "../rag/ingest.js";
import { extToSupportedExt } from "../rag/extractText.js";
import { logError } from "../lib/logger.js";

export const adminDocumentRoutes = Router();
adminDocumentRoutes.use(requireAdmin);

// Files are held in memory only briefly, then written to disk by
// ingestDocument — 46 seed files at launch is a small enough batch that
// disk-buffering uploads isn't necessary. 25MB/file cap is generous for
// Word docs/PDFs of the kind Jason described (SOPs, leases, job
// descriptions) while still bounding worst-case memory use per request.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

adminDocumentRoutes.get("/api/admin/documents", async (req, res) => {
  const categoryId = req.query.categoryId ? Number(req.query.categoryId) : undefined;
  const result = await getPool().query(
    `
    SELECT d.id, d.filename, d.category_id, c.name AS category_name, d.file_size_bytes,
           d.file_ext, d.status, d.version, d.replaces_document_id, d.created_at, d.updated_at
    FROM documents d
    JOIN document_categories c ON c.id = d.category_id
    WHERE d.status != 'superseded' AND ($1::smallint IS NULL OR d.category_id = $1)
    ORDER BY d.created_at DESC
    `,
    [categoryId ?? null]
  );
  res.json({ documents: result.rows });
});

adminDocumentRoutes.get("/api/admin/categories", async (_req, res) => {
  const result = await getPool().query("SELECT id, name FROM document_categories ORDER BY id");
  res.json({ categories: result.rows });
});

const uploadFieldsSchema = z.object({
  categoryId: z.coerce.number().int().min(1).max(7),
  // When re-uploading to replace an existing document, the admin UI sends
  // the id of the document being replaced.
  replacesDocumentId: z.string().uuid().optional(),
});

// Single-file upload. Bulk upload (below) reuses this same ingest path per
// file so there is exactly one place that knows how to go from bytes on
// the wire to a ready, searchable document.
adminDocumentRoutes.post("/api/admin/documents/upload", upload.single("file"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "No file uploaded." });
    return;
  }
  const parsed = uploadFieldsSchema.safeParse({
    categoryId: req.body.categoryId,
    replacesDocumentId: req.body.replacesDocumentId || undefined,
  });
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input." });
    return;
  }
  if (!extToSupportedExt(req.file.originalname.slice(req.file.originalname.lastIndexOf(".")))) {
    res.status(400).json({ error: `Unsupported file type for "${req.file.originalname}". Only .docx and .pdf are supported.` });
    return;
  }

  try {
    const result = await ingestDocument({
      originalFilename: req.file.originalname,
      categoryId: parsed.data.categoryId,
      uploadedBy: req.user!.id,
      fileBuffer: req.file.buffer,
      replacesDocumentId: parsed.data.replacesDocumentId,
    });
    res.json(result);
  } catch (err) {
    logError("Upload failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: err instanceof Error ? err.message : "Upload failed." });
  }
});

// Bulk upload: same category applied to every file in the batch, matching
// the "seeding ~46 files at launch" use case where a whole folder maps to
// one category at a time. Each file ingests independently — one bad file
// (e.g. a corrupted PDF) doesn't fail the whole batch.
adminDocumentRoutes.post("/api/admin/documents/bulk-upload", upload.array("files", 100), async (req, res) => {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (files.length === 0) {
    res.status(400).json({ error: "No files uploaded." });
    return;
  }
  const parsed = z.object({ categoryId: z.coerce.number().int().min(1).max(7) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input." });
    return;
  }

  const results = [];
  for (const file of files) {
    if (!extToSupportedExt(file.originalname.slice(file.originalname.lastIndexOf(".")))) {
      results.push({ filename: file.originalname, status: "failed", error: "Unsupported file type." });
      continue;
    }
    try {
      const result = await ingestDocument({
        originalFilename: file.originalname,
        categoryId: parsed.data.categoryId,
        uploadedBy: req.user!.id,
        fileBuffer: file.buffer,
      });
      results.push({ filename: file.originalname, ...result });
    } catch (err) {
      logError("Bulk upload item failed", { filename: file.originalname, error: err instanceof Error ? err.message : String(err) });
      results.push({ filename: file.originalname, status: "failed", error: err instanceof Error ? err.message : "Upload failed." });
    }
  }

  res.json({ results });
});

const recategorizeSchema = z.object({ categoryId: z.coerce.number().int().min(1).max(7) });

adminDocumentRoutes.patch("/api/admin/documents/:id/category", async (req, res) => {
  const parsed = recategorizeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input." });
    return;
  }
  const result = await getPool().query(
    "UPDATE documents SET category_id = $1 WHERE id = $2 RETURNING id",
    [parsed.data.categoryId, req.params.id]
  );
  if (result.rows.length === 0) {
    res.status(404).json({ error: "Document not found." });
    return;
  }
  res.json({ ok: true });
});

// "Remove" here means the document stops appearing/being retrievable —
// marking it superseded-with-no-replacement is simplest and consistent with
// the "don't hard-delete automatically" rule already used for re-uploads.
// The original file stays on disk untouched; nothing here deletes bytes.
adminDocumentRoutes.delete("/api/admin/documents/:id", async (req, res) => {
  const result = await getPool().query(
    "UPDATE documents SET status = 'superseded' WHERE id = $1 AND status = 'ready' RETURNING id",
    [req.params.id]
  );
  if (result.rows.length === 0) {
    res.status(404).json({ error: "Document not found or not currently active." });
    return;
  }
  res.json({ ok: true });
});

// Hard requirement from the approved spec: every uploaded document must be
// downloadable back in its original, untouched form at any time. This reads
// the exact bytes written at upload time — no re-rendering, no re-export.
adminDocumentRoutes.get("/api/admin/documents/:id/download", async (req, res) => {
  const result = await getPool().query(
    "SELECT filename, storage_path FROM documents WHERE id = $1",
    [req.params.id]
  );
  const row = result.rows[0];
  if (!row) {
    res.status(404).json({ error: "Document not found." });
    return;
  }
  const absPath = absoluteOriginalPath(row.storage_path);
  if (!fs.existsSync(absPath)) {
    res.status(404).json({ error: "Original file is missing from storage." });
    return;
  }
  res.download(absPath, row.filename);
});
