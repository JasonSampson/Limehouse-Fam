import { config as loadDotenv } from "dotenv";
import { Pool, type PoolClient } from "pg";
import path from "node:path";
import { fileURLToPath } from "node:url";

// DB integration test support. Deliberately does NOT go through
// src/config/env.ts's loadEnv() — that schema requires Buildium/Entra/Graph/
// Teams secrets that have nothing to do with a DB-only test run, and would
// force every DB test file to fake out unrelated config just to boot. This
// loads only the 3 Postgres connection strings straight out of .env.test.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.resolve(__dirname, "../../.env.test") });

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. DB integration tests require .env.test (see docstring at top of this file) ` +
        `and the late_rent_notices_test_pg Docker container running on port 55432. ` +
        `Check with: docker ps --filter name=late_rent_notices_test_pg`
    );
  }
  return value;
}

// Mirrors src/db/pool.ts's two-role split (late_rent_app subject to RLS,
// late_rent_job BYPASSRLS), plus a superuser pool for test setup/teardown
// only (truncating tables between tests, seeding config_values with
// arbitrary set_by_pm_id references, etc.) — never used to exercise
// application behavior itself.
let appPool: Pool | undefined;
let jobPool: Pool | undefined;
let superuserPool: Pool | undefined;

export function getTestAppPool(): Pool {
  if (!appPool) {
    appPool = new Pool({ connectionString: requiredEnv("DATABASE_URL") });
  }
  return appPool;
}

export function getTestJobPool(): Pool {
  if (!jobPool) {
    jobPool = new Pool({ connectionString: requiredEnv("DATABASE_URL_JOB") });
  }
  return jobPool;
}

export function getTestSuperuserPool(): Pool {
  if (!superuserPool) {
    superuserPool = new Pool({ connectionString: requiredEnv("DATABASE_URL_SUPERUSER") });
  }
  return superuserPool;
}

export async function closeAllTestPools(): Promise<void> {
  await Promise.all([appPool?.end(), jobPool?.end(), superuserPool?.end()]);
  appPool = undefined;
  jobPool = undefined;
  superuserPool = undefined;
}

// Test-only equivalent of src/db/withPmScope.ts, but lets a test set
// app.pm_role explicitly and directly (rather than looking it up from a
// pm_users row) so RLS behavior can be exercised for pm / admin_assistant /
// bookkeeping without needing withPmScope's production lookup semantics.
// Runs on the late_rent_app pool (RLS-subject role), matching what the real
// web app connects as.
export async function withTestPmScope<T>(
  opts: { pmUserId: number | null; pmRole: string; isFallbackDecisionMaker?: boolean },
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const pool = getTestAppPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_pm_id', $1, true)", [
      opts.pmUserId === null ? "" : String(opts.pmUserId),
    ]);
    await client.query("SELECT set_config('app.pm_role', $1, true)", [opts.pmRole]);
    await client.query("SELECT set_config('app.is_fallback_decision_maker', $1, true)", [
      String(opts.isFallbackDecisionMaker ?? false),
    ]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Wipes all app tables (superuser connection, TRUNCATE ... CASCADE bypasses
// RLS and FK ordering concerns) so each test file starts from a clean slate.
// Sequences are restarted too, so seeded IDs are predictable across runs.
export async function truncateAllTables(): Promise<void> {
  const pool = getTestSuperuserPool();
  await pool.query(`
    TRUNCATE TABLE
      audit_log, contact_attempts, escalation_reminders, fallback_events,
      notice_recipients, notices, late_cycles, exclusions, lease_tenants,
      leases, config_values, letter_templates, pm_property_assignments,
      properties, pm_users
    RESTART IDENTITY CASCADE;
  `);
}
