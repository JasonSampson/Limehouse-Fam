import type { Pool } from "pg";
import { loadEnv } from "../config/env.js";
import { syncBuildiumData } from "../buildium/sync.js";
import { fetchOutstandingBalances } from "../buildium/client.js";
import { calculateLateness } from "../lib/lateness.js";
import { getDeMinimisThreshold } from "../lib/config.js";
import { fetchAndClassifyLeaseCharges, insertNoticeLineItems } from "../lib/noticeLineItems.js";
import { writeAuditLog } from "../lib/auditLog.js";
import { startTrace, childSpan } from "../lib/trace.js";
import { logInfo, logError } from "../lib/appLogger.js";
import { sendAlert } from "../email/sendAlert.js";
import { formatCurrency } from "../templates/renderTemplate.js";

interface LeaseRow {
  id: number;
  property_id: number;
  rent_due_day: number;
  grace_period_days: number;
  buildium_lease_id: string;
}

interface UnassignedPropertyIssue {
  leaseId: number;
  propertyId: number;
  propertyName: string;
  amountOwed: number;
  dueDate: string;
}

interface DailyJobResult {
  leasesChecked: number;
  noticesDrafted: number;
  excludedCount: number;
  cyclesReconciled: number;
  noticesAutoVoided: number;
  unassignedPropertyCount: number;
  errors: string[];
}

