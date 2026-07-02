import type { Pool, PoolClient } from "pg";
import { fetchLeaseCharges, fetchGlAccountsById, type BuildiumGlAccount } from "../buildium/client.js";
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
  chargeDate: string; // YYYY-MM-DD, from Buildium's charge Date field
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

// Fetches a lease's live charges from Buildium, resolves each line's GL
// account, and classifies every line into a notice_line_items bucket. Never
// returns a partial/best-guess result: if ANY charge line can't be cleanly
// classified, the whole call throws UnclassifiedChargeBlockedError instead
// of silently dropping that dollar amount from what becomes a legal notice.
export async function fetchAndClassifyLeaseCharges(buildiumLeaseId: string): Promise<ClassifiedLine[]> {
  const [charges, glAccountsById] = await Promise.all([
    fetchLeaseCharges(buildiumLeaseId),
    fetchGlAccountsById(),
  ]);

  const classified: ClassifiedLine[] = [];
  const unclassifiable: { chargeId: number; glAccountId: number; glAccountName: string; amount: number }[] = [];

  for (const charge of charges) {
    for (const line of charge.Lines) {
      // A charge line at or below zero is a credit/refund/reversal, not a
      // charge to itemize on a legal notice demanding payment (see
      // notice_line_items' ck_notice_line_items_amount_positive constraint
      // and migration 0039's design note) — flag rather than silently drop
      // or insert an amount the DB constraint would reject anyway.
      if (line.Amount <= 0) {
        const glAccount = glAccountsById.get(line.GLAccountId);
        unclassifiable.push({
          chargeId: charge.Id,
          glAccountId: line.GLAccountId,
          glAccountName: glAccount?.Name ?? `<unknown GL account ${line.GLAccountId}>`,
          amount: line.Amount,
        });
        continue;
      }

      const glAccount = glAccountsById.get(line.GLAccountId);
      if (!glAccount) {
        // Buildium returned a GLAccountId on this charge that isn't in the
        // chart of accounts we just fetched — should not happen, but a
        // charge we cannot even identify the account for is exactly the
        // "don't guess" case, not a bucket to fall back to.
        unclassifiable.push({
          chargeId: charge.Id,
          glAccountId: line.GLAccountId,
          glAccountName: `<unknown GL account ${line.GLAccountId}>`,
          amount: line.Amount,
        });
        continue;
      }

      try {
        const bucket = classifyGlAccount(toClassificationInput(glAccount));
        if (bucket === EXCLUDED_NOT_A_CHARGE) {
          // Not a tenant charge at all (e.g. Security Deposit Liability,
          // Prepayments — see glClassification.ts's EXCLUDED_GL_ACCOUNTS
          // comment) — silently left out of the itemization entirely: not
          // summed into any bucket, not inserted as a notice_line_items row,
          // and NOT added to `unclassifiable` below. This is different from
          // the amount<=0 / unknown-account / UnclassifiableChargeError
          // cases, which all still block the notice for human review.
          continue;
        }
        classified.push({
          bucket,
          buildiumGlAccountId: String(glAccount.Id),
          glAccountName: glAccount.Name,
          glAccountType: glAccount.Type,
          glAccountSubtype: glAccount.SubType,
          description: charge.Memo,
          amount: line.Amount,
          chargeDate: charge.Date,
        });
      } catch (err) {
        if (err instanceof UnclassifiableChargeError) {
          unclassifiable.push({
            chargeId: charge.Id,
            glAccountId: glAccount.Id,
            glAccountName: glAccount.Name,
            amount: line.Amount,
          });
        } else {
          throw err;
        }
      }
    }
  }

  if (unclassifiable.length > 0) {
    const summary = unclassifiable
      .map((u) => `charge ${u.chargeId}: GL ${u.glAccountId} ("${u.glAccountName}") $${u.amount}`)
      .join("; ");
    throw new UnclassifiedChargeBlockedError(
      `Lease ${buildiumLeaseId} has ${unclassifiable.length} charge line(s) that could not be safely ` +
        `classified into rent/late_fee/other: ${summary}. Refusing to drop these amounts from a legal notice.`,
      buildiumLeaseId,
      unclassifiable
    );
  }

  return classified;
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

// Sums classified lines by bucket — used to populate the new rent/late-fee/
// misc merge fields at send time.
export function sumByBucket(lines: ClassifiedLine[]): Record<NoticeLineItemBucket, number> {
  const sums: Record<NoticeLineItemBucket, number> = { rent: 0, late_fee: 0, other: 0 };
  for (const line of lines) {
    sums[line.bucket] += line.amount;
  }
  return sums;
}
