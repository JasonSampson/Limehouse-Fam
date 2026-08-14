import type { Pool, PoolClient } from "pg";
import {
  fetchLeaseOutstandingBalance,
  fetchGlAccountsById,
  type BuildiumGlAccount,
  type LeaseBalanceByGl,
} from "../buildium/client.js";
import {
  classifyGlAccount,
  UnclassifiableChargeError,
  EXCLUDED_NOT_A_CHARGE,
  type GlAccountForClassification,
  type NoticeLineItemBucket,
} from "../buildium/glClassification.js";

// Shared by dailyLatenessCheck.ts (snapshot_stage='draft') and
// sendNotice.ts (snapshot_stage='send') — both need the exact same
// fetch-charges -> resolve-GL-accounts -> classify -> insert flow, per
// migration 0038's design (same shape captured twice, never overwritten).

export class UnclassifiedChargeBlockedError extends Error {
  constructor(
    message: string,
    public readonly buildiumLeaseId: string,
    public readonly unclassifiable: { chargeId: number; glAccountId: number; glAccountName: string; amount: number }[]
  ) {
    super(message);
    this.name = "UnclassifiedChargeBlockedError";
  }
}

interface ClassifiedLine {
  bucket: NoticeLineItemBucket;
  buildiumGlAccountId: string;
  glAccountName: string;
  glAccountType: string | null;
  glAccountSubtype: string | null;
  description: string | null;
  amount: number;
  chargeDate: string | null; // YYYY-MM-DD; null because a balance bucket is a
  // point-in-time "currently owed" figure, not a single dated charge — see
  // fetchAndClassifyLeaseCharges below.
}

function toClassificationInput(glAccount: BuildiumGlAccount): GlAccountForClassification {
  return {
    id: glAccount.Id,
    name: glAccount.Name,
    type: glAccount.Type,
    subType: glAccount.SubType,
    defaultAccountName: glAccount.DefaultAccountName,
    isDefaultGLAccount: glAccount.IsDefaultGLAccount,
  };
}

// Every classified GL balance line, POSITIVE and NEGATIVE, plus which bucket
// it nets into. `positiveLines` (amount > 0) is what actually gets displayed/
// inserted as notice_line_items rows; `bucketTotals` is the fully-netted sum
// per bucket (including negative/credit lines) — see the big comment on
// fetchAndClassifyLeaseCharges below for why both are needed.
export interface ClassifiedBalance {
  positiveLines: ClassifiedLine[];
  bucketTotals: Record<NoticeLineItemBucket, number>;
}

// Fetches a lease's CURRENT outstanding balance, broken down per GL account
// (Buildium's own `Balances` array on /leases/outstandingbalances — already
// netted against payments, NOT a sum of historical charges), resolves each
// GL account, and classifies each balance into a notice_line_items bucket.
// Never returns a partial/best-guess result: if any balance line can't be
// cleanly classified, the whole call throws UnclassifiedChargeBlockedError
// instead of silently dropping that dollar amount from what becomes a legal
// notice.
//
// IMPORTANT — this deliberately does NOT use fetchLeaseCharges() /
// /leases/{id}/charges. That endpoint returns every charge ever posted since
// the lease began, with no way to tell paid from unpaid. Summing it produces
// a number with no relationship to what's actually owed today — confirmed
// live on real lease 2317038: summing 3 years of charges gave $110,044.67
// against a real current balance of $3,115.95. The `Balances` array used
// here is Buildium's own current-balance-by-GL-account breakdown; verified
// live that sum(Balances[].TotalBalance) === TotalBalance for every one of
// 57 real leases with a nonzero balance, so classifying and summing THIS
// array is guaranteed to reconcile to the real total, by construction.
//
// NEGATIVE (credit) balance lines: a per-GL-account balance can be negative
// even when the lease's overall TotalBalance is positive — confirmed live on
// real leases 2490757 and 2687271, both carrying a -$25 credit on "Admin
// Manual Payment Process Fee" (GL 812829) while still owing money overall.
// That credit is a real, current offset against what's owed — dropping it
// (treating it as "nothing to itemize") makes the bucket sums $25 too HIGH
// vs. the true balance, reintroducing exactly the kind of mismatch this fix
// exists to eliminate. So every balance line, positive or negative, is
// classified and netted into bucketTotals. Only strictly-positive lines are
// added to positiveLines (the notice_line_items detail rows a tenant
// actually sees) — notice_line_items' ck_notice_line_items_amount_positive
// constraint requires amount > 0, and a legal notice should never display a
// negative "amount owed" line. The credit still reduces that bucket's total,
// it just isn't rendered as its own line.
export async function fetchAndClassifyLeaseCharges(buildiumLeaseId: string): Promise<ClassifiedBalance> {
  const [leaseBalance, glAccountsById] = await Promise.all([
    fetchLeaseOutstandingBalance(buildiumLeaseId),
    fetchGlAccountsById(),
  ]);

  return classifyBalanceLines(buildiumLeaseId, leaseBalance.balancesByGl, glAccountsById);
}