// Reconciles already-open late_cycles rows against today's Buildium
// balances. fetchOutstandingBalances() only returns leases that still owe
// something — a lease that pays off (or pays down below the de minimis
// threshold) simply drops out of that list entirely, so without this step
// its late_cycles row, and any still-draft notice attached to it, would
// stay open forever: a tenant who paid would keep showing up as needing a
// notice. sendNotice.ts already has a similar "stale-draft protection"
// check, but only at the moment someone clicks Send — this runs it
// proactively every day so a paid lease disappears from the review queue
// the same day it's paid, not only when someone tries to send its notice.
export async function reconcileClosedCycles(
  jobPool: Pool,
  outstandingBalances: Array<{ leaseId: string; balance: number }>,
  deMinimisThreshold: number,
  trace: ReturnType<typeof startTrace>
): Promise<{ cyclesReconciled: number; noticesAutoVoided: number; errors: string[] }> {
  const balanceByBuildiumLeaseId = new Map(outstandingBalances.map((b) => [b.leaseId, b.balance]));
  const errors: string[] = [];
  let cyclesReconciled = 0;
  let noticesAutoVoided = 0;

  const openCycles = await jobPool.query<{ id: number; lease_id: number; property_id: number; buildium_lease_id: string }>(
    `SELECT lc.id, lc.lease_id, l.property_id, l.buildium_lease_id
     FROM late_cycles lc
     JOIN leases l ON l.id = lc.lease_id
     WHERE lc.closed_at IS NULL`
  );

  for (const cycle of openCycles.rows) {
    const span = childSpan(trace);
    try {
      // Absent from the balances list means Buildium reports zero/credit
      // balance for this lease (see fetchOutstandingBalances's doc comment)
      // — not an error, and not "still owes money."
      const currentBalance = balanceByBuildiumLeaseId.get(cycle.buildium_lease_id) ?? 0;
      if (currentBalance > 0 && currentBalance >= deMinimisThreshold) {
        continue; // still genuinely late — leave the cycle open
      }

      const closedReason = currentBalance <= 0 ? "paid_in_full" : "paid_below_threshold";
      const voidReason =
        closedReason === "paid_in_full"
          ? "Tenant paid the balance in full before the notice was sent (reconciled automatically by the daily job)."
          : "Tenant's balance dropped below the de minimis threshold before the notice was sent (reconciled automatically by the daily job).";

      await jobPool.query("UPDATE late_cycles SET closed_at = now(), closed_reason = $1 WHERE id = $2", [
        closedReason,
        cycle.id,
      ]);
      cyclesReconciled += 1;

      // Only a still-draft notice gets auto-voided — a notice that was
      // already sent while the debt was outstanding is a legitimate
      // historical record and must not be touched.
      const voided = await jobPool.query<{ id: number }>(
        `UPDATE notices SET status = 'voided', voided_at = now(), voided_reason = $1
         WHERE late_cycle_id = $2 AND status = 'draft'
         RETURNING id`,
        [voidReason, cycle.id]
      );
      if (voided.rows.length > 0) {
        noticesAutoVoided += 1;
      }

      await writeAuditLog(jobPool, {
        companyId: "limehouse-pm",
        instanceId: "late-rent-notices",
        decisionId: voided.rows.length > 0 ? `notice-${voided.rows[0].id}` : undefined,
        actorType: "system",
        actorId: "daily_lateness_check",
        eventType: "late_cycle.closed",
        eventSummary:
          `Late cycle ${cycle.id} closed (${closedReason})` +
          (voided.rows.length > 0 ? `, voided draft notice ${voided.rows[0].id}` : ""),
        eventData: { closedReason, currentBalance, deMinimisThreshold },
        contextSnapshot: { leaseId: cycle.lease_id, lateCycleId: cycle.id },
        privacyCategory: "Aggregation",
        regulationTags: ["VRLTA"],
        riskLevel: "low",
        propertyId: cycle.property_id,
        legalBasis: "payment_received",
        retentionPolicy: "retain_7_years_post_tenancy",
        trace: span,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`Late cycle ${cycle.id} (lease ${cycle.lease_id}) reconciliation: ${message}`);
      logError("daily lateness check: error reconciling late cycle", {
        traceId: span.trace_id,
        error: message,
      });
    }
  }

  return { cyclesReconciled, noticesAutoVoided, errors };
}

// Resolves which late_cycles row a qualifying lease's notice should attach
// to for a given due date — first-ever cycle, an already-open one, or a
// REOPEN of a previously-closed one (migration 0042). A cycle gets closed
// when a balance check shows the tenant paid (reconcileClosedCycles above,
// or staleDraftCheck.ts); if that payment later bounces (NSF) or is
// otherwise reversed, the tenant is delinquent again for the SAME rent
// period, and this is what notices a fresh notice is needed rather than
// silently doing nothing until a LATER due date makes them qualify again.
//
// A reopen never touches the closed row it's reopening from — it inserts a
// brand-new late_cycles row (higher cycle_attempt, reopened_from_cycle_id
// pointing back to it) so the original stays exactly as it was,
// permanently, as audit history. notices.late_cycle_id stays UNIQUE
// unchanged; the caller's existing "draft a fresh notice for this
// lateCycleId" step (ON CONFLICT (late_cycle_id) DO NOTHING) works
// unmodified since a reopened cycle always starts with zero notices.
export async function resolveLateCycleId(
  jobPool: Pool,
  params: { leaseId: number; propertyId: number; dueDateStr: string; deMinimisConfigId: number; trace: ReturnType<typeof startTrace> }
): Promise<number> {
  const mostRecent = await jobPool.query<{ id: number; closed_at: Date | null; cycle_attempt: number }>(
    "SELECT id, closed_at, cycle_attempt FROM late_cycles WHERE lease_id = $1 AND due_date = $2 ORDER BY cycle_attempt DESC LIMIT 1",
    [params.leaseId, params.dueDateStr]
  );

  if (mostRecent.rows.length === 0) {
    // First-ever cycle for this lease+due_date — same happy path as
    // before (cycle_attempt defaults to 1). ON CONFLICT DO NOTHING +
    // refetch preserves the original idempotency guarantee: a second
    // same-day run of this job is a no-op insert, not a second notice.
    const inserted = await jobPool.query<{ id: number }>(
      `INSERT INTO late_cycles (lease_id, due_date, de_minimis_config_id, opened_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (lease_id, due_date, cycle_attempt) DO NOTHING
       RETURNING id`,
      [params.leaseId, params.dueDateStr, params.deMinimisConfigId]
    );
    if (inserted.rows.length > 0) {
      return inserted.rows[0].id;
    }
    const refetch = await jobPool.query<{ id: number }>(
      "SELECT id FROM late_cycles WHERE lease_id = $1 AND due_date = $2 AND cycle_attempt = 1",
      [params.leaseId, params.dueDateStr]
    );
    return refetch.rows[0].id;
  }

  if (mostRecent.rows[0].closed_at === null) {
    // Already open — same due date, already being worked (or a notice
    // already drafted for it). Identical to the original behavior.
    return mostRecent.rows[0].id;
  }

  // Reopen case: the most recent attempt for this due date was closed
  // (e.g. paid_in_full), but the tenant is delinquent again for the SAME
  // rent period — a bounced/reversed payment.
  const previousCycleId = mostRecent.rows[0].id;
  const nextAttempt = mostRecent.rows[0].cycle_attempt + 1;
  const reopened = await jobPool.query<{ id: number }>(
    `INSERT INTO late_cycles (lease_id, due_date, de_minimis_config_id, opened_at, cycle_attempt, reopened_from_cycle_id)
     VALUES ($1, $2, $3, now(), $4, $5)
     ON CONFLICT (lease_id, due_date, cycle_attempt) DO NOTHING
     RETURNING id`,
    [params.leaseId, params.dueDateStr, params.deMinimisConfigId, nextAttempt, previousCycleId]
  );
  let lateCycleId: number;
  if (reopened.rows.length > 0) {
    lateCycleId = reopened.rows[0].id;
  } else {
    const refetch = await jobPool.query<{ id: number }>(
      "SELECT id FROM late_cycles WHERE lease_id = $1 AND due_date = $2 AND cycle_attempt = $3",
      [params.leaseId, params.dueDateStr, nextAttempt]
    );
    lateCycleId = refetch.rows[0].id;
  }

  await writeAuditLog(jobPool, {
    companyId: "limehouse-pm",
    instanceId: "late-rent-notices",
    actorType: "system",
    actorId: "daily_lateness_check",
    eventType: "late_cycle.reopened",
    eventSummary:
      `Late cycle reopened for lease ${params.leaseId}, due date ${params.dueDateStr}: balance is owed again ` +
      `after being closed (previous cycle ${previousCycleId}), now reversed — e.g. an NSF bounce.`,
    eventData: { previousCycleId, newCycleId: lateCycleId, cycleAttempt: nextAttempt },
    contextSnapshot: { leaseId: params.leaseId, dueDate: params.dueDateStr },
    privacyCategory: "Aggregation",
    regulationTags: ["VRLTA"],
    riskLevel: "high",
    propertyId: params.propertyId,
    legalBasis: "payment_reversed_reopen",
    retentionPolicy: "retain_7_years_post_tenancy",
    trace: params.trace,
  });

  return lateCycleId;
}

// The daily job, scheduled for 10:00 EST (after the prior day's Buildium
// payment postings have settled — see scheduler.ts for the business-day-
// aware scheduling logic). This function assumes it is being called at
// the right time; it does not itself decide whether "now" is correct.
//
// Restructured after testing against the real Buildium account: a single
// bulk call to /leases/outstandingbalances replaces what was previously an
// N+1 per-lease balance fetch — that endpoint only returns leases that
// actually have a balance owed (zero/credit-balance leases are absent from
// the results), and it also returns EvictionPendingDate per lease, so the
// eviction-pending auto-exclusion backstop comes for free in the same call
// that gets the balance, not a separate lookup.
export async function runDailyLatenessCheck(jobPool: Pool): Promise<DailyJobResult> {
  const env = loadEnv();
  const trace = startTrace();
  const errors: string[] = [];
  let noticesDrafted = 0;
  let excludedCount = 0;
  const unassignedPropertyIssues: UnassignedPropertyIssue[] = [];

  await syncBuildiumData(jobPool);

  const { id: deMinimisConfigId, amount: deMinimisThreshold } = await getDeMinimisThreshold(jobPool);
  const outstandingBalances = await fetchOutstandingBalances();

  const reconciliation = await reconcileClosedCycles(jobPool, outstandingBalances, deMinimisThreshold, trace);
  errors.push(...reconciliation.errors);

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  for (const balanceRow of outstandingBalances) {
    const leaseSpan = childSpan(trace);
    try {
      const leaseResult = await jobPool.query<LeaseRow>(
        "SELECT id, property_id, rent_due_day, grace_period_days, buildium_lease_id FROM leases WHERE buildium_lease_id = $1 AND lease_status = 'Active'",
        [balanceRow.leaseId]
      );
      if (leaseResult.rows.length === 0) {
        // Has a balance per Buildium but isn't in our local active-lease
        // cache yet (sync ordering, or a lease that's Active in Buildium
        // but our sync hasn't caught up) — skip this run, pick up next.
        continue;
      }
      const lease = leaseResult.rows[0];

      // Eviction-pending auto-exclusion backstop (Jason's explicit choice,
      // alongside the manual exclusion list — not a replacement for it).
      if (balanceRow.evictionPendingDate !== null) {
        excludedCount += 1;
        await writeAuditLog(jobPool, {
          companyId: "limehouse-pm",
          instanceId: "late-rent-notices",
          actorType: "system",
          actorId: "daily_lateness_check",
          eventType: "exclusion.applied",
          eventSummary: `Lease excluded from late-rent check: Buildium reports eviction pending since ${balanceRow.evictionPendingDate}`,
          eventData: { source: "buildium_eviction_pending_backstop", evictionPendingDate: balanceRow.evictionPendingDate },
          contextSnapshot: { leaseId: lease.id },
          privacyCategory: "Decisional Interference",
          regulationTags: ["VRLTA"],
          riskLevel: "low",
          propertyId: lease.property_id,
          legalBasis: "eviction_pending_backstop",
          retentionPolicy: "retain_7_years_post_tenancy",
          trace: leaseSpan,
        });
        continue;
      }

      // Manual exclusion list (payment plan / dispute / other) — separate
      // from the Buildium eviction-pending backstop above.
      const exclusion = await jobPool.query(
        "SELECT id, reason_category FROM exclusions WHERE lease_id = $1 AND active = true",
        [lease.id]
      );
      if (exclusion.rows.length > 0) {
        excludedCount += 1;
        await writeAuditLog(jobPool, {
          companyId: "limehouse-pm",
          instanceId: "late-rent-notices",
          actorType: "system",
          actorId: "daily_lateness_check",
          eventType: "exclusion.applied",
          eventSummary: `Lease excluded from late-rent check (category: ${exclusion.rows[0].reason_category})`,
          eventData: { source: "manual_exclusion_list", excludedCategory: exclusion.rows[0].reason_category },
          contextSnapshot: { leaseId: lease.id },
          privacyCategory: "Decisional Interference",
          regulationTags: ["VRLTA"],
          riskLevel: "low",
          propertyId: lease.property_id,
          legalBasis: "manual_exclusion_list",
          retentionPolicy: "retain_7_years_post_tenancy",
          trace: leaseSpan,
        });
        continue;
      }

      const lateness = calculateLateness({
        rentDueDay: lease.rent_due_day,
        gracePeriodDays: lease.grace_period_days,
        balance: balanceRow.balance,
        today,
        deMinimisThreshold,
      });

      if (!lateness.qualifiesForNotice) {
        continue;
      }

      const dueDateStr = lateness.dueDate.toISOString().slice(0, 10);
      const lateCycleId = await resolveLateCycleId(jobPool, {
        leaseId: lease.id,
        propertyId: lease.property_id,
        dueDateStr,
        deMinimisConfigId,
        trace: leaseSpan,
      });

      const activeTemplate = await jobPool.query<{ id: number }>(
        "SELECT id FROM letter_templates WHERE is_active = true LIMIT 1"
      );
      if (activeTemplate.rows.length === 0) {
        throw new Error("No active letter_templates row found — cannot draft notices.");
      }

      const assignedPm = await jobPool.query<{ pm_user_id: number }>(
        "SELECT pm_user_id FROM pm_property_assignments WHERE property_id = $1 LIMIT 1",
        [lease.property_id]
      );
      if (assignedPm.rows.length === 0) {
        // A genuinely delinquent lease with no one to draft the notice to
        // review/send — this used to only land in the ephemeral `errors`
        // array (logged, never actually seen by Jason). Collected here so
        // it can be surfaced in a real alert below: a property silently
        // missing a PM assignment should never be a "discover it by
        // accident" problem.
        const propertyResult = await jobPool.query<{ name: string }>("SELECT name FROM properties WHERE id = $1", [
          lease.property_id,
        ]);
        unassignedPropertyIssues.push({
          leaseId: lease.id,
          propertyId: lease.property_id,
          propertyName: propertyResult.rows[0]?.name ?? `property ${lease.property_id}`,
          amountOwed: balanceRow.balance,
          dueDate: lateness.dueDate.toISOString().slice(0, 10),
        });
        errors.push(`Lease ${lease.id}: no PM assigned to property ${lease.property_id}, skipping draft`);
        continue;
      }

      const draftResult = await jobPool.query<{ id: number }>(
        `INSERT INTO notices (
           late_cycle_id, lease_id, status, amount_due_at_draft, days_late_at_draft,
           letter_template_id, assigned_pm_id
         ) VALUES ($1,$2,'draft',$3,$4,$5,$6)
         ON CONFLICT (late_cycle_id) DO NOTHING
         RETURNING id`,
        [
          lateCycleId,
          lease.id,
          balanceRow.balance,
          lateness.daysLate,
          activeTemplate.rows[0].id,
          assignedPm.rows[0].pm_user_id,
        ]
      );

      if (draftResult.rows.length === 0) {
        // Duplicate guard caught it — a notice already exists for this
        // late cycle. Nothing to do.
        continue;
      }

      const noticeId = draftResult.rows[0].id;
      noticesDrafted += 1;

      // Itemized charge breakdown, snapshotted at draft time (migration
      // 0038). If any charge line can't be safely classified into
      // rent/late_fee/other, fetchAndClassifyLeaseCharges throws
      // UnclassifiedChargeBlockedError — caught by this lease's try/catch
      // below like any other per-lease failure, landing in `errors` for a
      // human to review. The notice row itself is intentionally left in
      // place without line items rather than rolled back, matching this
      // job's existing no-transaction, best-effort-per-lease pattern; a
      // notice missing its itemization is visibly incomplete (Judge/TARS
      // can check for notices with zero notice_line_items rows), which is
      // safer than either silently guessing a bucket or aborting the whole
      // day's run over one lease's chart-of-accounts problem.
      const classifiedBalance = await fetchAndClassifyLeaseCharges(lease.buildium_lease_id);
      await insertNoticeLineItems(jobPool, noticeId, "draft", classifiedBalance.positiveLines);

      // Recipients: every listed tenant on the lease gets a "to" entry
      // (roommates/co-signers all receive the notice, not just one), plus
      // the assigned PM as "cc". Email addresses are frozen here, at draft
      // time, per notice_recipients.email_address design intent.
      const tenants = await jobPool.query<{ id: number; email: string }>(
        "SELECT id, email FROM lease_tenants WHERE lease_id = $1",
        [lease.id]
      );
      for (const tenant of tenants.rows) {
        await jobPool.query(
          `INSERT INTO notice_recipients (notice_id, recipient_type, lease_tenant_id, email_address)
           VALUES ($1, 'to', $2, $3)`,
          [noticeId, tenant.id, tenant.email]
        );
      }
      const pmEmail = await jobPool.query<{ email: string }>(
        "SELECT email FROM pm_users WHERE id = $1",
        [assignedPm.rows[0].pm_user_id]
      );
      await jobPool.query(
        `INSERT INTO notice_recipients (notice_id, recipient_type, pm_user_id, email_address)
         VALUES ($1, 'cc', $2, $3)`,
        [noticeId, assignedPm.rows[0].pm_user_id, pmEmail.rows[0].email]
      );

      await writeAuditLog(jobPool, {
        companyId: "limehouse-pm",
        instanceId: "late-rent-notices",
        decisionId: `notice-${noticeId}`,
        actorType: "system",
        actorId: "daily_lateness_check",
        eventType: "notice.drafted",
        eventSummary: `Draft 14-day notice created for lease ${lease.id}, ${lateness.daysLate} days late`,
        eventData: {
          shadowMode: env.SHADOW_MODE,
          deMinimisConfigId,
          gracePeriodDays: lease.grace_period_days,
        },
        contextSnapshot: {
          leaseId: lease.id,
          noticeId,
          daysLate: lateness.daysLate,
          amountDue: balanceRow.balance,
        },
        privacyCategory: "Aggregation",
        regulationTags: ["VRLTA"],
        riskLevel: "high",
        propertyId: lease.property_id,
        legalBasis: "lease_terms_and_vrlta_55.1-1245",
        retentionPolicy: "retain_7_years_post_tenancy",
        trace: leaseSpan,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`Lease (buildium id ${balanceRow.leaseId}): ${message}`);
      logError("daily lateness check: error processing lease", {
        traceId: leaseSpan.trace_id,
        error: message,
      });
    }
  }

  // Safeguard: a genuinely delinquent tenant whose property has no PM
  // assigned would otherwise sit invisible — no notice drafted, and (since
  // RLS scopes every PM's view to their own assigned doors) not visible to
  // anyone in the app either, including Jason. Real money owed should never
  // depend on someone noticing this by accident.
  if (unassignedPropertyIssues.length > 0) {
    try {
      await sendAlert({
        to: env.JASON_ALERT_EMAIL,
        subject: `ACTION NEEDED: ${unassignedPropertyIssues.length} propert${unassignedPropertyIssues.length === 1 ? "y needs" : "ies need"} a manager assigned before a late notice can go out`,
        body:
          `Today's late-rent check found ${unassignedPropertyIssues.length} genuinely delinquent lease(s) whose ` +
          `property has no property manager assigned. No notice was drafted for any of them — this system will ` +
          `never draft a legal notice with nobody accountable to review and send it.\n\n` +
          unassignedPropertyIssues
            .map((i) => `- ${i.propertyName} (lease ${i.leaseId}): owes ${formatCurrency(i.amountOwed)}, due ${i.dueDate}`)
            .join("\n") +
          `\n\nAssign a property manager to each of these properties (pm_property_assignments) — the next daily ` +
          `run will pick them up automatically once assigned.`,
      });
    } catch (err) {
      // Same principle as jobRunner.ts's job-failure alert: the alert path
      // itself failing must never mask or block the job's own success —
      // log loudly, don't throw.
      logError("failed to send unassigned-property alert", {
        traceId: trace.trace_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logInfo("daily lateness check complete", {
    traceId: trace.trace_id,
    leasesChecked: outstandingBalances.length,
    noticesDrafted,
    excludedCount,
    cyclesReconciled: reconciliation.cyclesReconciled,
    noticesAutoVoided: reconciliation.noticesAutoVoided,
    unassignedPropertyCount: unassignedPropertyIssues.length,
    errorCount: errors.length,
  });

  return {
    leasesChecked: outstandingBalances.length,
    noticesDrafted,
    excludedCount,
    cyclesReconciled: reconciliation.cyclesReconciled,
    noticesAutoVoided: reconciliation.noticesAutoVoided,
    unassignedPropertyCount: unassignedPropertyIssues.length,
    errors,
  };
}
