import type { MigrationBuilder } from "node-pg-migrate";

// Judge review finding: migration 0017 only granted late_rent_job access to
// the tables the *daily lateness calculation* obviously needs, but missed
// three tables src/jobs/dailyLatenessCheck.ts actually reads: the exclusion
// list, the active letter template, and the de minimis config value. Without
// this, the daily job throws "permission denied" on its very first run
// against the real (non-superuser) role — a complete functional break that
// local testing missed because it ran against a superuser connection
// instead of the actual late_rent_job role.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`GRANT SELECT ON exclusions, letter_templates, config_values TO late_rent_job;`);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`REVOKE SELECT ON exclusions, letter_templates, config_values FROM late_rent_job;`);
}
