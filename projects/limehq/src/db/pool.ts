import pg from "pg";
import { loadEnv } from "../config/env.js";

let pool: pg.Pool | undefined;

export function getAppPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({ connectionString: loadEnv().DATABASE_URL });
  }
  return pool;
}
