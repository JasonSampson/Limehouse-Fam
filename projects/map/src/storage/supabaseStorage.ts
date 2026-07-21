import { createClient } from "@supabase/supabase-js";
import { loadEnv } from "../config/env.js";

const DEFAULT_BUCKET = "property-photos";

let client: ReturnType<typeof createClient> | undefined;

function getClient() {
  if (!client) {
    const env = loadEnv();
    // Service role key, never exposed to a browser — this is a
    // server-only sync job. Storage is a separate Supabase REST API, not
    // reachable through the plain Postgres connection used elsewhere in
    // this project, which is why this needs its own client/credential.
    client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  }
  return client;
}

// Uploads a photo's bytes to Supabase Storage and returns the bucket/path
// pair stored on property_photos. Overwrites an existing object at the
// same path (upsert) so re-running the sync for an unchanged photo is a
// safe no-op rather than an error.
export async function uploadPropertyPhoto(
  path: string,
  bytes: Buffer,
  contentType: string | null,
  bucket: string = DEFAULT_BUCKET
): Promise<{ bucket: string; path: string }> {
  const { error } = await getClient()
    .storage.from(bucket)
    .upload(path, bytes, { contentType: contentType ?? undefined, upsert: true });
  if (error) {
    throw new Error(`Supabase Storage upload failed for ${bucket}/${path}: ${error.message}`);
  }
  return { bucket, path };
}
