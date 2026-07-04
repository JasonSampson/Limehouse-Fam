import { config as loadDotenv } from "dotenv";
import { z } from "zod";

// Load .env into process.env exactly once, before validation below. Same
// pattern as limehouse-dashboard/src/config/env.ts — every entry point
// (server.ts, bootstrapAdmin.ts) imports loadEnv(), so this is the single
// chokepoint.
loadDotenv();

// Runtime validation of all environment variables. Fails fast and loudly at
// startup instead of a confusing error three layers deep.
//
// ANTHROPIC_API_KEY is REQUIRED for the chat feature to actually answer
// questions — but the app must still start and serve admin/upload/login
// pages without it (per the "shows as not connected instead of breaking"
// convention). Code on the chat path must check isChatConnected() below and
// return a clear error to the user rather than crash or silently misbehave.
//
// Embeddings (document upload/processing and question search) run fully
// locally via @xenova/transformers — no API key needed for that at all.
const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  PORT: z.coerce.number().int().positive().default(3200),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  // Signs the session cookie. Generate with: openssl rand -hex 32
  SESSION_COOKIE_SECRET: z.string().min(16, "SESSION_COOKIE_SECRET must be at least 16 chars"),

  // Optional at startup, required for chat to answer questions. Used for
  // the answer-generation step (Claude reads the retrieved chunks and
  // writes the plain-language answer with citation).
  ANTHROPIC_API_KEY: z.string().optional(),

  // Where uploaded original files live on disk. Relative paths are resolved
  // from the project root. Must be writable by the process running the app.
  STORAGE_DIR: z.string().default("storage"),
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

// Callers use this instead of checking `env.ANTHROPIC_API_KEY` directly
// throughout the codebase — one place to define what "connected" means (a
// non-empty key), matching the "clean not-connected fallback" convention
// used across this repo's projects.
export function isAnthropicConnected(): boolean {
  const key = loadEnv().ANTHROPIC_API_KEY;
  return typeof key === "string" && key.length > 0;
}

// Chat can only work end-to-end (embed the question, retrieve chunks,
// generate a cited answer) when Anthropic is configured. Embeddings always
// run locally, so they're never a blocker here.
export function isChatConnected(): boolean {
  return isAnthropicConnected();
}

// Test-only helper: allows tests to reset the module-level cache between
// cases that set different process.env values.
export function _resetEnvCacheForTests(): void {
  cachedEnv = undefined;
}
