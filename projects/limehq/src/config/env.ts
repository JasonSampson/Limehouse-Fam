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
});

export type Env = z.infer<typeof envSchema>;

let cachedEnv: Env | undefined;

export function loadEnv(): Env {
  if (!cachedEnv) {
    cachedEnv = envSchema.parse(process.env);
  }
  return cachedEnv;
}
