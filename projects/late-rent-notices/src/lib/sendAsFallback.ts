import type { PoolClient } from "pg";
import { sendNotice, SendBlockedError } from "./sendNotice.js";

export class FallbackCeilingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FallbackCeilingError";
  }
}

interface SendAsFallbackParams {
  noticeId: number;
  jasonPmUserId: number;
  assignedPmId: number;
  ledgerVerifiedByCaller: boolean;
  // Must be a timestamp from a FRESH re-authentication (e.g. the Entra
  // re-auth prompt completed in the last few minutes), never a stale
  // session's original login time. The caller (route handler) is
  // responsible for forcing re-auth and passing that fresh timestamp —
  // this function does not itself validate session age, only records what
  // it's given. See src/auth/requireFreshReauth.ts for the enforcement.
  reauthenticatedAt: Date;
}

// Jason acting as the fallback decision-maker for a specific lease — NOT
// an "override." This is the most consequential single action in the
// system: it requires fresh re-authentication, the same mandatory ledger-
// verification step a PM would do, and is hard-capped by the DB trigger
// on fallback_events (trg_enforce_fallback_ceiling) at >1 per assigned PM
// per month OR >10% of all notices in a trailing 30-day window. If either
// ceiling is hit, the INSERT below throws and this whole transaction rolls
// back — the notice never transitions to sent.
export async function sendAsFallback(
  client: PoolClient,
  params: SendAsFallbackParams
): Promise<{ sent: boolean; voided: boolean }> {
  // Insert the fallback_events row FIRST, in the same transaction as the
  // notices update inside sendNotice — either both happen or neither does.
  // The ceiling trigger fires on this INSERT, before any send attempt.
  try {
    await client.query(
      `INSERT INTO fallback_events (notice_id, assigned_pm_id, fallback_pm_id, occurred_at, reauthenticated_at)
       VALUES ($1, $2, $3, now(), $4)`,
      [params.noticeId, params.assignedPmId, params.jasonPmUserId, params.reauthenticatedAt]
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("Fallback ceiling exceeded")) {
      throw new FallbackCeilingError(message);
    }
    throw err;
  }

  try {
    return await sendNotice(client, {
      noticeId: params.noticeId,
      sendingPmId: params.jasonPmUserId,
      sentAsFallback: true,
      ledgerVerifiedByCaller: params.ledgerVerifiedByCaller,
    });
  } catch (err) {
    if (err instanceof SendBlockedError) {
      // Surface the same error type to the route handler; the
      // fallback_events row insert still rolls back with the rest of the
      // transaction since the caller wraps this whole call in BEGIN/COMMIT.
      throw err;
    }
    throw err;
  }
}
