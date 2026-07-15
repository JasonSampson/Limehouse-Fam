import { config as loadDotenv } from "dotenv";
import { z } from "zod";

// Load .env into process.env exactly once, before validation below. Every
// entry point imports loadEnv()/this module, so this is the single
// chokepoint — same pattern as late-rent-notices and limehouse-dashboard.
loadDotenv();

// Runtime validation of all environment variables — fails fast and loudly
// at startup instead of producing a confusing error three layers deep.
// Minimal on purpose: this is Scotty's scaffolding pass only. Q adds
// whatever this schema still needs (session cookie secret, etc.) once
// Neo's data model and Oracle's auth spec are actually implemented.
const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  PORT: z.coerce.number().int().positive().default(3300),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
});

export type Env = z.infer<typeof envSchema>;

let cachedEnv: Env | undefined;

export function loadEnv(): Env {
  if (!cachedEnv) {
    cachedEnv = envSchema.parse(process.env);
  }
  return cachedEnv;
}
