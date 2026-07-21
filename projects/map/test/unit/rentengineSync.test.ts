import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { Pool } from "pg";

const ORIGINAL_ENV = { ...process.env };

function setRequiredEnvDefaults() {
  process.env.DATABASE_URL = "postgres://example/test";
  process.env.DATABASE_URL_JOB = "postgres://example/test";
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
  process.env.BUILDIUM_CLIENT_ID = "test-id";
  process.env.BUILDIUM_CLIENT_SECRET = "test-secret";
  process.env.BUILDIUM_BASE_URL = "https://api.buildium.com/v1";
  process.env.GOOGLE_MAPS_API_KEY = "test-key";
  process.env.JASON_ALERT_EMAIL = "jason@limehousepm.com";
  process.env.TEAMS_ALERT_WEBHOOK_URL = "https://example.com/webhook";
  delete process.env.RENTENGINE_API_KEY;
  delete process.env.RENTENGINE_BASE_URL;
}

describe("syncVacantUnitAskingRents (documented stub)", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    setRequiredEnvDefaults();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("reports configured:false with a clear note when no RentEngine credentials are set", async () => {
    // Fresh dynamic import each test so env.ts's module-level cache doesn't
    // leak a config from a previous test in the same file.
    const { loadEnv } = await import("../../src/config/env.js?t=" + Date.now());
    loadEnv();
    const { syncVacantUnitAskingRents } = await import("../../src/rentengine/sync.js?t=" + Date.now());

    const result = await syncVacantUnitAskingRents(null as unknown as Pool);
    expect(result.configured).toBe(false);
    expect(result.listingsSynced).toBe(0);
    expect(result.note).toContain("RentEngine");
    expect(result.note.length).toBeGreaterThan(0);
  });
});
