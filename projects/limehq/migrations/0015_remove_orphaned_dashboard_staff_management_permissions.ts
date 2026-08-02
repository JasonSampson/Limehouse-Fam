import type { MigrationBuilder } from "node-pg-migrate";

// dashboard.staff_management.view / dashboard.staff_management.edit were
// seeded (migration 0007) for Dashboard's own "Manage Staff" page. That
// page was later removed entirely from Dashboard — staff accounts, roles,
// and access are now managed centrally here in LimeHQ instead (per Jason
// directly, and Dashboard's own commit "Remove Manage Staff — superseded
// by LimeHQ's Staff & Permissions"). Confirmed via grep across both
// codebases (2026-08-02): nothing references either permission key
// anymore. Removing the now-meaningless entries from the Roles &
// Permissions grid, per Jason directly.
//
// Deleting from permission_catalog is enough on its own — both
// role_template_permissions.fk_rtp_permission_key and
// user_permission_overrides.fk_upo_permission_key are ON DELETE CASCADE,
// so any existing grant/override rows referencing these two keys are
// cleaned up automatically, not left orphaned.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DELETE FROM permission_catalog
    WHERE permission_key IN ('dashboard.staff_management.view', 'dashboard.staff_management.edit');
  `);
}

// Down intentionally re-seeds the catalog rows only — any role grants or
// user overrides that existed before the up migration are gone for good
// (cascaded), same as any other DELETE. Re-seeding as ungranted/absent is
// the safe default; nothing depends on this permission existing anymore.
export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    INSERT INTO permission_catalog (module, feature, action, permission_key, label, sort_order)
    VALUES
      ('dashboard', 'staff_management', 'view', 'dashboard.staff_management.view', 'View Staff Management', 70),
      ('dashboard', 'staff_management', 'edit', 'dashboard.staff_management.edit', 'Edit Staff', 80)
    ON CONFLICT (permission_key) DO NOTHING;
  `);
}
