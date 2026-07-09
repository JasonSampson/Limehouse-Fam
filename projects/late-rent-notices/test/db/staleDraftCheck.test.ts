import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { getTestSuperuserPool, truncateAllTables, closeAllTestPools } from "../support/testDb.js";
import { startTrace } from "../../src/lib/trace.js";
import {
  seedPmUser,
  seedProperty,
  seedLease,
  seedActiveConfigValue,
  seedLetterTemplate,
  seedLateCycle,
  seedNotice,
} from "../support/seed.js";

// Mocked exactly like sendNotice.shadowMode.test.ts mocks the same module —
// this is the ONE piece that genuinely talks to Buildium; everything else
// here runs against a real seeded Postgres row so the SQL/RLS/rowCount
// behavior is proven for real, not assumed.
vi.mock("../../src/buildium/client.js", () => ({
  fetchLeaseOutstandingBalance: vi.fn(),
}));

import { fetchLeaseOutstandingBalance } from "../../src/buildium/client.js";
import { checkLiveBalanceAndVoidIfStale } from "../../src/lib/staleDraftCheck.js";

const fetchLeaseOutstandingBalanceMock = vi.mocked(fetchLeaseOutstandingBalance);
const DE_MINIMIS_THRESHOLD = 100;

// Root cause of the bug Jason reported ("charges that populated today...
// total is incorrect") and its fix: a draft notice's review page (and PDF)
// now re-checks the live Buildium balance the instant it's opened, not just
// at the moment of Send. If that live check shows the tenant has since paid
// down below the de minimis threshold, the notice is voided right then —
// this is that decision logic, shared by sendNotice.ts (checked immediately
// before sending) and noticeRoutes.ts's review/PDF routes (checked on page
// load).
describe("checkLiveBalanceAndVoidIfStale", () => {
  const pool = getTestSuperuserPool();
  let pmId: number;
  let propertyId: number;
  let deMinimisConfigId: number;
  let letterTemplateId: number;

  beforeEach(async () => {
    vi.clearAllMocks();
    await truncateAllTables();
    pmId = await seedPmUser(pool, { email: "stale-check-test@limehousepm.com" });
    propertyId = await seedProperty(pool, { buildiumPropertyId: "PROP-STALE-CHECK" });
    deMinimisConfigId = await seedActiveConfigValue(pool, {
      configKey: "de_minimis_threshold_usd",
      value: DE_MINIMIS_THRESHOLD,
      setByPmId: pmId,
    });
    letterTemplateId = await seedLetterTemplate(pool, { createdByPmId: pmId });
  });

  afterAll(async () => {
    await closeAllTestPools();
  });

  it("voids a draft notice and writes the reason when the live balance is at or below the threshold", async () => {
    const leaseId = await seedLease(pool, { buildiumLeaseId: "LIVE-PAID-OFF", propertyId });
    const lateCycleId = await seedLateCycle(pool, { leaseId, deMinimisConfigId });
    const noticeId = await seedNotice(pool, { lateCycleId, leaseId, letterTemplateId, assignedPmId: pmId });
    fetchLeaseOutstandingBalanceMock.mockResolvedValue({
      leaseId: "LIVE-PAID-OFF",
      balance: 0,
      evictionPendingDate: null,
      balancesByGl: [],
    });

    const result = await checkLiveBalanceAndVoidIfStale(pool, {
      noticeId,
      leaseId,
      buildiumLeaseId: "LIVE-PAID-OFF",
      actorType: "system",
      actorId: "test",
      triggerDescription: "when the notice was opened for review",
      legalBasis: "stale_draft_protection",
      trace: startTrace(),
    });

    expect(result).toEqual({ voided: true, liveBalance: 0, deMinimisThreshold: DE_MINIMIS_THRESHOLD });

    const notice = await pool.query("SELECT status, voided_reason, amount_due_at_send FROM notices WHERE id = $1", [
      noticeId,
    ]);
    expect(notice.rows[0].status).toBe("voided");
    expect(notice.rows[0].voided_reason).toMatch(/paid down below de minimis threshold/i);
    expect(Number(notice.rows[0].amount_due_at_send)).toBe(0);
  });

  it("does NOT void a draft notice when the live balance is genuinely still above the threshold", async () => {
    const leaseId = await seedLease(pool, { buildiumLeaseId: "LIVE-STILL-OWES", propertyId });
    const lateCycleId = await seedLateCycle(pool, { leaseId, deMinimisConfigId });
    const noticeId = await seedNotice(pool, { lateCycleId, leaseId, letterTemplateId, assignedPmId: pmId });
    fetchLeaseOutstandingBalanceMock.mockResolvedValue({
      leaseId: "LIVE-STILL-OWES",
      balance: 1875.5,
      evictionPendingDate: null,
      balancesByGl: [],
    });

    const result = await checkLiveBalanceAndVoidIfStale(pool, {
      noticeId,
      leaseId,
      buildiumLeaseId: "LIVE-STILL-OWES",
      actorType: "system",
      actorId: "test",
      triggerDescription: "when the notice was opened for review",
      legalBasis: "stale_draft_protection",
      trace: startTrace(),
    });

    expect(result).toEqual({ voided: false, liveBalance: 1875.5, deMinimisThreshold: DE_MINIMIS_THRESHOLD });

    const notice = await pool.query("SELECT status FROM notices WHERE id = $1", [noticeId]);
    expect(notice.rows[0].status).toBe("draft");
  });

  it("does not touch an already-sent notice, even if the live balance has since dropped to zero", async () => {
    const leaseId = await seedLease(pool, { buildiumLeaseId: "LIVE-ALREADY-SENT", propertyId });
    const lateCycleId = await seedLateCycle(pool, { leaseId, deMinimisConfigId });
    const noticeId = await seedNotice(pool, { lateCycleId, leaseId, letterTemplateId, assignedPmId: pmId });
    await pool.query("UPDATE notices SET status = 'sent', sent_at = now(), ledger_verified = true WHERE id = $1", [
      noticeId,
    ]);
    fetchLeaseOutstandingBalanceMock.mockResolvedValue({
      leaseId: "LIVE-ALREADY-SENT",
      balance: 0,
      evictionPendingDate: null,
      balancesByGl: [],
    });

    const result = await checkLiveBalanceAndVoidIfStale(pool, {
      noticeId,
      leaseId,
      buildiumLeaseId: "LIVE-ALREADY-SENT",
      actorType: "system",
      actorId: "test",
      triggerDescription: "when the notice was opened for review",
      legalBasis: "stale_draft_protection",
      trace: startTrace(),
    });

    // The WHERE status = 'draft' guard means the UPDATE matches zero rows —
    // voided: false here reports "the DB was not changed", not "the balance
    // is fine". The already-sent notice is untouched, exactly as required.
    expect(result.voided).toBe(false);
    const notice = await pool.query("SELECT status, sent_at FROM notices WHERE id = $1", [noticeId]);
    expect(notice.rows[0].status).toBe("sent");
    expect(notice.rows[0].sent_at).not.toBeNull();
  });
});
