import type { MigrationBuilder } from "node-pg-migrate";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable("notice_recipients", {
    id: "id",
    notice_id: {
      type: "bigint",
      notNull: true,
      references: "notices",
      onDelete: "RESTRICT",
    },
    recipient_type: { type: "text", notNull: true },
    lease_tenant_id: {
      type: "bigint",
      references: "lease_tenants",
      onDelete: "RESTRICT",
    },
    pm_user_id: {
      type: "bigint",
      references: "pm_users",
      onDelete: "RESTRICT",
    },
    email_address: { type: "text", notNull: true },
    delivery_status: { type: "text", notNull: true, default: "pending" },
    bounced_at: { type: "timestamptz" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.addConstraint("notice_recipients", "ck_notice_recipients_type", {
    check: "recipient_type IN ('to','cc')",
  });
  pgm.addConstraint("notice_recipients", "ck_notice_recipients_target_matches_type", {
    check:
      "(recipient_type = 'to' AND lease_tenant_id IS NOT NULL) OR (recipient_type = 'cc' AND pm_user_id IS NOT NULL)",
  });
  pgm.addConstraint("notice_recipients", "ck_notice_recipients_delivery_status", {
    check: "delivery_status IN ('pending','sent','bounced')",
  });

  pgm.createIndex("notice_recipients", "notice_id", {
    name: "idx_notice_recipients_notice",
  });

  pgm.createTrigger("notice_recipients", "trg_set_updated_at_notice_recipients", {
    when: "BEFORE",
    operation: "UPDATE",
    function: "set_updated_at",
    level: "ROW",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable("notice_recipients");
}
