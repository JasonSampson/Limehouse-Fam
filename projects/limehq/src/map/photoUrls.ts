import { loadEnv } from "../config/env.js";
import { logWarn } from "../lib/appLogger.js";

// Property photos are synced into Supabase Storage's `property-photos`
// bucket (never hot-linked from Buildium — see Limehouse-Fam/projects/map/
// src/storage/supabaseStorage.ts). This file mints short-lived *signed*
// URLs server-side using the service role key, rather than making the
// bucket public — least-privilege by default, since we already have this
// data behind LimeHQ's own session/permission gate anyway. The service role
// key itself never reaches the browser; only the resulting time-limited
// signed URL does.
//
// No @supabase/supabase-js dependency added to this project just for this —
// Supabase Storage's sign endpoint is one small REST call, and pulling in
// the full JS SDK for a single POST felt like more surface area than this
// needed (Tron's "simple over beautiful" standing instruction).

const SIGN_URL_TTL_SECONDS = 60 * 60; // 1 hour — long enough for one map session

interface SignedUrlResult {
  path: string;
  signedURL?: string;
  error?: string;
}

/**
 * Batch-signs a list of {bucket, path} pairs (all assumed to share the same
 * bucket, which is true for Map's photos today — one bucket,
 * `property-photos`). Returns a Map from path -> full signed URL for
 * whichever ones succeeded; missing/errored entries are simply absent from
 * the result so callers fall back to the "photo not available" placeholder
 * rather than showing a broken image.
 */
export async function getSignedPhotoUrls(
  bucket: string,
  paths: string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (paths.length === 0) return result;

  const env = loadEnv();
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    logWarn("photoUrls: SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not configured; showing placeholders", {
      photoCount: paths.length,
    });
    return result;
  }

  try {
    const res = await fetch(
      `${env.SUPABASE_URL}/storage/v1/object/sign/${encodeURIComponent(bucket)}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        },
        body: JSON.stringify({ expiresIn: SIGN_URL_TTL_SECONDS, paths }),
      },
    );

    if (!res.ok) {
      logWarn("photoUrls: Supabase Storage sign request failed", { status: res.status });
      return result;
    }

    const body = (await res.json()) as SignedUrlResult[];
    for (const entry of body) {
      if (entry.signedURL) {
        // Supabase returns a relative path (e.g. "/object/sign/...token=...");
        // prefix with the storage host to get a directly-loadable <img src>.
        result.set(entry.path, `${env.SUPABASE_URL}/storage/v1${entry.signedURL}`);
      }
    }
  } catch (err) {
    logWarn("photoUrls: Supabase Storage sign request threw", { error: String(err) });
  }

  return result;
}
