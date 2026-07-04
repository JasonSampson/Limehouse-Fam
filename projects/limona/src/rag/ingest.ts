import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { getPool } from "../db/pool.js";
import { loadEnv } from "../config/env.js";
import { extractText, extToSupportedExt } from "./extractText.js";
import { chunkText } from "./chunkText.js";
import { embedChunks, toVectorLiteral } from "./embeddings.js";
import { logError, logInfo } from "../lib/logger.js";
import { sanitizeFilename } from "./sanitizeFilename.js";

export interface IngestParams {
  originalFilename: string;
  categoryId: number;
  uploadedBy: string | null;
  fileBuffer: Buffer;
  // If set, this is a re-upload replacing an existing ready document.
  replacesDocumentId?: string;
}

export interface IngestResult {
  documentId: string;
  status: "ready" | "failed";
  chunkCount: number;
}

function storageRootDir(): string {
  return path.resolve(loadEnv().STORAGE_DIR);
}

function relativeOriginalPath(documentId: string, filename: string): string {
  return path.join("documents", documentId, "original", sanitizeFilename(filename));
}

// Extracts, chunks, embeds, and writes one document plus its chunks.
// Original bytes are written to disk FIRST (outside the DB transaction —
// disk writes aren't transactional with Postgres), then the DB row is
// created as 'processing'. Only after chunking + embedding succeed does the
// transaction flip this document to 'ready' and, if this is a re-upload,
// flip the old document to 'superseded' — all in one transaction so a
// failure partway through never leaves retrieval pointed at a half-written
// document, and the previously-working document keeps serving until the
// new one is fully ready.
export async function ingestDocument(params: IngestParams): Promise<IngestResult> {
  const ext = extToSupportedExt(path.extname(params.originalFilename));
  if (!ext) {
    throw new Error(`Unsupported file type for "${params.originalFilename}". Only .docx and .pdf are supported.`);
  }

  const pool = getPool();
  const documentId = crypto.randomUUID();
  const relPath = relativeOriginalPath(documentId, params.originalFilename);
  const absPath = path.join(storageRootDir(), relPath);

  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, params.fileBuffer);

  // Determine version up front (before the transaction) so we can insert
  // the new row directly with the correct version/replaces_document_id.
  let version = 1;
  if (params.replacesDocumentId) {
    const prior = await pool.query("SELECT version FROM documents WHERE id = $1", [
      params.replacesDocumentId,
    ]);
    version = (prior.rows[0]?.version ?? 0) + 1;
  }

  await pool.query(
    `
    INSERT INTO documents
      (id, filename, category_id, file_size_bytes, file_ext, storage_path, uploaded_by, status, version, replaces_document_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'processing', $8, $9)
    `,
    [
      documentId,
      params.originalFilename,
      params.categoryId,
      params.fileBuffer.length,
      ext,
      relPath,
      params.uploadedBy,
      version,
      params.replacesDocumentId ?? null,
    ]
  );

  try {
    const text = await extractText(params.fileBuffer, ext);
    const chunks = chunkText(text);

    if (chunks.length === 0) {
      throw new Error("No extractable text found in document — it may be empty, scanned images, or corrupted.");
    }

    const embeddings = await embedChunks(chunks.map((c) => c.content));

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (let i = 0; i < chunks.length; i++) {
        await client.query(
          `
          INSERT INTO document_chunks (document_id, chunk_index, content, embedding)
          VALUES ($1, $2, $3, $4::vector)
          `,
          [documentId, chunks[i].chunkIndex, chunks[i].content, toVectorLiteral(embeddings[i])]
        );
      }

      await client.query("UPDATE documents SET status = 'ready' WHERE id = $1", [documentId]);

      if (params.replacesDocumentId) {
        await client.query("UPDATE documents SET status = 'superseded' WHERE id = $1", [
          params.replacesDocumentId,
        ]);
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    logInfo("Document ingested successfully", { documentId, chunkCount: chunks.length });
    return { documentId, status: "ready", chunkCount: chunks.length };
  } catch (err) {
    // The old document (if any) is untouched and stays 'ready' — a failed
    // re-upload never breaks the previously-working document.
    await pool.query("UPDATE documents SET status = 'failed' WHERE id = $1", [documentId]);
    logError("Document ingest failed", { documentId, error: err instanceof Error ? err.message : String(err) });
    return { documentId, status: "failed", chunkCount: 0 };
  }
}

export function absoluteOriginalPath(storagePath: string): string {
  return path.join(storageRootDir(), storagePath);
}
