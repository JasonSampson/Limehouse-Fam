import { Router } from "express";
import fs from "node:fs";
import mammoth from "mammoth";
import * as XLSX from "xlsx";
import { z } from "zod";
import { getPool } from "../db/pool.js";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { ingestAsset, absoluteAssetOriginalPath } from "../rag/assetIngest.js";
import { logError } from "../lib/logger.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { upload } from "../lib/uploadConfig.js";

// CHANGED [today], per Jason directly: browsing Assets is open to anyone
// with Limona access at all (requireAuth) — same reasoning as
// adminDocumentRoutes.ts. Only actually changing something (upload,
// recategorize, edit, remove) still needs limona.documents.manage, applied
// per-route below.
export const adminAssetRoutes = Router();
adminAssetRoutes.use(requireAuth);
const manage = requirePermission("limona.documents.manage");

adminAssetRoutes.get("/api/admin/assets", asyncHandler(async (_req, res) => {
  const result = await getPool().query(
    `SELECT id, filename, description, category, size_bytes, created_at, updated_at
     FROM assets ORDER BY created_at DESC`
  );
  res.json({ assets: result.rows });
}));

// Mirrors GET /api/admin/categories in adminDocumentRoutes.ts, but reads from
// the assets table — Assets and Document Library have always used separate,
// independent category sets (different tables/concepts), so this must not be
// merged with the documents endpoint even though the shape is identical.
adminAssetRoutes.get("/api/admin/asset-categories", asyncHandler(async (_req, res) => {
  const result = await getPool().query("SELECT DISTINCT category FROM assets ORDER BY category");
  res.json({ categories: result.rows.map((r) => r.category) });
}));

const uploadFieldsSchema = z.object({
  description: z.string().min(1, "A description is required."),
  category: z.string().min(1, "A category is required."),
});

adminAssetRoutes.post("/api/admin/assets/upload", manage, upload.single("file"), asyncHandler(async (req, res) => {
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
}));

// Same "always get your exact original file back" guarantee as documents.
adminAssetRoutes.get("/api/admin/assets/:id/download", asyncHandler(async (req, res) => {
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
}));

const assetCategorySchema = z.object({ category: z.string().min(1, "A category is required.") });

// Mirrors adminDocumentRoutes.ts's PATCH /:id/category exactly (same shape,
// same error handling) — an asset must always belong to some category, same
// as documents, so empty string is rejected here too.
adminAssetRoutes.patch("/api/admin/assets/:id/category", manage, asyncHandler(async (req, res) => {
  const parsed = assetCategorySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input." });
    return;
  }
  const result = await getPool().query(
    "UPDATE assets SET category = $1 WHERE id = $2 RETURNING id",
    [parsed.data.category, req.params.id]
  );
  if (result.rows.length === 0) {
    res.status(404).json({ error: "Asset not found." });
    return;
  }
  res.json({ ok: true });
}));

// Unlike upload time (where a description is required), once an asset exists
// an admin can clear its description back out entirely — same reasoning as
// documents' equivalent route, so no .min(1) here.
const assetDescriptionSchema = z.object({ description: z.string() });

adminAssetRoutes.patch("/api/admin/assets/:id/description", manage, asyncHandler(async (req, res) => {
  const parsed = assetDescriptionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input." });
    return;
  }
  const result = await getPool().query(
    "UPDATE assets SET description = $1 WHERE id = $2 RETURNING id",
    [parsed.data.description, req.params.id]
  );
  if (result.rows.length === 0) {
    res.status(404).json({ error: "Asset not found." });
    return;
  }
  res.json({ ok: true });
}));

// Unlike documents (soft-delete via 'superseded' status, since retrieval
// must keep working around re-uploads), assets have no retrieval/versioning
// concern — a hard delete of the row is simplest. The file is left on disk
// (matches the "nothing here deletes bytes" convention from documents) since
// disk cleanup was never asked for and deleting the wrong file has real
// downside with no corresponding benefit at this scale.
adminAssetRoutes.delete("/api/admin/assets/:id", manage, asyncHandler(async (req, res) => {
  const result = await getPool().query("DELETE FROM assets WHERE id = $1 RETURNING id", [req.params.id]);
  if (result.rows.length === 0) {
    res.status(404).json({ error: "Asset not found." });
    return;
  }
  res.json({ ok: true });
}));

// Assets have no file_ext column (unlike documents) since they accept any
// file type on upload — the extension is derived from the stored filename
// instead. Returns "" (never a false extension) for a filename with no dot,
// a leading dot only (dotfile, e.g. ".gitignore"), or a trailing dot.
function fileExt(filename: string): string {
  const idx = filename.lastIndexOf(".");
  if (idx <= 0 || idx === filename.length - 1) {
    return "";
  }
  return filename.slice(idx + 1).toLowerCase();
}

const IMAGE_MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

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

// Renders an asset inline in the browser where it's safe to do so — a view
// route, same as GET /api/admin/assets and its download route, open to
// anyone with Limona access (requireAuth) rather than requiring manage.
// Since assets accept
// ANY file type on upload (no restriction — see upload route above), this
// route is a real security surface: every branch below is an explicit,
// named case, and anything not explicitly named falls through to a plain
// download rather than being served inline with a guessed content-type.
// That fallback is the important safety property here — e.g. an uploaded
// .html file must never be piped back with Content-Disposition: inline,
// since that would execute in this app's own origin.
adminAssetRoutes.get("/api/admin/assets/:id/preview", asyncHandler(async (req, res) => {
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

  const ext = fileExt(row.filename);

  try {
    if (IMAGE_MIME_TYPES[ext]) {
      // Real raster/vector-free image formats — browsers decode these as
      // pixel data only, no embedded active content is possible, so inline
      // is safe. (svg is deliberately NOT in this map — see next branch.)
      res.setHeader("Content-Type", IMAGE_MIME_TYPES[ext]);
      res.setHeader("Content-Disposition", "inline");
      fs.createReadStream(absPath).pipe(res);
      return;
    }

    if (ext === "svg") {
      // DECISION: never serve .svg inline as image/svg+xml. Unlike raster
      // images, SVG is an XML document that can carry an embedded <script>
      // tag — serving it inline from our own authenticated origin is a
      // textbook stored-XSS-via-upload vector. Sanitizing server-side would
      // add a new dependency for one file type; simplest and safest is to
      // treat SVG as download-only, same as any other unrenderable type.
      res.download(absPath, row.filename);
      return;
    }

    if (ext === "pdf") {
      // Same inline-serving pattern as Document Library's preview route.
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
      const workbook =
        ext === "xlsx" ? XLSX.read(buffer, { type: "buffer" }) : XLSX.read(buffer.toString("utf-8"), { type: "string" });
      const multipleSheets = workbook.SheetNames.length > 1;
      const bodyHtml = workbook.SheetNames.map((name) => {
        const table = XLSX.utils.sheet_to_html(workbook.Sheets[name]);
        return multipleSheets ? `<h2>${name}</h2>${table}` : table;
      }).join("\n");
      res.setHeader("Content-Type", "text/html");
      res.send(htmlPage(bodyHtml));
      return;
    }

    // Everything else (.zip, fonts, unknown/exotic extensions, no extension
    // at all): there is no safe generic way to preview arbitrary binary
    // content in a browser. Fall back to the exact same behavior as the
    // /download route rather than guessing a content-type.
    res.download(absPath, row.filename);
  } catch (err) {
    logError("Asset preview failed", { assetId: req.params.id, error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to render preview." });
  }
}));
