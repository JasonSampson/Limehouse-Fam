import type { Pool } from "pg";
import { writeAuditLog } from "./auditLog.js";
import { startTrace } from "./trace.js";

// GOVERNANCE.md Rule 10: every agent storing data for a contact must
// implement handleCCPADelete. Per Neo's data inventory: redact, never hard
// delete (FK integrity from notices/notice_recipients/late_cycles depends
// on the lease_tenants row existing). audit_log itself is the legally
// required exception — never touched here, only a new entry recording
// that the redaction happened.
export async function handleCCPADelete(pool: Pool, leaseTenantId: number): Promise<void> {
  const trace = startTrace();

  const tenantRow = await pool.query<{ id: number; lease_id: number }>(
    "SELECT id, lease_id FROM lease_tenants WHERE id = $1",
    [leaseTenantId]
  );
  if (tenantRow.rows.length === 0) {
    throw new Error(`handleCCPADelete: lease_tenants id ${leaseTenantId} not found`);
  }

  await pool.query(
    `UPDATE lease_tenants
     SET full_name = '[REDACTED]', email = $1
     WHERE id = $2`,
    [`deleted-${leaseTenantId}@redacted.invalid`, leaseTenantId]
  );

  await pool.query(
    `UPDATE notice_recipients
     SET email_address = $1
     WHERE lease_tenant_id = $2`,
    [`deleted-${leaseTenantId}@redacted.invalid`, leaseTenantId]
  );

  // Confirm completion by re-reading the redacted row back.
  const confirm = await pool.query<{ full_name: string; email: string }>(
    "SELECT full_name, email FROM lease_tenants WHERE id = $1",
    [leaseTenantId]
  );
  const confirmed = confirm.rows[0]?.full_name === "[REDACTED]";

  await writeAuditLog(pool, {
    companyId: "limehouse-pm",
    instanceId: "late-rent-notices",
    actorType: "system",
    actorId: "ccpa_delete_handler",
    eventType: "ccpa.delete_executed",
    eventSummary: `CCPA delete executed for lease_tenant ${leaseTenantId}: redacted name/email, confirmed=${confirmed}.`,
    eventData: { confirmed },
    contextSnapshot: { leaseTenantId, leaseId: tenantRow.rows[0].lease_id },
    privacyCategory: "Aggregation",
    regulationTags: ["CCPA"],
    riskLevel: "high",
    contactId: leaseTenantId,
    legalBasis: "ccpa_consumer_delete_request",
    retentionPolicy: "redacted_indefinite_retention_of_anonymized_row",
    trace,
  });

  if (!confirmed) {
    throw new Error(`handleCCPADelete: redaction did not take effect for lease_tenants id ${leaseTenantId}`);
  }
}
