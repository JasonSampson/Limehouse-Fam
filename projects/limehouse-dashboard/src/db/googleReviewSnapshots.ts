import { getPool } from "./pool.js";

export interface GoogleReviewSnapshot {
  snapshotDate: string; // "YYYY-MM-DD"
  rating: number;
  reviewCount: number;
}

function toSnapshot(row: { snapshot_date: string; rating: string; review_count: number }): GoogleReviewSnapshot {
  return {
    snapshotDate: row.snapshot_date,
    rating: Number(row.rating),
    reviewCount: row.review_count,
  };
}

// One row per day — the sync job calls this every time it runs (scheduled
// interval or manual "Sync Now"), so a day with multiple runs just keeps
// overwriting today's row with the latest number instead of accumulating
// duplicates.
export async function upsertTodaySnapshot(rating: number, reviewCount: number): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO dashboard_google_review_snapshots (snapshot_date, rating, review_count)
     VALUES (CURRENT_DATE, $1, $2)
     ON CONFLICT (snapshot_date) DO UPDATE
       SET rating = EXCLUDED.rating, review_count = EXCLUDED.review_count`,
    [rating, reviewCount]
  );
}

export async function getLatestSnapshot(): Promise<GoogleReviewSnapshot | null> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT snapshot_date, rating, review_count FROM dashboard_google_review_snapshots
     ORDER BY snapshot_date DESC LIMIT 1`
  );
  return rows[0] ? toSnapshot(rows[0]) : null;
}

// Nearest snapshot AT OR BEFORE a given date — used to compute "new reviews
// this period" as latest.reviewCount - snapshotOnOrBefore(periodStart).reviewCount.
// Returns null if tracking hadn't started yet as of that date (e.g. any
// period before this feature shipped), which callers must treat as "unknown"
// rather than assuming zero new reviews.
export async function getSnapshotOnOrBefore(dateStr: string): Promise<GoogleReviewSnapshot | null> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT snapshot_date, rating, review_count FROM dashboard_google_review_snapshots
     WHERE snapshot_date <= $1
     ORDER BY snapshot_date DESC LIMIT 1`,
    [dateStr]
  );
  return rows[0] ? toSnapshot(rows[0]) : null;
}
