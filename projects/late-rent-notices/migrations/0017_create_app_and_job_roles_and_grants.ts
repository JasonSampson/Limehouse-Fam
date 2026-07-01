import type { MigrationBuilder } from "node-pg-migrate";

// Two runtime roles:
//   late_rent_app — the web app / dashboard. Subject to RLS. Never gets
//                    UPDATE/DELETE/TRUNCATE on audit_log, never BYPASSRLS.
//   late_rent_job — the daily/escalation/reminder cron jobs. Must see every
//                    lease company-wide to compute lateness, so it bypasses
//                    per-PM RLS — but still has no DELETE/TRUNCATE rights
//                    anywhere and the same INSERT-only audit_log grant.
//
// Actual role passwords are set by Scotty at deploy time (see README
// "Deployment notes") — this migration creates the roles with placeholder
// passwords that must be rotated before any real credential is used.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'late_rent_app') THEN
        CREATE ROLE late_rent_app LOGIN PASSWORD 'CHANGE_ME_AT_DEPLOY';
      END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'late_rent_job') THEN
        CREATE ROLE late_rent_job LOGIN PASSWORD 'CHANGE_ME_AT_DEPLOY';
      END IF;
    END
    $$;
  `);

  pgm.sql(`ALTER ROLE late_rent_job BYPASSRLS;`);

  const appCrudTables = [
    "properties",
    "pm_users",
    "pm_property_assignments",
    "leases",
    "lease_tenants",
    "exclusions",
    "letter_templates",
    "config_values",
    "late_cycles",
    "notices",
    "notice_recipients",
    "fallback_events",
    "escalation_reminders",
    "job_runs",
  ];

  pgm.sql(`GRANT SELECT, INSERT, UPDATE ON ${appCrudTables.join(", ")} TO late_rent_app;`);
  pgm.sql(`REVOKE DELETE ON ${appCrudTables.join(", ")} FROM late_rent_app;`);

  // audit_log: INSERT + SELECT only. No UPDATE, no DELETE, no TRUNCATE.
  // (The block_audit_log_mutation trigger from 0015 enforces this even for
  // roles that somehow retain the privilege, but we also remove the grant
  // itself — defense in depth.)
  pgm.sql(`REVOKE ALL ON audit_log FROM late_rent_app;`);
  pgm.sql(`GRANT INSERT, SELECT ON audit_log TO late_rent_app;`);
  pgm.sql(`REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM late_rent_app;`);
  pgm.sql(`REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM PUBLIC;`);

  pgm.sql(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO late_rent_app;`);

  const jobTables = [
    "properties",
    "pm_users",
    "pm_property_assignments",
    "leases",
    "lease_tenants",
    "late_cycles",
    "notices",
    "job_runs",
    "escalation_reminders",
  ];
  pgm.sql(`GRANT SELECT, INSERT, UPDATE ON ${jobTables.join(", ")} TO late_rent_job;`);
  pgm.sql(`GRANT INSERT, SELECT ON audit_log TO late_rent_job;`);
  pgm.sql(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO late_rent_job;`);

  pgm.sql(`REVOKE TRUNCATE ON ALL TABLES IN SCHEMA public FROM late_rent_app, late_rent_job;`);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'late_rent_app') THEN
        DROP OWNED BY late_rent_app;
        DROP ROLE late_rent_app;
      END IF;
      IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'late_rent_job') THEN
        DROP OWNED BY late_rent_job;
        DROP ROLE late_rent_job;
      END IF;
    END
    $$;
  `);
}
