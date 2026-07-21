import { config as loadDotenv } from "dotenv";
import { z } from "zod";

loadDotenv();

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  PORT: z.coerce.number().int().positive().default(3300),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  // Session cookie signing secret. Must be at least 32 characters.
  SESSION_COOKIE_SECRET: z.string().min(32, "SESSION_COOKIE_SECRET must be at least 32 characters"),

  // Separate secret for short-lived handoff tokens issued to target apps.
  // Must differ from SESSION_COOKIE_SECRET so a compromised handoff token
  // cannot be replayed as a session cookie.
  HANDOFF_TOKEN_SECRET: z.string().min(32, "HANDOFF_TOKEN_SECRET must be at least 32 characters"),

  // Target app base URLs for the handoff redirect. Optional — the handoff
  // route returns 503 for any app whose URL is not configured.
  // Empty string is treated the same as absent (undefined).
  LATE_RENT_NOTICES_URL: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().url().optional(),
  ),
  DASHBOARD_URL: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().url().optional(),
  ),
  LIMONA_URL: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().url().optional(),
  ),

  // --- Map module ---
  // Map's tables live in the shared Supabase project's `map`/`map_public`
  // schemas (see Limehouse-Fam/projects/map/docs/schema.md), isolated from
  // LimeHQ's own `public` schema tables. LimeHQ's normal DATABASE_URL/
  // getAppPool() connects as a role with no grants on `map` at all (by
  // design — see that schema's two-way fence), so Map's routes need a
  // second, separate pool connecting as the `map_staff_app` role created by
  // that project's migration 0010_create_roles_and_grants.ts. Optional here
  // so a LimeHQ dev environment without Map configured doesn't fail to
  // boot — src/map/mapRoutes.ts shows a clear "not configured" state
  // instead of crashing when this is unset.
  MAP_DATABASE_URL: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().optional(),
  ),

  // Google Maps JavaScript API key, loaded in the browser for the internal
  // map page (Maps JS + Places + drawing libraries). Same vendor/key concept
  // as Limehouse-Fam/projects/map/.env's GOOGLE_MAPS_API_KEY (Jason's
  // decided vendor, spec Section 3) — Maps JS keys are meant to be visible
  // in browser page source by design; they're restricted by HTTP-referrer
  // allowlisting in Google Cloud Console, not by secrecy. Confirm with
  // Scotty that this specific key (or a browser-restricted copy of it) has
  // limehq's real domain on its referrer allowlist before this goes live.
  GOOGLE_MAPS_API_KEY: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().optional(),
  ),

  // --- Supabase Storage (Map property photos) ---
  // Used only to mint short-lived signed URLs for property photos stored in
  // the `property-photos` bucket (see Limehouse-Fam/projects/map/src/
  // storage/supabaseStorage.ts, which uploads them during the sync job).
  // SUPABASE_SERVICE_ROLE_KEY must never be sent to the browser — it is
  // used only in src/map/photoUrls.ts, server-side, to call Supabase
  // Storage's sign-URL endpoint; the browser only ever receives the
  // resulting short-lived signed URL, never this key itself.
  SUPABASE_URL: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().url().optional(),
  ),
  SUPABASE_SERVICE_ROLE_KEY: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().optional(),
  ),
});

export type Env = z.infer<typeof envSchema>;

let cachedEnv: Env | undefined;

export function loadEnv(): Env {
  if (!cachedEnv) {
    cachedEnv = envSchema.parse(process.env);
  }
  return cachedEnv;
}
