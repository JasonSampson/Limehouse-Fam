import { Pool } from "pg";
import { loadEnv } from "../config/env.js";

// Single pool — this project's migrations (0000-0005) define no RLS split
// or separate job/app Postgres roles the way late-rent-notices does, so
// there is nothing to separate here. One DATABASE_URL, one pool.
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
