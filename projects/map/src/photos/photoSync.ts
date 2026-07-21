import type { Pool } from "pg";
import {
  fetchPropertyImages,
  fetchUnitImages,
  downloadPropertyImage,
  downloadUnitImage,
  contentTypeFromFileName,
  isRealUploadedPhoto,
  type BuildiumPropertyImage,
} from "../buildium/client.js";
import { uploadPropertyPhoto } from "../storage/supabaseStorage.js";
import { logInfo } from "../lib/appLogger.js";

export interface PhotoSyncResult {
  photosSynced: number;
  errors: string[];
}

// CONFIRMED LIVE (2026-07-21): Buildium photos actually live at the UNIT
// level almost all the time — the property-level endpoint alone only ever
// found a photo for 20 of 196 real properties, while unit-level photos
// exist for the overwhelming majority of real units checked (10/10 sampled,
// consistent with a separate 24/25 sample). Property-level and unit-level
// photos are NOT mutually exclusive (both can have separate uploads for the
// same real property), so both must be checked — this is additive, not a
// replacement of the old property-level check.
export type PrimaryPhotoCandidate =
  | { source: "unit"; buildiumUnitId: number; photo: BuildiumPropertyImage }
  | { source: "property"; photo: BuildiumPropertyImage };

// A property can have multiple units, each with its own photos. Order:
// unitPhotoLists must be in the same order the property's units should be
// considered in (this sync uses ascending `units.id`, i.e. sync order —
// there's no Buildium-side concept of a "primary unit" to key off of, so
// this is simply a stable, deterministic choice, documented here rather
// than left implicit).
//
// Precedence for which single photo represents the property's map pin,
// decided and documented here (schema.md's "photo-per-property, not
// photo-per-unit, for v1" note already anticipated needing this call):
//   1. The first unit (in the given order) that has a photo marked
//      ShowInListing — a unit photo is the actual interior/exterior of a
//      real rentable unit, which is more useful on a property pin than a
//      generic property-level shot, and ShowInListing is Buildium's own
//      "this is the public listing photo" signal.
//   2. Else the property-level ShowInListing photo, if the property itself
//      has one.
//   3. Else the first real photo found at all, checking units (in order)
//      before the property-level list — since unit-level is where photos
//      actually live for this portfolio, it's the more likely place to find
//      *something* even without a ShowInListing flag.
export function selectPrimaryPhoto(
  unitPhotoLists: Array<{ buildiumUnitId: number; photos: BuildiumPropertyImage[] }>,
  propertyPhotos: BuildiumPropertyImage[]
): PrimaryPhotoCandidate | null {
  for (const { buildiumUnitId, photos } of unitPhotoLists) {
    const shown = photos.find((p) => p.showInListing);
    if (shown) return { source: "unit", buildiumUnitId, photo: shown };
  }

  const propertyShown = propertyPhotos.find((p) => p.showInListing);
  if (propertyShown) return { source: "property", photo: propertyShown };

  for (const { buildiumUnitId, photos } of unitPhotoLists) {
    if (photos[0]) return { source: "unit", buildiumUnitId, photo: photos[0] };
  }

  if (propertyPhotos[0]) return { source: "property", photo: propertyPhotos[0] };

  return null;
}

function fileExtensionFromContentType(contentType: string | null): string {
  if (!contentType) return "jpg";
  const match = contentType.match(/^image\/(\w+)/);
  return match ? match[1] : "jpg";
}

