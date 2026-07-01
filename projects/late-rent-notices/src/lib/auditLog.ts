import type { Pool, PoolClient } from "pg";
import type { Trace } from "./trace.js";

// GOVERNANCE.md Rule 1: every AI decision/recommendation/action gets an
// append-only audit log entry with these fields. sequence_num/prev_hash/
// entry_hash are computed by the DB trigger (migration 0015) — this writer
// never sets them itself.
export type ActorType = "system" | "pm" | "fallback_decision_maker";
export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface AuditLogEntry {
  companyId: string;
  instanceId: string;
  decisionId?: string;
  actionId?: string;
  actorType: ActorType;
  actorId: string;
  eventType: string;
  eventSummary: string;
  // event_data must be safe to store — never put raw tenant PII here if it
  // can instead live only in context_snapshot, since application logs
  // (separate from this table) must never contain full tenant PII. This
  // table IS the place full detail belongs (see CLAUDE.md/Sentinel note).
  eventData: Record<string, unknown>;
  contextSnapshot: Record<string, unknown>;
  privacyCategory: string;
  regulationTags: string[];
  riskLevel: RiskLevel;
  contactId?: number | null;
  propertyId?: number | null;
  legalBasis: string;
  retentionPolicy: string;
  trace: Trace;
}

const COMPANY_ID = "limehouse-pm";
const INSTANCE_ID = "late-rent-notices";

export async function writeAuditLog(
  db: Pool | PoolClient,
  entry: AuditLogEntry
): Promise<void> {
  const eventData = { ...entry.eventData, trace: entry.trace };

  await db.query(
    `INSERT INTO audit_log (
       company_id, instance_id, decision_id, action_id,
       actor_type, actor_id, event_type, event_summary,
       event_data, context_snapshot, privacy_category, regulation_tags,
       risk_level, contact_id, property_id, legal_basis, retention_policy
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [
      entry.companyId ?? COMPANY_ID,
      entry.instanceId ?? INSTANCE_ID,
      entry.decisionId ?? null,
      entry.actionId ?? null,
      entry.actorType,
      entry.actorId,
      entry.eventType,
      entry.eventSummary,
      JSON.stringify(eventData),
      JSON.stringify(entry.contextSnapshot),
      entry.privacyCategory,
      entry.regulationTags,
      entry.riskLevel,
      entry.contactId ?? null,
      entry.propertyId ?? null,
      entry.legalBasis,
      entry.retentionPolicy,
    ]
  );
}
