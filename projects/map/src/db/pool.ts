import { Pool } from "pg";
import { loadEnv } from "../config/env.js";

// Single pool, matching the map_sync_job role from migration 0010
// (BYPASSRLS). This project builds the sync job only — no staff-facing app
// yet (Tron's build, next), so there's no second "app pool" here the way
// late-rent-notices has appPool + jobPool. When the staff app is built, it
// gets its own pool using the map_staff_app role; never reuse this one.
let jobPool: Pool | undefined;

export function getJobPool(): Pool {
  if (!jobPool) {
    const env = loadEnv();
    jobPool = new Pool({ connectionString: env.DATABASE_URL_JOB });
  }
  return jobPool;
}

export async function closePools(): Promise<void> {
  await jobPool?.end();
}
