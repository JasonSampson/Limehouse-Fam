import type { MigrationBuilder } from "node-pg-migrate";

// Fixes the gap where a rent period that was closed as paid (see
// reconcileClosedCycles in dailyLatenessCheck.ts) had no way to reopen if
// that payment later bounced (NSF) or was otherwise reversed — the tenant
// could go a full rent cycle without a fresh notice ever being drafted for
// a debt that's actually still owed. See Oracle's spec for the full design.
//
// Keeps both hard invariants this system is built around: nothing about a
// closed late_cycles row (or its voided notices row) is ever mutated or
// deleted — a reopen is always a brand-new row, so the original stays
// exactly as it was, permanently, as audit history. notices.late_cycle_id
// stays UNIQUE, unchanged — every other piece of code that touches notices
// (sendNotice.ts, staleDraftCheck.ts, noticeRoutes.ts) already operates
// per-notice/per-cycle-id and needs no changes.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn("late_cycles", {
    // 1 for every lease's first late cycle on a given due_date (the
    // existing, unmodified happy path) — incremented only when a prior
    // attempt for that same due_date was closed and then reopened.
    cycle_attempt: { type: "integer", notNull: true, default: 1 },
    // Explicit lineage from a reopened attempt back to the closed cycle
    // that preceded it, for audit clarity — null for every ordinary
    // first-attempt cycle.
    reopened_from_cycle_id: {
      type: "bigint",
      references: "late_cycles",
      onDelete: "RESTRICT",
    },
  });

  // The old UNIQUE(lease_id, due_date) can't coexist with multiple
  // historical attempts for the same due_date — replaced by a constraint
  // that includes cycle_attempt, plus the partial index below, which
  // together preserve the real invariant (only one OPEN cycle per rent
  // period at a time) while allowing closed attempts to accumulate.
  pgm.dropConstraint("late_cycles", "uq_late_cycles_lease_due_date");
  pgm.addConstraint("late_cycles", "uq_late_cycles_lease_due_date_attempt", {
    unique: ["lease_id", "due_date", "cycle_attempt"],
  });

  pgm.createIndex("late_cycles", ["lease_id", "due_date"], {
    name: "idx_late_cycles_one_open_per_due_date",
    unique: true,
    where: "closed_at IS NULL",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropIndex("late_cycles", ["lease_id", "due_date"], {
    name: "idx_late_cycles_one_open_per_due_date",
  });
  pgm.dropConstraint("late_cycles", "uq_late_cycles_lease_due_date_attempt");
  pgm.addConstraint("late_cycles", "uq_late_cycles_lease_due_date", {
    unique: ["lease_id", "due_date"],
  });
  pgm.dropColumn("late_cycles", ["cycle_attempt", "reopened_from_cycle_id"]);
}
