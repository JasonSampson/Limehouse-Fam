import type { MigrationBuilder } from "node-pg-migrate";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable("config_values", {
    id: "id",
    config_key: { type: "text", notNull: true },
    version: { type: "integer", notNull: true },
    value: { type: "jsonb", notNull: true },
    is_active: { type: "boolean", notNull: true, default: false },
    set_by_pm_id: {
      type: "bigint",
      notNull: true,
      references: "pm_users",
      onDelete: "RESTRICT",
    },
    change_reason: { type: "text", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.addConstraint("config_values", "uq_config_values_key_version", {
    unique: ["config_key", "version"],
  });

  pgm.createIndex("config_values", "config_key", {
    name: "idx_config_values_one_active",
    unique: true,
    where: "is_active = true",
  });

  // Immutability: only is_active may change after a config version is created.
  pgm.createFunction(
    "prevent_config_values_mutation",
    [],
    { returns: "trigger", language: "plpgsql", replace: true },
    `
    BEGIN
      IF NEW.config_key IS DISTINCT FROM OLD.config_key
         OR NEW.version IS DISTINCT FROM OLD.version
         OR NEW.value IS DISTINCT FROM OLD.value THEN
        RAISE EXCEPTION 'config_values rows are immutable except is_active; create a new version instead (id=%)', OLD.id;
      END IF;
      RETURN NEW;
    END;
    `
  );

  pgm.createTrigger("config_values", "trg_prevent_config_values_mutation", {
    when: "BEFORE",
    operation: "UPDATE",
    function: "prevent_config_values_mutation",
    level: "ROW",
  });

  pgm.createTrigger("config_values", "trg_set_updated_at_config_values", {
    when: "BEFORE",
    operation: "UPDATE",
    function: "set_updated_at",
    level: "ROW",
  });

  // Seed: $250 de minimis threshold, version 1, active.
  // set_by_pm_id is intentionally left for the app to backfill on first
  // real PM login; we insert a placeholder pm_users row here so the seed
  // satisfies the NOT NULL FK without inventing a real person.
  pgm.sql(`
    INSERT INTO pm_users (entra_object_id, display_name, email, is_fallback_decision_maker, active)
    VALUES ('seed-system-placeholder', 'System (migration seed)', 'system@limehousepm.com', false, false)
    ON CONFLICT (entra_object_id) DO NOTHING;
  `);

  pgm.sql(`
    INSERT INTO config_values (config_key, version, value, is_active, set_by_pm_id, change_reason)
    SELECT 'de_minimis_threshold_usd', 1, '"250.00"'::jsonb, true, id, 'Initial seed value from binding plan.'
    FROM pm_users WHERE entra_object_id = 'seed-system-placeholder';
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTrigger("config_values", "trg_set_updated_at_config_values");
  pgm.dropTrigger("config_values", "trg_prevent_config_values_mutation");
  pgm.dropFunction("prevent_config_values_mutation", []);
  pgm.dropTable("config_values");
}
