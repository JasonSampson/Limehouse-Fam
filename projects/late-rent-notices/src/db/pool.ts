import { Pool } from "pg";
import { loadEnv } from "../config/env.js";

// Two separate pools, matching the two Postgres roles from migration 0017:
//   appPool — late_rent_app, subject to RLS, used by the web/dashboard.
//   jobPool — late_rent_job, BYPASSRLS, used only by the cron jobs that
//             must see every lease company-wide.
// Never use jobPool from a PM-facing request handler.
let appPool: Pool | undefined;
let jobPool: Pool | undefined;

export function getAppPool(): Pool {
  if (!appPool) {
    const env = loadEnv();
    appPool = new Pool({ connectionString: env.DATABASE_URL });
  }
  return appPool;
}

export function getJobPool(): Pool {
  if (!jobPool) {
    const env = loadEnv();
    jobPool = new Pool({ connectionString: env.DATABASE_URL_JOB });
  }
  return jobPool;
}

export async function closePools(): Promise<void> {
  await Promise.all([appPool?.end(), jobPool?.end()]);
}
