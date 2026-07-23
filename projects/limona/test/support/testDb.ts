import { config as loadDotenv } from "dotenv";
import fs from "node:fs";
import { Pool } from "pg";
import path from "node:path";
import { fileURLToPath } from "node:url";

// DB integration test support. Loads .env.test (a separate file from .env)
// so these tests never accidentally run against Jason's real database —
// point .env.test at a disposable test Postgres database with the pgvector
// extension available.
//
// INCIDENT (2026-07-03): .env.test didn't exist, and dotenv's loadDotenv()
// silently no-ops when the target file is missing — it does NOT throw. That
// let process.env.DATABASE_URL fall through to whatever was already set by
// the real .env (loaded earlier in the same process), and `npm run test:db`
// truncated the real production database. The check below makes a missing
// .env.test a hard, immediate failure instead of a silent no-op, and
// requireTestDatabaseUrl() below adds a second, independent guard right
// before any destructive SQL runs.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envTestPath = path.resolve(__dirname, "../../.env.test");

if (!fs.existsSync(envTestPath)) {
  throw new Error(
    `DB integration tests require a .env.test file at ${envTestPath}, and it does not exist. ` +
      `Copy .env.test.example to .env.test and point it at a disposable test Postgres database ` +
      `(never your real one). Refusing to continue — without this file, DATABASE_URL could silently ` +
      `fall through to whatever's already in process.env (e.g. the real .env), which previously caused ` +
      `the production database to be wiped. See README.md "Running the tests".`
  );
}

// override: true so .env.test always wins over anything the real .env
// already put in process.env earlier in this process — DB tests must never
// inherit an ambient DATABASE_URL from another env file.
loadDotenv({ path: envTestPath, override: true });

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. DB integration tests require a .env.test file pointing at a disposable, ` +
        `already-migrated (npm run migrate:up) test Postgres database with the pgvector extension enabled.`
    );
  }
  return value;
}

// Hard, enforced guard — not a comment or convention. Refuses to hand back a
// connection string for any destructive operation unless it clearly points
// at a disposable test database: the connection string (which includes the
// database name) must contain "test" (case-insensitive). This is deliberately
// strict — e.g. Supabase/Neon connection strings where the database name is
// just "postgres" will (correctly) fail this check and must be pointed at a
// differently-named database instead.
function requireTestDatabaseUrl(): string {
  const url = requiredEnv("DATABASE_URL");
  if (!/test/i.test(url)) {
    throw new Error(
      `Refusing to run: DATABASE_URL does not look like a test database (must contain "test", ` +
        `case-insensitive, e.g. in the database name). This guard exists because a real production ` +
        `database was previously truncated by this test suite. If this really is a disposable test ` +
        `database, rename it to include "test" and update .env.test.`
    );
  }
  return url;
}

let pool: Pool | undefined;

export function getTestPool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
  }
  return pool;
}

export async function closeTestPool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

// Wipes all app tables so each test file starts from a clean slate.
// document_categories is NOT truncated — it's a fixed, migration-seeded
// lookup table (1-7), not test fixture data.
//
// Re-checks requireTestDatabaseUrl() here too (not just in getTestPool())
// so this destructive call can never run against a non-test database even
// if getTestPool() is ever refactored to cache a pool created another way.
export async function truncateAllTables(): Promise<void> {
  requireTestDatabaseUrl();
  const testPool = getTestPool();

  // LimeHQ's shared "users" table (id, email, display_name) lives in the
  // real Supabase database alongside Limona's own tables, but this
  // disposable test container only has Limona's own migrated schema (that
  // table was dropped from Limona's own migrations in 0009_drop_users.ts).
  // Admin routes that JOIN against it read-only (e.g. reporting's asked_by
  // name lookup) still need something to join against in tests, so a
  // minimal stand-in is created here. test/support/testAuth.ts populates
  // rows in it as part of the real LimeHQ-handoff login flow.
  await testPool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id integer PRIMARY KEY,
      email text NOT NULL,
      display_name text
    )
  `);

  await testPool.query(`
    TRUNCATE TABLE chat_queries, document_chunks, documents, assets, team_knowledge, users
    RESTART IDENTITY CASCADE;
  `);
}