// The actual classify-and-sum loop, pulled out of fetchAndClassifyLeaseCharges
// so callers that already HAVE a lease's balancesByGl in hand — the daily
// job's bulk /leases/outstandingbalances call already returns it per lease —
// can classify without a second, redundant per-lease Buildium fetch.
// fetchAndClassifyLeaseCharges above is now just this function plus the
// fetch; behavior/contract (including the UnclassifiedChargeBlockedError
// "never guess" throw) is unchanged for its existing callers.
export function classifyBalanceLines(
  buildiumLeaseId: string,
  balancesByGl: LeaseBalanceByGl[],
  glAccountsById: Map<number, BuildiumGlAccount>
): ClassifiedBalance {
  const positiveLines: ClassifiedLine[] = [];
  const bucketTotals: Record<NoticeLineItemBucket, number> = { rent: 0, late_fee: 0, other: 0 };
  const unclassifiable: { chargeId: number; glAccountId: number; glAccountName: string; amount: number }[] = [];

  for (const balanceLine of balancesByGl) {
    // A zero balance on a GL account means nothing currently outstanding on
    // it — not worth resolving/classifying at all.
    if (balanceLine.balance === 0) {
      continue;
    }

    const glAccount = glAccountsById.get(balanceLine.glAccountId);
    if (!glAccount) {
      // Buildium returned a GLAccountId in the balance breakdown that isn't
      // in the chart of accounts we just fetched — should not happen, but an
      // account we cannot even identify is exactly the "don't guess" case,
      // not a bucket to fall back to.
      unclassifiable.push({
        chargeId: balanceLine.glAccountId,
        glAccountId: balanceLine.glAccountId,
        glAccountName: `<unknown GL account ${balanceLine.glAccountId}>`,
        amount: balanceLine.balance,
      });
      continue;
    }

    try {
      const bucket = classifyGlAccount(toClassificationInput(glAccount));
      if (bucket === EXCLUDED_NOT_A_CHARGE) {
        // Not a tenant charge at all (e.g. Security Deposit Liability,
        // Prepayments — see glClassification.ts's EXCLUDED_GL_ACCOUNTS
        // comment) — silently left out of the itemization entirely: not
        // summed into any bucket total, not inserted as a notice_line_items
        // row, and NOT added to `unclassifiable` below. This is different
        // from the unknown-account / UnclassifiableChargeError cases, which
        // both still block the notice for human review.
        continue;
      }
      bucketTotals[bucket] += balanceLine.balance;
      if (balanceLine.balance > 0) {
        positiveLines.push({
          bucket,
          buildiumGlAccountId: String(glAccount.Id),
          glAccountName: glAccount.Name,
          glAccountType: glAccount.Type,
          glAccountSubtype: glAccount.SubType,
          description: null, // a balance bucket has no single charge memo
          amount: balanceLine.balance,
          chargeDate: null, // a balance bucket has no single charge date
        });
      }
    } catch (err) {
      if (err instanceof UnclassifiableChargeError) {
        unclassifiable.push({
          chargeId: glAccount.Id,
          glAccountId: glAccount.Id,
          glAccountName: glAccount.Name,
          amount: balanceLine.balance,
        });
      } else {
        throw err;
      }
    }
  }

  if (unclassifiable.length > 0) {
    const summary = unclassifiable
      .map((u) => `GL ${u.glAccountId} ("${u.glAccountName}") $${u.amount}`)
      .join("; ");
    throw new UnclassifiedChargeBlockedError(
      `Lease ${buildiumLeaseId} has ${unclassifiable.length} outstanding-balance line(s) that could not be ` +
        `safely classified into rent/late_fee/other: ${summary}. Refusing to drop these amounts from a legal notice.`,
      buildiumLeaseId,
      unclassifiable
    );
  }

  return { positiveLines, bucketTotals };
}

// What actually counts as "behind on rent" for lateness/notice purposes:
// the rent bucket (which already folds in pet rent, RBP, utilities, and
// solar rent — see glClassification.ts's RENT_BUCKET_NAMES) plus the
// late_fee bucket (a late fee only ever exists because of a real rent
// delinquency in the first place). Deliberately excludes 'other' —
// Application Fee, Convenience Fee, Lease Change Fee, Tenant Lease Renewal
// Fee, and similar one-off charges are real money owed, but Jason's 2026-
// 08-14 report (1318 River Birch Run South and 1313 Tait Close both got a
// 14-day pay-or-quit notice over an unpaid $300 Lease Change Fee alone, with
// zero rent actually owed) confirmed those must never be able to trigger a
// legal rent notice on their own. They still show up itemized on a notice
// that a real rent-equivalent delinquency legitimately triggers — this
// function only governs the trigger decision, not what a triggered notice
// itemizes (see insertNoticeLineItems, which still inserts every positive
// line across all three buckets).
export function rentEquivalentBalance(bucketTotals: Record<NoticeLineItemBucket, number>): number {
  return bucketTotals.rent + bucketTotals.late_fee;
}

// Inserts one notice_line_items row per classified charge line, all at the
// given snapshot_stage, inside the caller's transaction/pool client.
export async function insertNoticeLineItems(
  db: Pool | PoolClient,
  noticeId: number,
  snapshotStage: "draft" | "send",
  lines: ClassifiedLine[]
): Promise<void> {
  for (const line of lines) {
    await db.query(
      `INSERT INTO notice_line_items (
         notice_id, snapshot_stage, bucket, buildium_gl_account_id,
         gl_account_name, gl_account_type, gl_account_subtype,
         description, amount, charge_date
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        noticeId,
        snapshotStage,
        line.bucket,
        line.buildiumGlAccountId,
        line.glAccountName,
        line.glAccountType,
        line.glAccountSubtype,
        line.description,
        line.amount,
        line.chargeDate,
      ]
    );
  }
}
