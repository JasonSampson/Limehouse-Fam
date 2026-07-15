import type { MigrationBuilder } from "node-pg-migrate";

// Shared trigger function used by every table in this project.
// Must exist before any table references it, and must be dropped last.
export async function up(pgm: MigrationBuilder): Promise<void> {
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
  pgm.dropFunction("set_updated_at", []);
}
