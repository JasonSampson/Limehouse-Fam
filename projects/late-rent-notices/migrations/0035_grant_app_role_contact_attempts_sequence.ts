import type { MigrationBuilder } from "node-pg-migrate";

// TARS finding: INSERT INTO contact_attempts fails for late_rent_app with
// "permission denied for sequence contact_attempts_id_seq". Same class of
// bug as 0018 — migration 0017's `GRANT USAGE ON ALL SEQUENCES IN SCHEMA
// public` ran before contact_attempts (and its id sequence) existed; it was
// created later in 0024, and no migration since has granted sequence usage
// on it specifically. Table-level SELECT/INSERT was granted in 0027, but
// that doesn't cover the sequence the serial "id" column depends on.
//
// late_rent_job does not need this: 0027 only ever gave it SELECT on
// contact_attempts, and the job (src/jobs/pmReminderCheck.ts) only reads
// from contact_attempts to check overdue payment promises — it never
// inserts into it. The only INSERT path is src/routes/contactAttemptRoutes.ts,
// which runs as late_rent_app.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`GRANT USAGE ON SEQUENCE contact_attempts_id_seq TO late_rent_app;`);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`REVOKE USAGE ON SEQUENCE contact_attempts_id_seq FROM late_rent_app;`);
}
