import type { MigrationBuilder } from "node-pg-migrate";

// ============================================================================
// DATABASE PLACEMENT: this project runs against its OWN standalone Postgres
// database — fully separate from late-rent-notices and limehouse-dashboard.
// Per this repo's convention (see limehouse-dashboard/migrations/0000), every
// project owns its extensions and helper functions from scratch rather than
// assuming another project's database already created them.
//
// pgvector is required here (not needed by the other two projects) because
// document_chunks.embedding (migration 0004) stores embedding vectors for
// similarity search.
// ============================================================================
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createExtension("pgcrypto", { ifNotExists: true });
  pgm.createExtension("vector", { ifNotExists: true });

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
  pgm.dropExtension("vector");
  pgm.dropExtension("pgcrypto");
}
