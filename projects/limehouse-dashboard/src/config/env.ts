import { config as loadDotenv } from "dotenv";
import { z } from "zod";

// Load .env into process.env exactly once, before validation below. Same
// pattern as late-rent-notices/src/config/env.ts — every entry point
// (server.ts, sync jobs) imports loadEnv(), so this is the single
// chokepoint.
loadDotenv();

// Runtime validation of all environment variables. Fails fast and loudly at
// startup instead of a confusing error three layers deep.
//
// RENTENGINE_API_KEY and LEADSIMPLE_API_KEY are deliberately OPTIONAL
// (Jason may not have API access to either yet — see project brief). Code
// that talks to those sources must check isRentEngineConnected() /
// isLeadSimpleConnected() below and fall back to a clean "not connected"
// state rather than assume the key is present.
const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  // Fresh, separate credential from late-rent-notices' Buildium key, so it
  // can be revoked independently (see project brief — "own server, own API
  // keys").
  BUILDIUM_CLIENT_ID: z.string().min(1, "BUILDIUM_CLIENT_ID is required"),
  BUILDIUM_CLIENT_SECRET: z.string().min(1, "BUILDIUM_CLIENT_SECRET is required"),
  BUILDIUM_BASE_URL: z.string().url().default("https://api.buildium.com/v1"),

  // Optional: RentEngine API access may not exist yet for this account.
  // CONFIRMED LIVE 2026-07-03: the real base URL is
  // app.rentengine.io/api/public/v1 — api.rentengine.com/v1 (the previous
  // default here) does not exist and was never actually reachable.
  RENTENGINE_API_KEY: z.string().optional(),
  RENTENGINE_BASE_URL: z.string().url().default("https://app.rentengine.io/api/public/v1"),
  // account_id query param required by /calls and /messages (confirmed
  // live — see src/rentengine/client.ts). Confirmed fixed for this
  // account (29a7815c-08a9-45df-a13a-f75376c95770) across every prospect
  // record checked, but kept as its own optional env var rather than
  // hardcoded in source, in case Jason's RentEngine setup ever spans
  // multiple accounts. If left blank, syncCallActivityForPeriod's caller
  // must derive it from a live prospect record instead of assuming the
  // hardcoded value.
  RENTENGINE_ACCOUNT_ID: z.string().optional(),

  // Optional: LeadSimple API access may not exist yet for this account.
  LEADSIMPLE_API_KEY: z.string().optional(),
  LEADSIMPLE_BASE_URL: z.string().url().default("https://api.leadsimple.com/v1"),

  PORT: z.coerce.number().int().positive().default(3100),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  // Signs the app's own session cookie issued after a successful Microsoft
  // sign-in (see src/auth/session.ts). Not related to Entra itself.
  SESSION_COOKIE_SECRET: z.string().min(16, "SESSION_COOKIE_SECRET must be at least 16 chars"),

  // Shared secret with LimeHQ — used to verify handoff tokens so the dashboard
  // can trust that a login request really came from LimeHQ. Must match
  // HANDOFF_TOKEN_SECRET in LimeHQ's .env exactly.
  LIMEHQ_HANDOFF_SECRET: z.string().min(16, "LIMEHQ_HANDOFF_SECRET must be at least 16 chars"),

  // Where LimeHQ is running — used to redirect unauthenticated users to log in.
  LIMEHQ_URL: z.string().url().default("http://localhost:3300"),
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

// Callers use these instead of checking `env.RENTENGINE_API_KEY` directly
// throughout the codebase — one place to define what "connected" means
// (a non-empty key), matching the "clean not-connected fallback" requirement
// in the project brief.
export function isRentEngineConnected(): boolean {
  const key = loadEnv().RENTENGINE_API_KEY;
  return typeof key === "string" && key.length > 0;
}

export function isLeadSimpleConnected(): boolean {
  const key = loadEnv().LEADSIMPLE_API_KEY;
  return typeof key === "string" && key.length > 0;
}

// Test-only helper: allows tests to reset the module-level cache between
// cases that set different process.env values. Mirrors a common pattern for
// this kind of singleton config loader; not used by production code paths.
export function _resetEnvCacheForTests(): void {
  cachedEnv = undefined;
}
