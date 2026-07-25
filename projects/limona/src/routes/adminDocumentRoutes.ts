import { Router } from "express";
import fs from "node:fs";
import mammoth from "mammoth";
import * as XLSX from "xlsx";
import { z } from "zod";
import { getPool } from "../db/pool.js";
import { requireAdmin } from "../auth/middleware.js";
import { ingestDocument, absoluteOriginalPath } from "../rag/ingest.js";
import { extToSupportedExt } from "../rag/extractText.js";
import { logError } from "../lib/logger.js";
import { upload } from "../lib/uploadConfig.js";

export const adminDocumentRoutes = Router();
adminDocumentRoutes.use(requireAdmin);

adminDocumentRoutes.get("/api/admin/documents", async (req, res) => {
  const category = typeof req.query.category === "string" && req.query.category !== "" ? req.query.category : undefined;
  const result = await getPool().query(
    `
    SELECT id, filename, category, description, document_created_at, file_size_bytes,
           file_ext, status, version, replaces_document_id, created_at, updated_at
    FROM documents
    WHERE status != 'superseded' AND ($1::text IS NULL OR category = $1)
    ORDER BY created_at DESC
    `,
    [category ?? null]
  );
  res.json({ documents: result.rows });
});

// Categories are now just free-form text on documents (matching how assets
// already worked) rather than a fixed 7-row lookup table — this returns
// whatever category strings are actually in use so the admin UI can offer
// them (e.g. as a datalist), not a fixed reference list.
adminDocumentRoutes.get("/api/admin/categories", async (_req, res) => {
  const result = await getPool().query("SELECT DISTINCT category FROM documents ORDER BY category");
  res.json({ categories: result.rows.map((r) => r.category) });
});

// Accepts an empty/missing value as "not provided" (multipart form fields
// arrive as strings, so an unfilled date input often comes through as "")
// rather than failing validation on it.
const documentCreatedAtField = z.preprocess(
  (v) => (v === "" || v === undefined || v === null ? undefined : v),
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "documentCreatedAt must be a date in YYYY-MM-DD format.")
    .optional()
);

// Mirrors adminAssetRoutes.ts's uploadFieldsSchema exactly (same validation
// approach/messages) so both upload paths behave consistently.
const uploadFieldsSchema = z.object({
  category: z.string().min(1, "A category is required."),
  description: z.string().min(1, "A description is required."),
  documentCreatedAt: documentCreatedAtField,
  // When re-uploading to replace an existing document, the admin UI sends
  // the id of the document being replaced.
  replacesDocumentId: z.string().uuid().optional(),
});

const SUPPORTED_EXTENSIONS_MESSAGE = "Only .pdf, .docx, .xlsx, .csv, .txt, and .md are supported.";

