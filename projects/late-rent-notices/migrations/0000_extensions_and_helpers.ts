import type { MigrationBuilder } from "node-pg-migrate";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createExtension("pgcrypto", { ifNotExists: true });

  // Shared updated_at trigger function, reused by every table below.
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
  pgm.dropExtension("pgcrypto");
}
