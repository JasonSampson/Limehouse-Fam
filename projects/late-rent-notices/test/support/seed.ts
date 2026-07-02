import type { Pool } from "pg";

// Seeding helpers used by DB integration tests. All inserts go through the
// superuser pool (bypasses RLS entirely) — RLS should be exercised as the
// SUBJECT of a test, never accidentally as an obstacle to setting one up.

export async function seedPmUser(
  pool: Pool,
  opts: { email: string; displayName?: string; role?: "pm" | "admin_assistant" | "bookkeeping"; isFallbackDecisionMaker?: boolean }
): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO pm_users (entra_object_id, display_name, email, role, is_fallback_decision_maker)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [
      `entra-${opts.email}`,
      opts.displayName ?? opts.email,
      opts.email,
      opts.role ?? "pm",
      opts.isFallbackDecisionMaker ?? false,
    ]
  );
  return result.rows[0].id;
}

export async function seedProperty(
  pool: Pool,
  opts: { buildiumPropertyId: string; name?: string }
): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO properties (buildium_property_id, name, address_line1, city, state, postal_code, synced_at)
     VALUES ($1, $2, $3, 'Norfolk', 'VA', '23508', now())
     RETURNING id`,
    [opts.buildiumPropertyId, opts.name ?? `Property ${opts.buildiumPropertyId}`, `${opts.buildiumPropertyId} Main St`]
  );
  return result.rows[0].id;
}

export async function seedPmPropertyAssignment(pool: Pool, pmUserId: number, propertyId: number): Promise<void> {
  await pool.query(
    `INSERT INTO pm_property_assignments (pm_user_id, property_id, synced_at) VALUES ($1, $2, now())`,
    [pmUserId, propertyId]
  );
}

export async function seedLease(
  pool: Pool,
  opts: {
    buildiumLeaseId: string;
    propertyId: number;
    rentDueDay?: number;
    gracePeriodDays?: number;
    feeTermsSource?: "limehouse_standard" | "inherited_lease";
    leaseStatus?: string;
  }
): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO leases (
       buildium_lease_id, property_id, unit_buildium_id, unit_label,
       rent_due_day, grace_period_days, lease_status, synced_at, fee_terms_source
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8)
     RETURNING id`,
    [
      opts.buildiumLeaseId,
      opts.propertyId,
      `unit-${opts.buildiumLeaseId}`,
      `Unit ${opts.buildiumLeaseId}`,
      opts.rentDueDay ?? 1,
      opts.gracePeriodDays ?? 3,
      opts.leaseStatus ?? "Active",
      opts.feeTermsSource ?? "limehouse_standard",
    ]
  );
  return result.rows[0].id;
}

export async function seedLeaseTenant(
  pool: Pool,
  opts: { leaseId: number; buildiumTenantId: string; fullName?: string; email?: string }
): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO lease_tenants (lease_id, buildium_tenant_id, full_name, email, is_primary, synced_at)
     VALUES ($1, $2, $3, $4, true, now())
     RETURNING id`,
    [opts.leaseId, opts.buildiumTenantId, opts.fullName ?? "Test Tenant", opts.email ?? "tenant@example.com"]
  );
  return result.rows[0].id;
}

export async function seedActiveConfigValue(
  pool: Pool,
  opts: { configKey: string; version?: number; value: unknown; setByPmId: number; changeReason?: string }
): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO config_values (config_key, version, value, is_active, set_by_pm_id, change_reason)
     VALUES ($1, $2, $3::jsonb, true, $4, $5)
     RETURNING id`,
    [
      opts.configKey,
      opts.version ?? 1,
      JSON.stringify(opts.value),
      opts.setByPmId,
      opts.changeReason ?? "test seed",
    ]
  );
  return result.rows[0].id;
}

export async function seedLetterTemplate(
  pool: Pool,
  opts: { createdByPmId: number; templateKey?: string; version?: number }
): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO letter_templates (template_key, version, subject_line, body_markdown, is_active, created_by_pm_id, change_summary)
     VALUES ($1, $2, 'Test Subject', 'Test Body', false, $3, 'test seed')
     RETURNING id`,
    [opts.templateKey ?? "14_day_pay_or_quit", opts.version ?? 1, opts.createdByPmId]
  );
  return result.rows[0].id;
}

export async function seedLateCycle(
  pool: Pool,
  opts: { leaseId: number; deMinimisConfigId: number; dueDate?: string }
): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO late_cycles (lease_id, due_date, de_minimis_config_id, opened_at)
     VALUES ($1, $2, $3, now())
     RETURNING id`,
    [opts.leaseId, opts.dueDate ?? "2026-07-01", opts.deMinimisConfigId]
  );
  return result.rows[0].id;
}

export async function seedNotice(
  pool: Pool,
  opts: {
    lateCycleId: number;
    leaseId: number;
    letterTemplateId: number;
    assignedPmId: number;
    status?: string;
    sentByPmId?: number;
    amountDueAtDraft?: number;
    daysLateAtDraft?: number;
  }
): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO notices (
       late_cycle_id, lease_id, status, amount_due_at_draft, days_late_at_draft,
       letter_template_id, assigned_pm_id, sent_by_pm_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      opts.lateCycleId,
      opts.leaseId,
      opts.status ?? "draft",
      opts.amountDueAtDraft ?? 1500,
      opts.daysLateAtDraft ?? 4,
      opts.letterTemplateId,
      opts.assignedPmId,
      opts.sentByPmId ?? null,
    ]
  );
  return result.rows[0].id;
}
