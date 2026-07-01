import type { MigrationBuilder } from "node-pg-migrate";

// Per-PM data scoping. The app MUST call
//   SELECT set_config('app.current_pm_id', $1, true)
// (true = local to the current transaction) at the start of EVERY request,
// before any query touching these tables. Node's connection pooling reuses
// physical connections across different PMs' requests — if this reset is
// skipped, PM A's session variable can leak into PM B's query on a reused
// connection. See src/db/withPmScope.ts for the helper that enforces this.
export async function up(pgm: MigrationBuilder): Promise<void> {
  const scopedTables = ["leases", "lease_tenants", "exclusions", "late_cycles", "notices", "notice_recipients"];
  for (const table of scopedTables) {
    pgm.sql(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`);
    pgm.sql(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);
  }

  pgm.createPolicy("leases", "pm_scoped_leases", {
    using: `
      property_id IN (
        SELECT property_id FROM pm_property_assignments
        WHERE pm_user_id = current_setting('app.current_pm_id', true)::BIGINT
      )
    `,
  });

  pgm.createPolicy("lease_tenants", "pm_scoped_lease_tenants", {
    using: `
      lease_id IN (
        SELECT l.id FROM leases l
        JOIN pm_property_assignments ppa ON ppa.property_id = l.property_id
        WHERE ppa.pm_user_id = current_setting('app.current_pm_id', true)::BIGINT
      )
    `,
  });

  pgm.createPolicy("exclusions", "pm_scoped_exclusions", {
    using: `
      lease_id IN (
        SELECT l.id FROM leases l
        JOIN pm_property_assignments ppa ON ppa.property_id = l.property_id
        WHERE ppa.pm_user_id = current_setting('app.current_pm_id', true)::BIGINT
      )
    `,
  });

  pgm.createPolicy("late_cycles", "pm_scoped_late_cycles", {
    using: `
      lease_id IN (
        SELECT l.id FROM leases l
        JOIN pm_property_assignments ppa ON ppa.property_id = l.property_id
        WHERE ppa.pm_user_id = current_setting('app.current_pm_id', true)::BIGINT
      )
    `,
  });

  // A PM sees notices assigned to them, or ones they personally sent as the
  // fallback decision-maker (Jason needs visibility into his own fallback
  // sends even though he isn't the assigned PM for that lease).
  pgm.createPolicy("notices", "pm_scoped_notices", {
    using: `
      assigned_pm_id = current_setting('app.current_pm_id', true)::BIGINT
      OR sent_by_pm_id = current_setting('app.current_pm_id', true)::BIGINT
    `,
  });

  pgm.createPolicy("notice_recipients", "pm_scoped_notice_recipients", {
    using: `
      notice_id IN (
        SELECT id FROM notices
        WHERE assigned_pm_id = current_setting('app.current_pm_id', true)::BIGINT
           OR sent_by_pm_id = current_setting('app.current_pm_id', true)::BIGINT
      )
    `,
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropPolicy("notice_recipients", "pm_scoped_notice_recipients");
  pgm.dropPolicy("notices", "pm_scoped_notices");
  pgm.dropPolicy("late_cycles", "pm_scoped_late_cycles");
  pgm.dropPolicy("exclusions", "pm_scoped_exclusions");
  pgm.dropPolicy("lease_tenants", "pm_scoped_lease_tenants");
  pgm.dropPolicy("leases", "pm_scoped_leases");

  const scopedTables = ["leases", "lease_tenants", "exclusions", "late_cycles", "notices", "notice_recipients"];
  for (const table of scopedTables) {
    pgm.sql(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY;`);
  }
}
