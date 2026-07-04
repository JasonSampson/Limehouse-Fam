import type { MigrationBuilder } from "node-pg-migrate";

// ============================================================================
// DATABASE PLACEMENT (finalized): this project runs against its OWN
// standalone Postgres database — fully separate from late-rent-notices'.
// Jason decided against sharing a database between the two projects; he
// wants to combine things later as part of a broader ecosystem plan, not
// now. See 0001_create_dashboard_settings.ts for the standalone,
// password-only settings table that replaces the earlier design's
// dependency on late-rent-notices' pm_users/config_values tables.
//
// Because this is its own database, pgcrypto and set_updated_at are created
// here from scratch rather than assumed to already exist. This is now the
// single source of truth for both, scoped entirely to this database.
// ============================================================================
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createExtension("pgcrypto", { ifNotExists: true });

  pgm.createFunction(
    "set_updated_at",
    [],
    { returns: "trigger", language: "plpgsql", replace: true },
    `
    BEGIN
      NEW.updated_at := now();
      RETURN NEW;
    END;
    `
  );
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // Safe to fully tear down: this is a standalone database owned solely by
  // this project, so nothing else can be relying on these.
  pgm.dropFunction("set_updated_at", []);
  pgm.dropExtension("pgcrypto");
}
