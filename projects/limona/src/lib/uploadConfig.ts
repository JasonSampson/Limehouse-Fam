import multer from "multer";

// Files are held in memory only briefly, then written to disk by the ingest
// step for whichever upload path is using this (documents or assets) — both
// are small internal batches, not bulk upload paths, so disk-buffering
// uploads isn't necessary. 25MB/file cap is generous for the kind of files
// Jason described (Word docs/PDFs, brand/reference assets) while still
// bounding worst-case memory use per request.
//
// Shared by src/routes/adminDocumentRoutes.ts and
// src/routes/adminAssetRoutes.ts — keep this the ONE place the limit is
// defined so a future change can't accidentally apply to only one upload path.
export const MAX_UPLOAD_FILE_SIZE_BYTES = 25 * 1024 * 1024;

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_FILE_SIZE_BYTES },
});
