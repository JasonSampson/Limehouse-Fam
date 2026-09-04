import type { MigrationBuilder } from "node-pg-migrate";

// Real incident, 2026-09-04: Candice Thomas, removed from a lease at 4314
// Dunning Road #2 well before today, still showed up as a "to" recipient on
// a live 14-day notice draft this morning. Root cause: src/buildium/sync.ts's
// tenant loop only ever INSERTs/UPSERTs the people Buildium's CurrentTenants
// currently returns for a lease — there was no removal path at all, so a
// tenant who drops off CurrentTenants (moved out, lease renewed without
// them) just sits in lease_tenants forever, exactly like the properties
// table before is_active existed there (see that table's own history).
//
// Can't just DELETE the row once someone drops off, the way sync.ts's
// property-deactivation comment might suggest: lease_tenants rows are
// referenced by notice_recipients (notice_recipients_lease_tenant_id_fkey)
// for every notice ever actually sent to that person, and that history must
// never be erased (confirmed hitting this FK directly while manually
// correcting today's live case). is_active is the same pattern properties
// already uses for exactly this reason.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn("lease_tenants", {
    is_active: { type: "boolean", notNull: true, default: true },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn("lease_tenants", "is_active");
}
