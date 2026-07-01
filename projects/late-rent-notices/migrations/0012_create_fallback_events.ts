import type { MigrationBuilder } from "node-pg-migrate";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable("fallback_events", {
    id: "id",
    notice_id: {
      type: "bigint",
      notNull: true,
      unique: true,
      references: "notices",
      onDelete: "RESTRICT",
    },
    assigned_pm_id: {
      type: "bigint",
      notNull: true,
      references: "pm_users",
      onDelete: "RESTRICT",
    },
    fallback_pm_id: {
      type: "bigint",
      notNull: true,
      references: "pm_users",
      onDelete: "RESTRICT",
    },
    occurred_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    reauthenticated_at: { type: "timestamptz", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.createIndex("fallback_events", ["assigned_pm_id", "occurred_at"], {
    name: "idx_fallback_events_pm_month",
  });
  pgm.createIndex("fallback_events", "occurred_at", {
    name: "idx_fallback_events_occurred_at",
  });

  // Non-discretionary hard ceiling, enforced atomically at INSERT time —
  // not a metric for a human to review later. Two ceilings, either trips it:
  //   1. >1 fallback send per assigned PM per calendar month
  //   2. fallback sends > 10% of all notices sent in the trailing 30 days
  // An advisory lock serializes concurrent fallback attempts so two
  // near-simultaneous sends can't both read a count of zero and both pass.
  pgm.createFunction(
    "enforce_fallback_ceiling",
    [],
    { returns: "trigger", language: "plpgsql", replace: true },
    `
    DECLARE
      pm_month_count INTEGER;
      total_notices_30d INTEGER;
      fallback_notices_30d INTEGER;
      fallback_pct NUMERIC;
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtext('fallback_ceiling_check'));

      SELECT count(*) INTO pm_month_count
      FROM fallback_events
      WHERE assigned_pm_id = NEW.assigned_pm_id
        AND date_trunc('month', occurred_at) = date_trunc('month', NEW.occurred_at);

      IF pm_month_count >= 1 THEN
        RAISE EXCEPTION
          'Fallback ceiling exceeded: PM % already has a fallback send this month. Asimov review required before another fallback send.',
          NEW.assigned_pm_id;
      END IF;

      SELECT count(*) INTO total_notices_30d
      FROM notices
      WHERE status = 'sent' AND sent_at >= NEW.occurred_at - INTERVAL '30 days';

      SELECT count(*) INTO fallback_notices_30d
      FROM fallback_events
      WHERE occurred_at >= NEW.occurred_at - INTERVAL '30 days';

      IF total_notices_30d > 0 THEN
        fallback_pct := (fallback_notices_30d + 1)::NUMERIC / (total_notices_30d + 1)::NUMERIC;
        IF fallback_pct > 0.10 THEN
          RAISE EXCEPTION
            'Fallback ceiling exceeded: this send would put fallback sends at % of trailing-30-day notices (limit 10%%). Asimov review required.',
            round(fallback_pct * 100, 1);
        END IF;
      END IF;

      RETURN NEW;
    END;
    `
  );

  pgm.createTrigger("fallback_events", "trg_enforce_fallback_ceiling", {
    when: "BEFORE",
    operation: "INSERT",
    function: "enforce_fallback_ceiling",
    level: "ROW",
  });

  pgm.createTrigger("fallback_events", "trg_set_updated_at_fallback_events", {
    when: "BEFORE",
    operation: "UPDATE",
    function: "set_updated_at",
    level: "ROW",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTrigger("fallback_events", "trg_set_updated_at_fallback_events");
  pgm.dropTrigger("fallback_events", "trg_enforce_fallback_ceiling");
  pgm.dropFunction("enforce_fallback_ceiling", []);
  pgm.dropTable("fallback_events");
}
