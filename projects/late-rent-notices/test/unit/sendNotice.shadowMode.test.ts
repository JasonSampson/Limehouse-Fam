import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../../src/config/env.js";
import type { PoolClient } from "pg";

// Safety-critical coverage: sendNotice() (src/lib/sendNotice.ts) is "the
// single most consequential action in this system" (see its own doc
// comment) — Step 3 in its documented order of operations is the shadow-mode
// no-op that guarantees no legal 14-Day Notice email ever reaches a real
// tenant inbox without an explicit, separate decision to flip SHADOW_MODE.
// Unlike graphMailer.ts/sendAlert.ts, this check has existed since the
// start — but until now it had no automated test locking it in. This file
// proves: in shadow mode, sendGraphMail is never invoked, the notice is
// never marked 'sent' in the DB, a shadow audit-log entry is written, and
// the function still resolves { sent: false, voided: false } rather than
// throwing. It also proves the inverse (SHADOW_MODE=false really does
// attempt the Graph send) so the branch is proven real, not a check that
// happens to always take the same path.
//
// Pure unit test: DB client is a hand-rolled mock (query() driven by a
// canned response queue matching sendNotice's real query order), and every
// external module (Buildium, Graph mailer, audit log, config) is mocked —
// no real DB connection, no real network call. See vitest.config.ts.
vi.mock("../../src/config/env.js", () => ({
  loadEnv: vi.fn(),
}));
vi.mock("../../src/buildium/client.js", () => ({
  fetchLeaseOutstandingBalance: vi.fn(),
}));
vi.mock("../../src/lib/config.js", () => ({
  getDeMinimisThreshold: vi.fn(),
  getEstimatedCourtCosts: vi.fn(),
  getEstimatedAttorneyFees: vi.fn(),
}));
vi.mock("../../src/lib/noticeLineItems.js", () => ({
  fetchAndClassifyLeaseCharges: vi.fn(),
  insertNoticeLineItems: vi.fn(),
  UnclassifiedChargeBlockedError: class UnclassifiedChargeBlockedError extends Error {},
}));
vi.mock("../../src/email/graphMailer.js", () => ({
  sendGraphMail: vi.fn(),
}));
vi.mock("../../src/lib/auditLog.js", () => ({
  writeAuditLog: vi.fn(),
}));
vi.mock("../../src/lib/appLogger.js", () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

import { loadEnv } from "../../src/config/env.js";
import { fetchLeaseOutstandingBalance } from "../../src/buildium/client.js";
import { getDeMinimisThreshold, getEstimatedCourtCosts, getEstimatedAttorneyFees } from "../../src/lib/config.js";
import { fetchAndClassifyLeaseCharges, insertNoticeLineItems } from "../../src/lib/noticeLineItems.js";
import { sendGraphMail } from "../../src/email/graphMailer.js";
import { writeAuditLog } from "../../src/lib/auditLog.js";
import { logInfo } from "../../src/lib/appLogger.js";
import { sendNotice } from "../../src/lib/sendNotice.js";

const loadEnvMock = vi.mocked(loadEnv);
const fetchLeaseOutstandingBalanceMock = vi.mocked(fetchLeaseOutstandingBalance);
const getDeMinimisThresholdMock = vi.mocked(getDeMinimisThreshold);
const getEstimatedCourtCostsMock = vi.mocked(getEstimatedCourtCosts);
const getEstimatedAttorneyFeesMock = vi.mocked(getEstimatedAttorneyFees);
const fetchAndClassifyLeaseChargesMock = vi.mocked(fetchAndClassifyLeaseCharges);
const insertNoticeLineItemsMock = vi.mocked(insertNoticeLineItems);
const sendGraphMailMock = vi.mocked(sendGraphMail);
const writeAuditLogMock = vi.mocked(writeAuditLog);
const logInfoMock = vi.mocked(logInfo);

function fakeEnv(overrides: Partial<Env> = {}): Env {
  return {
    SHADOW_MODE: true,
    ...overrides,
  } as Env;
}

// Builds a fake PoolClient whose query() answers sendNotice's real,
// documented query sequence in order: (1) SELECT ... FROM notices FOR
// UPDATE, (2) SELECT ... FROM leases JOIN properties JOIN pm_users. Anything
// beyond that (the live/non-shadow path's template/recipients SELECTs and
// UPDATEs) is only reached when SHADOW_MODE=false, and is stubbed to no-op
// success so the live-mode test can also exercise the send loop.
function makeFakeClient(): PoolClient {
  const noticeRow = {
    id: 501,
    lease_id: 77,
    status: "draft",
    letter_template_id: 1,
    assigned_pm_id: 9,
  };
  const leaseRow = {
    buildium_lease_id: "2317038",
    unit_label: "Unit 4B",
    property_address: "123 Main St, Norfolk, VA 23508",
    rent_due_day: 1,
    grace_period_days: 3,
    assigned_pm_name: "Alex Rivera",
  };
  const templateRow = {
    subject_line: "14-Day Notice — {{unit_label}}",
    body_markdown: "Dear {{tenant_name}}, you owe {{amount_due}}.",
  };
  const recipientRows = [
    { id: 1, recipient_type: "to", email_address: "tenant@example.com", full_name: "Jane Doe" },
  ];

  const query = vi.fn(async (sql: string) => {
    if (sql.includes("FROM notices")) {
      return { rows: [noticeRow] };
    }
    if (sql.includes("FROM leases")) {
      return { rows: [leaseRow] };
    }
    if (sql.includes("FROM letter_templates")) {
      return { rows: [templateRow] };
    }
    if (sql.includes("FROM notice_recipients")) {
      return { rows: recipientRows };
    }
    // UPDATE notices / notice_recipients. rowCount: 1 matches real pg
    // behavior for an UPDATE that actually affects the target row —
    // checkLiveBalanceAndVoidIfStale (staleDraftCheck.ts) reads rowCount to
    // confirm the void write actually happened (it can legitimately be 0 if
    // RLS blocks the write for a read-only role), so the mock needs to
    // report it, not just an empty row set.
    return { rows: [], rowCount: 1 };
  });

  return { query } as unknown as PoolClient;
}

describe("sendNotice — shadow mode guard (legal 14-Day Notice send)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDeMinimisThresholdMock.mockResolvedValue({ id: 1, amount: 50 });
    getEstimatedCourtCostsMock.mockResolvedValue({ id: 1, amount: 250 });
    getEstimatedAttorneyFeesMock.mockResolvedValue({ id: 1, amount: 500 });
    fetchLeaseOutstandingBalanceMock.mockResolvedValue({
      leaseId: "2317038",
      balance: 1500,
      evictionPendingDate: null,
      balancesByGl: [],
    });
    fetchAndClassifyLeaseChargesMock.mockResolvedValue({
      positiveLines: [],
      bucketTotals: { rent: 1350, late_fee: 150, other: 0 },
    });
    insertNoticeLineItemsMock.mockResolvedValue(undefined as never);
    writeAuditLogMock.mockResolvedValue(undefined as never);
    sendGraphMailMock.mockResolvedValue({ success: true });
  });

  const baseParams = {
    noticeId: 501,
    sendingPmId: 9,
    sentAsFallback: false,
    ledgerVerifiedByCaller: true,
  };

  it("SHADOW_MODE=true: does NOT call sendGraphMail (no real email ever goes out)", async () => {
    loadEnvMock.mockReturnValue(fakeEnv({ SHADOW_MODE: true }));
    const client = makeFakeClient();

    await sendNotice(client, baseParams);

    expect(sendGraphMailMock).not.toHaveBeenCalled();
  });

  it("SHADOW_MODE=true: returns { sent: false, voided: false } without throwing", async () => {
    loadEnvMock.mockReturnValue(fakeEnv({ SHADOW_MODE: true }));
    const client = makeFakeClient();

    const result = await sendNotice(client, baseParams);

    expect(result).toEqual({ sent: false, voided: false });
  });

  it("SHADOW_MODE=true: writes a shadow_send audit log entry and logs the suppression", async () => {
    loadEnvMock.mockReturnValue(fakeEnv({ SHADOW_MODE: true }));
    const client = makeFakeClient();

    await sendNotice(client, baseParams);

    expect(writeAuditLogMock).toHaveBeenCalledWith(
      client,
      expect.objectContaining({
        eventType: "notice.shadow_send",
        riskLevel: "high",
        legalBasis: "shadow_mode_no_op",
      })
    );
    expect(logInfoMock).toHaveBeenCalledWith(
      "shadow mode: notice send suppressed",
      expect.objectContaining({ noticeId: 501 })
    );
  });

  it("SHADOW_MODE=true: never updates the notice row to status='sent' (only a shadow audit entry is written)", async () => {
    loadEnvMock.mockReturnValue(fakeEnv({ SHADOW_MODE: true }));
    const client = makeFakeClient();

    await sendNotice(client, baseParams);

    const queryMock = client.query as unknown as ReturnType<typeof vi.fn>;
    const updateSentCalls = queryMock.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].includes("status = 'sent'")
    );
    expect(updateSentCalls).toHaveLength(0);
  });

  it("SHADOW_MODE=false: DOES attempt the real Graph send — proves the guard is a real branch, not an always-no-op", async () => {
    loadEnvMock.mockReturnValue(fakeEnv({ SHADOW_MODE: false }));
    const client = makeFakeClient();

    const result = await sendNotice(client, baseParams);

    expect(sendGraphMailMock).toHaveBeenCalledTimes(1);
    expect(sendGraphMailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        toRecipients: [{ email: "tenant@example.com" }],
      })
    );
    expect(result).toEqual({ sent: true, voided: false });
  });

  it("SHADOW_MODE=false: marks the notice status='sent' in the DB (the real send path actually runs, not silently skipped)", async () => {
    loadEnvMock.mockReturnValue(fakeEnv({ SHADOW_MODE: false }));
    const client = makeFakeClient();

    await sendNotice(client, baseParams);

    const queryMock = client.query as unknown as ReturnType<typeof vi.fn>;
    const updateSentCalls = queryMock.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].includes("status = 'sent'")
    );
    expect(updateSentCalls).toHaveLength(1);
  });

  it("stale-draft void (balance paid below de minimis) short-circuits BEFORE the shadow-mode check either way — sendGraphMail is never called and no shadow audit entry is written", async () => {
    loadEnvMock.mockReturnValue(fakeEnv({ SHADOW_MODE: true }));
    fetchLeaseOutstandingBalanceMock.mockResolvedValue({
      leaseId: "2317038",
      balance: 10, // below the $50 de minimis threshold
      evictionPendingDate: null,
      balancesByGl: [],
    });
    const client = makeFakeClient();

    const result = await sendNotice(client, baseParams);

    expect(result).toEqual({ sent: false, voided: true });
    expect(sendGraphMailMock).not.toHaveBeenCalled();
    expect(writeAuditLogMock).toHaveBeenCalledWith(
      client,
      expect.objectContaining({ eventType: "notice.voided" })
    );
    const shadowSendCalls = writeAuditLogMock.mock.calls.filter(
      (c) => c[1].eventType === "notice.shadow_send"
    );
    expect(shadowSendCalls).toHaveLength(0);
  });
});
