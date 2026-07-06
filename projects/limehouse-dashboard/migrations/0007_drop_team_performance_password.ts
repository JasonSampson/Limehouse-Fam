import type { MigrationBuilder } from "node-pg-migrate";

// Removes the single shared Team Performance password now that real
// per-person Microsoft sign-in (staff_users, see
// 0006_create_staff_users.ts) covers both the main Dashboard and Team
// Performance. Everyone signs in as themselves; there is no longer a
// separate "the whole team shares one password for this one tab" gate.
//
// Only team_performance_password_hash is dropped, not the whole
// dashboard_settings table. Confirmed by reading 0001_create_dashboard_settings.ts:
// that table also holds id (forced to 1, singleton), created_at, and
// updated_at, plus the updated_at trigger. None of that is specific to the
// password feature — it's a generic single-row settings table that may hold
// other dashboard-wide config later. Dropping the whole table now would be
// removing infrastructure that isn't actually the thing being retired.
//
// Corresponding app cleanup for Q (not done in this migration):
//   - src/db/settings.ts: isTeamPerformancePasswordSet, setTeamPerformancePassword,
//     checkTeamPerformancePassword all read/write this column — delete them.
//   - src/api/session.ts: issueUnlockedCookie / requireTeamPerformanceUnlocked
//     (the tp_unlocked signed-cookie mechanism) is replaced by the real
//     staff_users-backed session/role check used for the rest of the
//     dashboard — delete this file's shared-password logic once that's live.
//   - src/api/teamPerformanceRoutes.ts: /api/team-performance/check-password
//     and /api/team-performance/status both go away; the /roles route keeps
//     its role check but swaps requireTeamPerformanceUnlocked for the new
//     "role = admin" check backed by staff_users.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn("dashboard_settings", "team_performance_password_hash");
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // Restored nullable, matching its original definition in
  // 0001_create_dashboard_settings.ts — NULL means "locked/no password set,"
  // exactly as it did before this migration.
  pgm.addColumn("dashboard_settings", {
    team_performance_password_hash: { type: "text" },
  });
}
