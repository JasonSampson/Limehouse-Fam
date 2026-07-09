import type { PoolClient } from "pg";
import { fetchLeaseOutstandingBalance } from "../buildium/client.js";
import { getDeMinimisThreshold } from "./config.js";
import { formatCurrency } from "../templates/renderTemplate.js";
import { writeAuditLog, type ActorType } from "./auditLog.js";
import type { Trace } from "./trace.js";

export interface StaleDraftCheckResult {
  voided: boolean;
  liveBalance: number;
  deMinimisThreshold: number;
}

// Re-checks a draft notice's LIVE Buildium balance and, if it's dropped to
// or below the de minimis threshold (tenant paid in full, or paid down to a
// trivial remainder), voids the notice right then instead of leaving it to
// keep showing a stale dollar amount.
//
// Originally this only ran at the moment of Send (sendNotice.ts's "stale-
// draft protection"). It's now also called from noticeRoutes.ts's review-
// page route the moment a PM opens a draft to look at it, per Jason's
// explicit report of a notice showing a stale total for a lease that had
// been paid off that same day — reviewing a notice should show the truth
// right then, not just at the moment someone clicks Send.
//
// Only touches a notice that is still 'draft' (the WHERE clause below is a
// second guard beyond whatever the caller already checked) — never voids
// or alters an already-sent notice, which is a permanent historical record.
export async function checkLiveBalanceAndVoidIfStale(
  client: PoolClient,
  params: {
    noticeId: number;
    leaseId: number;
    buildiumLeaseId: string;
    actorType: ActorType;
    actorId: string;
    // Short phrase describing when this check ran, used in the audit log
    // and voided_reason text — e.g. "at send time" or "when the notice was opened for review".
    triggerDescription: string;
    legalBasis: string;
    trace: Trace;
  }
): Promise<StaleDraftCheckResult> {
  const liveBalance = await fetchLeaseOutstandingBalance(params.buildiumLeaseId);
  const { amount: deMinimisThreshold } = await getDeMinimisThreshold(client);

  if (liveBalance.balance > deMinimisThreshold) {
    return { voided: false, liveBalance: liveBalance.balance, deMinimisThreshold };
  }

  const voidedReason = `Tenant paid down below de minimis threshold ${params.triggerDescription}.`;
  const updateResult = await client.query(
    `UPDATE notices SET status = 'voided', voided_at = now(),
       voided_reason = $1, amount_due_at_send = $2
     WHERE id = $3 AND status = 'draft'`,
    [voidedReason, liveBalance.balance, params.noticeId]
  );

  // updateResult.rowCount can be 0 if RLS blocks the write for this viewer's
  // role (e.g. bookkeeping, read-only everywhere) or a race already changed
  // the status — either way, don't claim the DB was updated when it wasn't.
  const actuallyVoided = (updateResult.rowCount ?? 0) > 0;

  if (actuallyVoided) {
    await writeAuditLog(client, {
      companyId: "limehouse-pm",
      instanceId: "late-rent-notices",
      decisionId: `notice-${params.noticeId}`,
      actorType: params.actorType,
      actorId: params.actorId,
      eventType: "notice.voided",
      eventSummary: `Notice ${params.noticeId} voided ${params.triggerDescription}: balance dropped to ${formatCurrency(liveBalance.balance)}, below threshold.`,
      eventData: { liveBalance: liveBalance.balance, deMinimisThreshold },
      contextSnapshot: { noticeId: params.noticeId, leaseId: params.leaseId },
      privacyCategory: "Aggregation",
      regulationTags: ["VRLTA"],
      riskLevel: "medium",
      legalBasis: params.legalBasis,
      retentionPolicy: "retain_7_years_post_tenancy",
      trace: params.trace,
    });
  }

  return { voided: actuallyVoided, liveBalance: liveBalance.balance, deMinimisThreshold };
}
