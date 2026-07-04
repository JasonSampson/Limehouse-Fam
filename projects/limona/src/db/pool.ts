import { Pool } from "pg";
import { loadEnv } from "../config/env.js";

// Single pool — this project owns a standalone database, so there is
// nothing to separate here (matches limehouse-dashboard/src/db/pool.ts).
let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    const env = loadEnv();
    pool = new Pool({ connectionString: env.DATABASE_URL });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}