// Single-file upload. Bulk upload (below) reuses this same ingest path per
// file so there is exactly one place that knows how to go from bytes on
// the wire to a ready, searchable document.
adminDocumentRoutes.post("/api/admin/documents/upload", upload.single("file"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "No file uploaded." });
    return;
  }
  const parsed = uploadFieldsSchema.safeParse({
    category: req.body.category,
    description: req.body.description,
    documentCreatedAt: req.body.documentCreatedAt,
    replacesDocumentId: req.body.replacesDocumentId || undefined,
  });
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input." });
    return;
  }
  if (!extToSupportedExt(req.file.originalname.slice(req.file.originalname.lastIndexOf(".")))) {
    res.status(400).json({ error: `Unsupported file type for "${req.file.originalname}". ${SUPPORTED_EXTENSIONS_MESSAGE}` });
    return;
  }

  try {
    const result = await ingestDocument({
      originalFilename: req.file.originalname,
      category: parsed.data.category,
      description: parsed.data.description,
      documentCreatedAt: parsed.data.documentCreatedAt ?? null,
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

const bulkUploadFieldsSchema = z.object({
  category: z.string().min(1, "A category is required."),
  description: z.string().min(1, "A description is required."),
  documentCreatedAt: documentCreatedAtField,
});

// Bulk upload: same category/description/documentCreatedAt applied to every
// file in the batch, matching the "seeding ~46 files at launch" use case
// where a whole folder maps to one category at a time. Each file ingests
// independently — one bad file (e.g. a corrupted PDF) doesn't fail the whole
// batch.
adminDocumentRoutes.post("/api/admin/documents/bulk-upload", upload.array("files", 100), async (req, res) => {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (files.length === 0) {
    res.status(400).json({ error: "No files uploaded." });
    return;
  }
  const parsed = bulkUploadFieldsSchema.safeParse(req.body);
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
        category: parsed.data.category,
        description: parsed.data.description,
        documentCreatedAt: parsed.data.documentCreatedAt ?? null,
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

const recategorizeSchema = z.object({ category: z.string().min(1, "A category is required.") });

adminDocumentRoutes.patch("/api/admin/documents/:id/category", async (req, res) => {
  const parsed = recategorizeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input." });
    return;
  }
  const result = await getPool().query(
    "UPDATE documents SET category = $1 WHERE id = $2 RETURNING id",
    [parsed.data.category, req.params.id]
  );
  if (result.rows.length === 0) {
    res.status(404).json({ error: "Document not found." });
    return;
  }
  res.json({ ok: true });
});

const documentCreatedAtSchema = z.object({
  documentCreatedAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "documentCreatedAt must be a date in YYYY-MM-DD format.")
    .nullable(),
});

// Modeled directly on the category-patch route above — same shape/error
// handling, just a different column. Lets an admin set or clear (via null)
// the "this document is dated ___" field after upload.
adminDocumentRoutes.patch("/api/admin/documents/:id/document-created-at", async (req, res) => {
  const parsed = documentCreatedAtSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input." });
    return;
  }
  const result = await getPool().query(
    "UPDATE documents SET document_created_at = $1 WHERE id = $2 RETURNING id",
    [parsed.data.documentCreatedAt, req.params.id]
  );
  if (result.rows.length === 0) {
    res.status(404).json({ error: "Document not found." });
    return;
  }
  res.json({ ok: true });
});

// Unlike upload time (where a description is required), once a document
// exists an admin can clear its description back out entirely — so, unlike
// uploadFieldsSchema's description field, this one has no .min(1).
const descriptionSchema = z.object({ description: z.string() });

// Modeled directly on the category-patch route above — same shape/error
// handling, just a different column.
adminDocumentRoutes.patch("/api/admin/documents/:id/description", async (req, res) => {
  const parsed = descriptionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input." });
    return;
  }
  const result = await getPool().query(
    "UPDATE documents SET description = $1 WHERE id = $2 RETURNING id",
    [parsed.data.description, req.params.id]
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

function htmlPage(bodyHtml: string): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { font-family: -apple-system, Segoe UI, Arial, sans-serif; max-width: 900px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; line-height: 1.5; }
  table { border-collapse: collapse; margin: 1rem 0; }
  td, th { border: 1px solid #ccc; padding: 4px 8px; }
  img { max-width: 100%; }
</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

// Renders a document inline in the browser instead of forcing a download —
// same requireAdmin guard, same on-disk file the /download route reads, but
// branches on file_ext to decide how to render it since only pdf/txt/md can
// be sent to the browser as-is.
adminDocumentRoutes.get("/api/admin/documents/:id/preview", async (req, res) => {
  const result = await getPool().query(
    "SELECT filename, storage_path, file_ext FROM documents WHERE id = $1",
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

  const ext: string = row.file_ext;

  try {
    if (ext === "pdf") {
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", "inline");
      fs.createReadStream(absPath).pipe(res);
      return;
    }

    if (ext === "txt" || ext === "md") {
      res.setHeader("Content-Type", "text/plain");
      res.setHeader("Content-Disposition", "inline");
      fs.createReadStream(absPath).pipe(res);
      return;
    }

    if (ext === "docx") {
      const buffer = await fs.promises.readFile(absPath);
      const converted = await mammoth.convertToHtml({ buffer });
      res.setHeader("Content-Type", "text/html");
      res.send(htmlPage(converted.value));
      return;
    }

    if (ext === "xlsx" || ext === "csv") {
      const buffer = await fs.promises.readFile(absPath);
      const workbook = ext === "xlsx" ? XLSX.read(buffer, { type: "buffer" }) : XLSX.read(buffer.toString("utf-8"), { type: "string" });
      const multipleSheets = workbook.SheetNames.length > 1;
      const bodyHtml = workbook.SheetNames.map((name) => {
        const table = XLSX.utils.sheet_to_html(workbook.Sheets[name]);
        return multipleSheets ? `<h2>${name}</h2>${table}` : table;
      }).join("\n");
      res.setHeader("Content-Type", "text/html");
      res.send(htmlPage(bodyHtml));
      return;
    }

    res.status(400).json({ error: `Preview is not supported for file type "${ext}".` });
  } catch (err) {
    logError("Document preview failed", { documentId: req.params.id, error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to render preview." });
  }
});
