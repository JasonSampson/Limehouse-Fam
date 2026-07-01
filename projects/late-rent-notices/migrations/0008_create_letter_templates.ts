import type { MigrationBuilder } from "node-pg-migrate";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable("letter_templates", {
    id: "id",
    template_key: { type: "text", notNull: true, default: "14_day_pay_or_quit" },
    version: { type: "integer", notNull: true },
    subject_line: { type: "text", notNull: true },
    body_markdown: { type: "text", notNull: true },
    is_active: { type: "boolean", notNull: true, default: false },
    created_by_pm_id: {
      type: "bigint",
      notNull: true,
      references: "pm_users",
      onDelete: "RESTRICT",
    },
    change_summary: { type: "text", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.addConstraint("letter_templates", "uq_letter_templates_key_version", {
    unique: ["template_key", "version"],
  });

  pgm.createIndex("letter_templates", "template_key", {
    name: "idx_letter_templates_one_active",
    unique: true,
    where: "is_active = true",
  });

  // Immutability: editing a template creates a new version, never overwrites
  // the wording of an existing one. Only is_active may flip.
  pgm.createFunction(
    "prevent_letter_template_mutation",
    [],
    { returns: "trigger", language: "plpgsql", replace: true },
    `
    BEGIN
      IF NEW.body_markdown IS DISTINCT FROM OLD.body_markdown
         OR NEW.subject_line IS DISTINCT FROM OLD.subject_line
         OR NEW.template_key IS DISTINCT FROM OLD.template_key
         OR NEW.version IS DISTINCT FROM OLD.version THEN
        RAISE EXCEPTION 'letter_templates rows are immutable except is_active; create a new version instead (id=%)', OLD.id;
      END IF;
      RETURN NEW;
    END;
    `
  );

  pgm.createTrigger("letter_templates", "trg_prevent_letter_template_mutation", {
    when: "BEFORE",
    operation: "UPDATE",
    function: "prevent_letter_template_mutation",
    level: "ROW",
  });

  pgm.createTrigger("letter_templates", "trg_set_updated_at_letter_templates", {
    when: "BEFORE",
    operation: "UPDATE",
    function: "set_updated_at",
    level: "ROW",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTrigger("letter_templates", "trg_set_updated_at_letter_templates");
  pgm.dropTrigger("letter_templates", "trg_prevent_letter_template_mutation");
  pgm.dropFunction("prevent_letter_template_mutation", []);
  pgm.dropTable("letter_templates");
}
