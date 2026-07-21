import type { Pool } from "pg";
import {
  fetchPropertyImages,
  downloadPropertyImage,
  contentTypeFromFileName,
  isRealUploadedPhoto,
} from "../buildium/client.js";
import { uploadPropertyPhoto } from "../storage/supabaseStorage.js";
import { logInfo } from "../lib/appLogger.js";

export interface PhotoSyncResult {
  photosSynced: number;
  errors: string[];
}

// Picking a "primary" photo: fetchPropertyImages() (client.ts, CONFIRMED
// LIVE 2026-07-21) hits Buildium's dedicated rental-images endpoint, so
// every result is already a real photo — no content-type filtering needed
// here anymore (the old code filtered generic /files results down to
// image/* because that list mixed in lease documents, insurance docs, etc.;
// this endpoint never returns those). Among a property's photos, prefer the
// first one Buildium has marked ShowInListing (its own "this is a public-
// facing listing photo" flag), falling back to plain first-returned if none
// are marked — Buildium doesn't expose an explicit "cover photo" concept
// beyond that flag.
function fileExtensionFromContentType(contentType: string | null): string {
  if (!contentType) return "jpg";
  const match = contentType.match(/^image\/(\w+)/);
  return match ? match[1] : "jpg";
}

// Downloads and stores one photo per property that doesn't already have
// one synced — never hot-links a Buildium URL (spec Section 4 / Risk #1).
// Placeholder handling for properties with zero usable photos is a
// display-layer concern for Tron, not this job's problem (schema.md).
export async function syncPropertyPhotos(jobPool: Pool): Promise<PhotoSyncResult> {
  const errors: string[] = [];
  let photosSynced = 0;

  const properties = await jobPool.query<{ id: number; buildium_property_id: string }>(
    `SELECT p.id, p.buildium_property_id
     FROM properties p
     WHERE p.is_active = true
       AND NOT EXISTS (SELECT 1 FROM property_photos pp WHERE pp.property_id = p.id AND pp.is_primary)`
  );

  for (const property of properties.rows) {
    const buildiumPropertyId = Number(property.buildium_property_id);
    let images;
    try {
      images = await fetchPropertyImages(buildiumPropertyId);
    } catch (err) {
      errors.push(
        `Property ${property.id} (Buildium ${buildiumPropertyId}): failed to list images — ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      continue;
    }

    // CORRECTED 2026-07-21, per Jason directly: this endpoint's list can
    // include externally-hosted VIDEOS (Provider != "None", e.g. YouTube)
    // alongside real uploaded photos — confirmed live on property 348401,
    // whose YouTube walkthrough had ShowInListing=true and was being
    // silently mistaken for the featured photo. Filter those out FIRST,
    // then apply the same "prefer ShowInListing, else first" preference
    // only among genuine photos — a video entry must never be selected
    // here, regardless of its ShowInListing flag.
    const realPhotos = images.filter(isRealUploadedPhoto);
    const photoImage = realPhotos.find((img) => img.showInListing) ?? realPhotos[0];
    if (!photoImage) {
      // No real (non-video) photos uploaded in Buildium for this property
      // yet — expected/common (confirmed live: 176 of 196 real properties
      // currently have none), not an error. Nothing to insert; Tron's UI
      // shows the placeholder state.
      continue;
    }

    try {
      const { bytes, contentType: downloadedContentType } = await downloadPropertyImage(
        buildiumPropertyId,
        photoImage.id
      );
      const contentType = downloadedContentType ?? contentTypeFromFileName(photoImage.fileName);
      const extension = fileExtensionFromContentType(contentType);
      const path = `${property.id}/${photoImage.id}.${extension}`;
      const { bucket, path: storedPath } = await uploadPropertyPhoto(path, bytes, contentType);

      await jobPool.query(
        `INSERT INTO property_photos (
           property_id, buildium_file_id, storage_bucket, storage_path, content_type, is_primary, synced_at
         ) VALUES ($1,$2,$3,$4,$5,true,now())
         ON CONFLICT (property_id, buildium_file_id) DO UPDATE SET
           storage_bucket = EXCLUDED.storage_bucket,
           storage_path = EXCLUDED.storage_path,
           content_type = EXCLUDED.content_type,
           synced_at = EXCLUDED.synced_at`,
        [property.id, String(photoImage.id), bucket, storedPath, contentType]
      );
      photosSynced += 1;
    } catch (err) {
      errors.push(
        `Property ${property.id} (Buildium ${buildiumPropertyId}): failed to download/store photo — ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  logInfo("photo sync complete", { photosSynced, errorCount: errors.length });
  return { photosSynced, errors };
}
