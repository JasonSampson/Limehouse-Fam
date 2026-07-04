import { config as loadDotenv } from "dotenv";
import { z } from "zod";

// Load .env into process.env exactly once, before validation below. Every
// entry point (server.ts, the job run*.ts scripts, seedLetterTemplate.ts)
// imports loadEnv()/this module, so this is the single chokepoint — without
// it, .env is never actually read and every entry point fails validation
// immediately on startup despite a correctly-filled-in .env file on disk.
loadDotenv();

// Runtime validation of all environment variables (GOVERNANCE.md Coding
// Standards: "Runtime validation for configs"). Fails fast and loudly at
// startup instead of producing a confusing error three layers deep.
const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  DATABASE_URL_JOB: z.string().min(1, "DATABASE_URL_JOB is required"),

  BUILDIUM_CLIENT_ID: z.string().min(1),
  BUILDIUM_CLIENT_SECRET: z.string().min(1),
  BUILDIUM_BASE_URL: z.string().url(),

  ENTRA_TENANT_ID: z.string().min(1),
  ENTRA_CLIENT_ID: z.string().min(1),
  ENTRA_CLIENT_SECRET: z.string().min(1),
  ENTRA_REDIRECT_URI: z.string().url(),

  GRAPH_TENANT_ID: z.string().min(1),
  GRAPH_CLIENT_ID: z.string().min(1),
  GRAPH_CLIENT_SECRET: z.string().min(1),
  GRAPH_SENDER_MAILBOX: z.string().email(),

  PORT: z.coerce.number().int().positive().default(3000),
  SESSION_COOKIE_SECRET: z.string().min(16, "SESSION_COOKIE_SECRET must be at least 16 chars"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  // Default true: shadow mode is the required starting state per the plan.
  // Flipping this requires an explicit, separate decision later — it must
  // never be possible to "accidentally" end up in live mode by omission.
  SHADOW_MODE: z
    .string()
    .default("true")
    .transform((v) => v.toLowerCase() !== "false"),

  JASON_ALERT_EMAIL: z.string().email(),

  // Optional. Path to a Chrome/Chromium executable used by
  // generateNoticePdf.ts (puppeteer-core drives this browser to render the
  // print HTML into a PDF — see that file's doc comment for why puppeteer-
  // core, not full puppeteer, was chosen). If unset, generateNoticePdf.ts
  // falls back to a short list of common install paths for the current OS.
  // Only needs to be set explicitly if Chrome is installed somewhere
  // non-standard (e.g. a locked-down server image) — Scotty should confirm
  // this at deploy time.
  CHROME_EXECUTABLE_PATH: z.string().optional(),

  // Job-failure alerts go to a Microsoft Teams channel via an incoming
  // webhook (Jason's choice — kept independent of the Graph mailbox used
  // for tenant notices, so a Graph outage can't also silence the alert
  // about something being wrong). Create one in Teams: channel -> Connectors
  // (or Workflows, depending on tenant) -> Incoming Webhook -> copy the URL.
  TEAMS_ALERT_WEBHOOK_URL: z.string().url("TEAMS_ALERT_WEBHOOK_URL must be a valid webhook URL"),
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
