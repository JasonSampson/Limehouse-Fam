import type { MigrationBuilder } from "node-pg-migrate";

// Found live on 2026-08-04, the first morning real notices qualified: the
// daily job drafted all 11 notices but every one failed inserting its
// notice_recipients rows with "permission denied". Migration 0017's
// jobTables grant list includes notices but NOT notice_recipients, even
// though dailyLatenessCheck.ts has always inserted recipients right after
// drafting — the local dev database happened to have a wider grant applied
// during early setup, which masked the gap until the first production run.
// SELECT + INSERT only, matching the job's actual usage (delivery-status
// UPDATEs on recipients happen in sendNotice.ts under the app role).
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`GRANT SELECT, INSERT ON notice_recipients TO late_rent_job;`);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`REVOKE SELECT, INSERT ON notice_recipients FROM late_rent_job;`);
}
