import { getAppPool } from "../db/pool.js";

// Single choke point for writing to limehq_audit_log (migration 0013) —
// anything that needs to record "who did what to what" calls this instead
// of writing its own INSERT, so the shape stays consistent as more actions
// start logging here.
//
// Named limehq_audit_log, not audit_log: this Postgres database is shared
// across all five apps in this ecosystem, and Late Rent Notices already
// owns a real, legally significant, tamper-evident audit_log table (hash-
// chained compliance records for tenant notices) in this same public
// schema. A generic "audit_log" name here would collide with it outright.
export async function writeAuditLog(args: {
  actorUserId: number;
  action: string;
  targetType: string;
  targetId: number;
  detail?: Record<string, unknown>;
}): Promise<void> {
  const pool = getAppPool();
  await pool.query(
    `INSERT INTO limehq_audit_log (actor_user_id, action, target_type, target_id, detail)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [args.actorUserId, args.action, args.targetType, args.targetId, JSON.stringify(args.detail ?? {})],
  );
}
