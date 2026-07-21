import { config as loadDotenv } from "dotenv";
import { z } from "zod";

// Load .env into process.env exactly once, before validation below. Every
// entry point imports loadEnv()/this module.
loadDotenv();

// Runtime validation of all environment variables — fails fast and loudly
// at startup instead of a confusing error three layers deep (same standard
// as late-rent-notices/src/config/env.ts).
const envSchema = z.object({
  // Migration-time connection (elevated privileges — creates roles/grants).
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  // Runtime connection for the daily sync job, using the map_sync_job role
  // created by migration 0010 (BYPASSRLS). Never use this role from a
  // browser-facing app.
  DATABASE_URL_JOB: z.string().min(1, "DATABASE_URL_JOB is required"),

  // --- Supabase Storage (property photos) ---
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  // --- Buildium API ---
  BUILDIUM_CLIENT_ID: z.string().min(1),
  BUILDIUM_CLIENT_SECRET: z.string().min(1),
  BUILDIUM_BASE_URL: z.string().url(),

  // --- RentEngine API (optional — see src/rentengine/sync.ts) ---
  // Blank string ("" — e.g. a .env line present but empty) is treated the
  // same as fully unset, not a validation error. FIXED 2026-07-21: without
  // this, a blank RENTENGINE_BASE_URL crashed the whole app at startup
  // (failed .url()) instead of being treated as "not configured yet",
  // which is exactly the state this pair of vars is meant to represent.
  RENTENGINE_API_KEY: z
    .string()
    .optional()
    .transform((v) => (v === "" ? undefined : v)),
  RENTENGINE_BASE_URL: z
    .union([z.string().url(), z.literal("")])
    .optional()
    .transform((v) => (v === "" ? undefined : v)),

  // --- Google Maps / Geocoding API ---
  GOOGLE_MAPS_API_KEY: z.string().min(1),

  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  JASON_ALERT_EMAIL: z.string().email(),
  TEAMS_ALERT_WEBHOOK_URL: z.string().url("TEAMS_ALERT_WEBHOOK_URL must be a valid webhook URL"),

  // Placeholder pending Jason/Sentinel's confirmation (schema.md). Kept as
  // an env-configurable value, not a hardcoded magic number in the jitter
  // logic itself — see src/config/publicMapJitter.ts.
  PUBLIC_MAP_JITTER_RADIUS_METERS: z.coerce.number().positive().default(200),

  // Set by the entry-point script's `job:sync:now` variant to force a run
  // regardless of scheduled time — useful for manual/on-demand runs and
  // for TARS's test pass. Never set this in the real cron entry.
  MAP_SYNC_FORCE_RUN: z
    .string()
    .default("false")
    .transform((v) => v.toLowerCase() === "true"),
});

export type Env = z.infer<typeof envSchema>;

let cachedEnv: Env | undefined;

export function loadEnv(): Env {
  if (cachedEnv) return cachedEnv;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    // Never log raw process.env (could contain secrets in other vars) —
    // only log the validation issues themselves.
    console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
    throw new Error("Invalid environment configuration. See stderr for details.");
  }
  cachedEnv = parsed.data;
  return cachedEnv;
}
