import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { getPool } from "../db/pool.js";
import { loadEnv } from "../config/env.js";
import { logInfo } from "../lib/logger.js";

export interface AssetIngestParams {
  originalFilename: string;
  description: string;
  category: string;
  uploadedBy: string | null;
  fileBuffer: Buffer;
}

export interface AssetIngestResult {
  assetId: string;
}

function storageRootDir(): string {
  return path.resolve(loadEnv().STORAGE_DIR);
}

// Same sanitizer as src/rag/ingest.ts (see that file's comment for why
// path.basename() alone isn't sufficient) — reused here rather than
// reimplemented, since this is the exact path-traversal concern Judge
// flagged before for document uploads and applies identically to assets.
function sanitizeFilename(filename: string): string {
  const base = filename.split(/[/\\]/).pop() || "";
  return base === "." || base === ".." || base === "" ? "unnamed" : base;
}

function relativeOriginalPath(assetId: string, filename: string): string {
  return path.join("assets", assetId, "original", sanitizeFilename(filename));
}

// Assets have no chunking/embedding/status pipeline — just write the file to
// disk and insert one row. Much simpler than ingestDocument() because
// there's no async processing step that can partially fail.
export async function ingestAsset(params: AssetIngestParams): Promise<AssetIngestResult> {
  const pool = getPool();
  const assetId = crypto.randomUUID();
  const relPath = relativeOriginalPath(assetId, params.originalFilename);
  const absPath = path.join(storageRootDir(), relPath);

  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, params.fileBuffer);

  await pool.query(
    `
    INSERT INTO assets (id, filename, description, category, size_bytes, storage_path, uploaded_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    `,
    [
      assetId,
      params.originalFilename,
      params.description,
      params.category,
      params.fileBuffer.length,
      relPath,
      params.uploadedBy,
    ]
  );

  logInfo("Asset ingested successfully", { assetId });
  return { assetId };
}

export function absoluteAssetOriginalPath(storagePath: string): string {
  return path.join(storageRootDir(), storagePath);
}
