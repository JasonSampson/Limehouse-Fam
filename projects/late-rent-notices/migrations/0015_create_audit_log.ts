import type { MigrationBuilder } from "node-pg-migrate";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable("audit_log", {
    id: "id",
    sequence_num: { type: "bigint", notNull: true },
    prev_hash: { type: "text" },
    entry_hash: { type: "text", notNull: true },
    company_id: { type: "text", notNull: true },
    instance_id: { type: "text", notNull: true },
    decision_id: { type: "text" },
    action_id: { type: "text" },
    actor_type: { type: "text", notNull: true },
    actor_id: { type: "text", notNull: true },
    event_type: { type: "text", notNull: true },
    event_summary: { type: "text", notNull: true },
    event_data: { type: "jsonb", notNull: true },
    context_snapshot: { type: "jsonb", notNull: true },
    privacy_category: { type: "text", notNull: true },
    regulation_tags: { type: "text[]", notNull: true, default: pgm.func("'{}'::text[]") },
    risk_level: { type: "text", notNull: true },
    contact_id: { type: "bigint" },
    property_id: { type: "bigint" },
    legal_basis: { type: "text", notNull: true },
    retention_policy: { type: "text", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  // No updated_at: this table is append-only by design, rows are never updated.

  pgm.addConstraint("audit_log", "uq_audit_log_sequence_num", {
    unique: ["sequence_num"],
  });
  pgm.addConstraint("audit_log", "ck_audit_log_trace_present", {
    check: "event_data ? 'trace'",
  });
  pgm.addConstraint("audit_log", "ck_audit_log_trace_shape", {
    check: "event_data->'trace' ?& ARRAY['trace_id','span_id','parent_span_id']",
  });
  pgm.addConstraint("audit_log", "ck_audit_log_actor_type", {
    check: "actor_type IN ('system','pm','fallback_decision_maker')",
  });
  pgm.addConstraint("audit_log", "ck_audit_log_risk_level", {
    check: "risk_level IN ('low','medium','high','critical')",
  });

  pgm.createIndex("audit_log", "sequence_num", { name: "idx_audit_log_sequence" });
  pgm.createIndex("audit_log", "event_type", { name: "idx_audit_log_event_type" });
  pgm.createIndex("audit_log", "contact_id", { name: "idx_audit_log_contact" });
  pgm.createIndex("audit_log", "property_id", { name: "idx_audit_log_property" });
  pgm.createIndex("audit_log", "decision_id", { name: "idx_audit_log_decision" });

  // Hash chain computed server-side, in the DB, never by app code.
  // sequence_num/prev_hash/entry_hash are all assigned here regardless of
  // what the INSERT statement supplies for those columns.
  pgm.createFunction(
    "compute_audit_log_hash",
    [],
    { returns: "trigger", language: "plpgsql", replace: true },
    `
    DECLARE
      last_seq BIGINT;
      last_hash TEXT;
      payload TEXT;
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtext('audit_log_chain'));

      SELECT sequence_num, entry_hash INTO last_seq, last_hash
      FROM audit_log
      ORDER BY sequence_num DESC
      LIMIT 1;

      IF last_seq IS NULL THEN
        NEW.sequence_num := 1;
        NEW.prev_hash := NULL;
      ELSE
        NEW.sequence_num := last_seq + 1;
        NEW.prev_hash := last_hash;
      END IF;

      payload := concat_ws('|',
        NEW.sequence_num::TEXT, COALESCE(NEW.prev_hash, ''),
        NEW.company_id, NEW.instance_id,
        COALESCE(NEW.decision_id, ''), COALESCE(NEW.action_id, ''),
        NEW.actor_type, NEW.actor_id, NEW.event_type, NEW.event_summary,
        NEW.event_data::TEXT, NEW.context_snapshot::TEXT,
        NEW.privacy_category, array_to_string(NEW.regulation_tags, ','),
        NEW.risk_level, COALESCE(NEW.contact_id::TEXT, ''),
        COALESCE(NEW.property_id::TEXT, ''), NEW.legal_basis,
        NEW.retention_policy, NEW.created_at::TEXT
      );

      NEW.entry_hash := encode(digest(payload, 'sha256'), 'hex');

      RETURN NEW;
    END;
    `
  );

  pgm.createTrigger("audit_log", "trg_compute_audit_log_hash", {
    when: "BEFORE",
    operation: "INSERT",
    function: "compute_audit_log_hash",
    level: "ROW",
  });

  // Block UPDATE/DELETE/TRUNCATE at the table level for everyone, not just
  // the app role — a hash-chained audit log that can still be edited by
  // some superuser path isn't actually tamper-evident.
  pgm.createFunction(
    "block_audit_log_mutation",
    [],
    { returns: "trigger", language: "plpgsql", replace: true },
    `
    BEGIN
      RAISE EXCEPTION 'audit_log is append-only: % is not permitted', TG_OP;
    END;
    `
  );

  pgm.createTrigger("audit_log", "trg_block_audit_log_update", {
    when: "BEFORE",
    operation: "UPDATE",
    function: "block_audit_log_mutation",
    level: "ROW",
  });

  pgm.createTrigger("audit_log", "trg_block_audit_log_delete", {
    when: "BEFORE",
    operation: "DELETE",
    function: "block_audit_log_mutation",
    level: "ROW",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTrigger("audit_log", "trg_block_audit_log_delete");
  pgm.dropTrigger("audit_log", "trg_block_audit_log_update");
  pgm.dropFunction("block_audit_log_mutation", []);
  pgm.dropTrigger("audit_log", "trg_compute_audit_log_hash");
  pgm.dropFunction("compute_audit_log_hash", []);
  pgm.dropTable("audit_log");
}
