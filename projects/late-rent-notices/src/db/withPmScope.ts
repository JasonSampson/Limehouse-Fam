import type { PoolClient } from "pg";
import { getAppPool } from "./pool.js";

// Sentinel's hard requirement: app.current_pm_id MUST be reset on every
// single request, not just set once per connection. Node's connection pool
// reuses physical sockets across different PMs' requests — without this,
// a stale value on a pooled connection is the realistic way one PM ends up
// seeing another PM's tenants. This helper is the ONLY sanctioned way the
// app touches an RLS-scoped table; never call pool.query() directly for
// PM-facing reads/writes.
//
// set_config(..., true) scopes the setting to the current transaction only,
// so it cannot leak into whatever query the connection serves next even if
// this function's caller forgets to release the client.
export async function withPmScope<T>(
  pmUserId: number,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const pool = getAppPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_pm_id', $1, true)", [String(pmUserId)]);

    // Looked up server-side from the authenticated pmUserId, never taken
    // from anything client-supplied — this is what lets the notices RLS
    // policy give a flagged fallback decision-maker visibility into a
    // draft notice that isn't assigned to them (see migration 0019). It
    // does NOT by itself authorize sending — isReauthFresh, the 2-business-
    // day deadline check, and the fallback_events ceiling trigger are the
    // actual gates on the send action; this only controls SELECT visibility.
    const pmRow = await client.query<{ is_fallback_decision_maker: boolean }>(
      "SELECT is_fallback_decision_maker FROM pm_users WHERE id = $1",
      [pmUserId]
    );
    await client.query("SELECT set_config('app.is_fallback_decision_maker', $1, true)", [
      String(pmRow.rows[0]?.is_fallback_decision_maker === true),
    ]);

    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