// Downloads and stores the primary photo for every active property — never
// hot-links a Buildium URL (spec Section 4 / Risk #1). Placeholder handling
// for properties with zero usable photos is a display-layer concern for
// Tron, not this job's problem (schema.md).
//
// FIXED 2026-07-21 (TARS found this live, real data): this used to only
// query properties with NO primary photo row yet (`NOT EXISTS ... is_primary`).
// That guard meant the exact properties that had a stale, property-level-only
// photo stored *before* the unit-first precedence fix above ever shipped
// would never be looked at again — they already "have a primary photo" per
// that clause, forever, even though selectPrimaryPhoto() would now pick a
// different (correct) photo for them. Confirmed live: 20 real properties
// (e.g. property 94, 5509 Lynbrook Landing) whose stored primary did not
// match what selectPrimaryPhoto() actually returns for current data.
//
// Fix: evaluate every active property against current Buildium data every
// run (no property is ever skipped from evaluation), but only pay for the
// expensive part — downloading the image and re-uploading it to Storage —
// when the winning photo's Buildium file id actually differs from what's
// already stored. The listing calls (fetchPropertyImages/fetchUnitImages)
// are cheap metadata GETs already made for every property this job touches
// today; running them for all ~196 properties instead of a subset is not a
// meaningful added load given the client's existing rate-limit retry
// handling, so there's no need for a separate "did anything change"
// short-circuit before even listing.
export async function syncPropertyPhotos(jobPool: Pool): Promise<PhotoSyncResult> {
  const errors: string[] = [];
  let photosSynced = 0;

  const properties = await jobPool.query<{
    id: number;
    buildium_property_id: string;
    current_primary_file_id: string | null;
  }>(
    `SELECT p.id, p.buildium_property_id, pp.buildium_file_id AS current_primary_file_id
     FROM properties p
     LEFT JOIN property_photos pp ON pp.property_id = p.id AND pp.is_primary
     WHERE p.is_active = true`
  );

  for (const property of properties.rows) {
    const buildiumPropertyId = Number(property.buildium_property_id);

    // Units for this property were already synced earlier in the same daily
    // run (buildium_sync runs before photo_sync — runDailyMapSync.ts), so
    // this is a plain DB read, not another Buildium round trip. Ordered by
    // `id` (sync order) for a stable, documented tie-break — see
    // selectPrimaryPhoto's comment.
    const units = await jobPool.query<{ buildium_unit_id: string }>(
      `SELECT buildium_unit_id FROM units WHERE property_id = $1 ORDER BY id`,
      [property.id]
    );

    let propertyImages;
    try {
      propertyImages = await fetchPropertyImages(buildiumPropertyId);
    } catch (err) {
      errors.push(
        `Property ${property.id} (Buildium ${buildiumPropertyId}): failed to list property-level images — ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      continue;
    }

    // CORRECTED 2026-07-21, per Jason directly: this endpoint's list can
    // include externally-hosted VIDEOS (Provider != "None", e.g. YouTube)
    // alongside real uploaded photos — confirmed live on property 348401,
    // whose YouTube walkthrough had ShowInListing=true and was being
    // silently mistaken for the featured photo. Filter those out before
    // selectPrimaryPhoto ever sees the list — a video entry must never be
    // selected, regardless of its ShowInListing flag. Same filter applies
    // to unit-level results below (CONFIRMED LIVE 2026-07-21: photos live
    // at the unit level almost all the time — see fetchUnitImages in
    // client.ts — but there's no live evidence video entries are unit-level
    // only vs property-level only, so the same defensive filter applies to
    // both rather than assuming one scope is video-free).
    const realPropertyPhotos = propertyImages.filter(isRealUploadedPhoto);

    const unitPhotoLists: Array<{ buildiumUnitId: number; photos: typeof realPropertyPhotos }> = [];
    let unitFetchErrored = false;
    for (const unitRow of units.rows) {
      const buildiumUnitId = Number(unitRow.buildium_unit_id);
      try {
        const unitImages = await fetchUnitImages(buildiumUnitId);
        unitPhotoLists.push({ buildiumUnitId, photos: unitImages.filter(isRealUploadedPhoto) });
      } catch (err) {
        unitFetchErrored = true;
        errors.push(
          `Property ${property.id} (Buildium ${buildiumPropertyId}), unit ${buildiumUnitId}: failed to list unit-level images — ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }

    const primary = selectPrimaryPhoto(unitPhotoLists, realPropertyPhotos);
    if (!primary) {
      // No real (non-video) photos found at either scope for this property,
      // per current Buildium data. If a unit fetch errored above, this could
      // technically be a false "no photos" (a real photo might exist on the
      // unit that failed to list) — the pushed error above already surfaces
      // that distinctly, so leave any existing stored primary alone rather
      // than clearing it on incomplete data; it'll be re-evaluated on the
      // next run. Otherwise (a clean, complete look that really found
      // nothing) clear any stale primary this property had, since it no
      // longer reflects a real photo Buildium has — same "always re-evaluate
      // against current data" principle as the changed-photo case below.
      if (!unitFetchErrored && property.current_primary_file_id !== null) {
        await jobPool.query(`UPDATE property_photos SET is_primary = false WHERE property_id = $1 AND is_primary`, [
          property.id,
        ]);
      }
      continue;
    }

    const winningFileId = String(primary.photo.id);
    if (winningFileId === property.current_primary_file_id) {
      // Already correct — selectPrimaryPhoto's winner is exactly what's
      // already stored as primary for this property. Skip the network
      // download/upload entirely so a fix for stale data doesn't cause
      // churn/re-downloads for properties that were already right.
      continue;
    }

    try {
      const { bytes, contentType: downloadedContentType } =
        primary.source === "unit"
          ? await downloadUnitImage(primary.buildiumUnitId, primary.photo.id)
          : await downloadPropertyImage(buildiumPropertyId, primary.photo.id);
      const contentType = downloadedContentType ?? contentTypeFromFileName(primary.photo.fileName);
      const extension = fileExtensionFromContentType(contentType);
      const path = `${property.id}/${primary.photo.id}.${extension}`;
      const { bucket, path: storedPath } = await uploadPropertyPhoto(path, bytes, contentType);

      // The new winner may be a different Buildium file than whatever is
      // currently marked primary (e.g. switching from an old property-level
      // photo to a unit's real ShowInListing photo) — unset the old primary
      // flag first so the upsert below never tries to have two is_primary
      // rows for the same property at once (blocked by the partial unique
      // index; see migration 0005). Scoped to `!= $2` so re-syncing the
      // exact same winning file (the common case, content refresh only)
      // doesn't unset-then-reset the very row being upserted.
      await jobPool.query(
        `UPDATE property_photos SET is_primary = false
         WHERE property_id = $1 AND is_primary AND buildium_file_id != $2`,
        [property.id, String(primary.photo.id)]
      );

      await jobPool.query(
        `INSERT INTO property_photos (
           property_id, buildium_file_id, storage_bucket, storage_path, content_type, is_primary, synced_at
         ) VALUES ($1,$2,$3,$4,$5,true,now())
         ON CONFLICT (property_id, buildium_file_id) DO UPDATE SET
           storage_bucket = EXCLUDED.storage_bucket,
           storage_path = EXCLUDED.storage_path,
           content_type = EXCLUDED.content_type,
           is_primary = true,
           synced_at = EXCLUDED.synced_at`,
        [property.id, String(primary.photo.id), bucket, storedPath, contentType]
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
