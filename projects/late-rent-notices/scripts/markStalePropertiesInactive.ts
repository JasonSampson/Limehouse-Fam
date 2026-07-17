import { getJobPool, closePools } from "../src/db/pool.js";
import { fetchAllPropertiesIncludingInactive } from "../src/buildium/client.js";
import { writeAuditLog } from "../src/lib/auditLog.js";
import { startTrace } from "../src/lib/trace.js";
import { logInfo } from "../src/lib/appLogger.js";

// One-time data-fix script, NOT run automatically by anything (not wired
// into the daily job, not a migration). Companion to migration 0045
// (properties.is_active), which only adds the column — this is the
// separate step that actually re-checks live Buildium data and applies it,
// per Jason's explicit instruction: mark stale properties inactive, never
// delete them.
//
// Two things this script does, both scoped ONLY to rows Buildium's own
// IsActive field says are inactive (never the "OLD in the name" heuristic,
// which was only ever a weak signal used to find candidates, not a source
// of truth):
//
//   1. properties.is_active = false for any locally-synced property
//      Buildium currently reports IsActive: false for. UPDATE only, never
//      DELETE — every row stays in place, in full, forever.
//
//   2. pm_property_assignments rows created by the 2026-07-17 bulk-assign
//      (source = 'manual_app_assignment', pm_user_id = Dana's pm_users id)
//      that point at a property in set (1) are identified and reported, but
//      DELIBERATELY LEFT IN PLACE, not deleted. Two independent reasons:
//        a) migration 0017 never grants DELETE on pm_property_assignments
//           to ANY app-facing role (late_rent_app or late_rent_job) — see
//           migration 0044's comment confirming this is intentional, not an
//           oversight. Deleting these rows would require reaching for the
//           superuser connection, i.e. deliberately working around an
//           existing, deliberate least-privilege boundary for a one-time
//           cleanup — a bigger and riskier move than the cleanup itself
//           needs to be.
//        b) it's unnecessary: pmAssignmentRoutes.ts's "INSERT-only, by
//           design" comment explains the zero-assignments-means-visible-to-
//           everyone safety net exists to protect genuinely unassigned
//           ACTIVE properties. Once a property is is_active = false,
//           dailyLatenessCheck.ts and noticeRoutes.ts's late-no-notice
//           queue both exclude it outright — nothing about that property
//           is ever surfaced again regardless of what pm_property_
//           assignments says about it. The stale rows become permanently
//           inert the moment the property is marked inactive; they don't
//           need to be removed for the fix to be complete, only reported so
//           Jason/Dana know why she'll still see them if she looks.
//
// Defaults to DRY RUN (prints what it would do, changes nothing). Pass
// --apply to actually write. Run against .env.test's DATABASE_URL_JOB
// first; only point DATABASE_URL_JOB at production after a human has
// reviewed the dry-run output.
//
// DANA_PM_USER_ID must be confirmed against the real pm_users table before
// --apply is used against production — do not assume the id below without
// checking a fresh SELECT id FROM pm_users WHERE display_name = 'Dana
// Sampson' first, since ids can differ between the test and production
// databases.
const DANA_PM_USER_ID = 6;

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const jobPool = getJobPool();

  const liveProperties = await fetchAllPropertiesIncludingInactive();
  const inactiveBuildiumIds = new Set(
    liveProperties.filter((p) => p.IsActive === false).map((p) => String(p.Id))
  );

  const locallyActive = await jobPool.query<{ id: number; buildium_property_id: string; name: string }>(
    "SELECT id, buildium_property_id, name FROM properties WHERE is_active = true"
  );

  const toDeactivate = locallyActive.rows.filter((r) => inactiveBuildiumIds.has(r.buildium_property_id));

  logInfo("markStalePropertiesInactive: dry-run summary", {
    liveBuildiumPropertyCount: liveProperties.length,
    liveInactiveCount: inactiveBuildiumIds.size,
    locallyActiveCount: locallyActive.rows.length,
    toDeactivateCount: toDeactivate.length,
    apply,
  });

  if (toDeactivate.length === 0) {
    logInfo("markStalePropertiesInactive: nothing to do", {});
    await closePools();
    return;
  }

  if (!apply) {
    for (const row of toDeactivate) {
      logInfo("markStalePropertiesInactive: would deactivate", {
        id: row.id,
        buildiumPropertyId: row.buildium_property_id,
      });
    }
    logInfo("markStalePropertiesInactive: dry run only, no changes made. Re-run with --apply to write.", {});
    await closePools();
    return;
  }

  const trace = startTrace();
  const deactivatedIds = toDeactivate.map((r) => r.id);

  await jobPool.query("UPDATE properties SET is_active = false WHERE id = ANY($1::int[])", [deactivatedIds]);

  const staleAssignments = await jobPool.query<{ id: number; property_id: number }>(
    `SELECT id, property_id FROM pm_property_assignments
     WHERE property_id = ANY($1::int[])
       AND pm_user_id = $2
       AND source = 'manual_app_assignment'`,
    [deactivatedIds, DANA_PM_USER_ID]
  );

  await writeAuditLog(jobPool, {
    companyId: "limehouse-pm",
    instanceId: "late-rent-notices",
    actorType: "system",
    actorId: "markStalePropertiesInactive_script",
    eventType: "property.bulk_marked_inactive",
    eventSummary:
      `${deactivatedIds.length} properties marked inactive (confirmed via live Buildium IsActive check). ` +
      `${staleAssignments.rows.length} pm_property_assignments rows from the 2026-07-17 bulk-assign ` +
      `(source=manual_app_assignment, pm_user_id=${DANA_PM_USER_ID}) point at properties in this batch and are ` +
      `left in place (not deleted — see script comment: no app-facing role has DELETE on this table by design, ` +
      `and these rows are now inert since is_active=false properties are excluded everywhere lateness/notices ` +
      `are computed). No property rows were deleted.`,
    eventData: {
      deactivatedPropertyIds: deactivatedIds,
      staleAssignmentIdsLeftInPlace: staleAssignments.rows.map((r) => r.id),
    },
    contextSnapshot: { runBy: "markStalePropertiesInactive.ts", danaPmUserId: DANA_PM_USER_ID },
    privacyCategory: "N/A",
    regulationTags: [],
    riskLevel: "medium",
    legalBasis: "data_correction_buildium_source_of_truth",
    retentionPolicy: "retain_7_years_post_tenancy",
    trace,
  });

  logInfo("markStalePropertiesInactive: applied", {
    deactivatedCount: deactivatedIds.length,
    staleAssignmentsLeftInPlace: staleAssignments.rows.length,
  });

  await closePools();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});
