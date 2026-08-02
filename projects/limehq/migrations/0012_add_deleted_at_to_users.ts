import type { MigrationBuilder } from "node-pg-migrate";

// Soft-delete flag for staff accounts. A hard DELETE on users is not safe:
// five FK columns elsewhere reference users.id for historical attribution
// (user_permission_overrides.user_id, property_exclusions.flagged_by_user_id /
// removed_by_user_id, named_area_exclusions.retired_by_user_id /
// created_by_user_id / activated_by_user_id — the last three live in Map's
// schema, part of this same codebase per src/map/). Deleting the row would
// either cascade-destroy legitimate historical records or fail outright.
//
// Instead, "deleting" a staff member sets deleted_at = now() (this column),
// active = false, and overwrites password_hash with an unguessable random
// hash — see the /staff/:id/delete route in src/staff/staffRoutes.ts. The
// row itself, including email and display_name, is kept for attribution.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn("users", {
    deleted_at: { type: "timestamptz" },
  });

  pgm.createIndex("users", "deleted_at", { name: "idx_users_deleted_at" });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn("users", "deleted_at");
}
