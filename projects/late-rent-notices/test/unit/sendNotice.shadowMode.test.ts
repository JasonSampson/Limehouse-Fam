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
  // Real implementation is a live Buildium call — never used from a test.
  // staleDraftCheck.ts (called internally by sendNotice.ts's stale-draft
  // guard) now classifies the live balance on every call (2026-08-14 fix),
  // so this needs a resolved value; set to a real "Rent Income" GL account
  // (TEST_RENT_GL_ID below) in beforeEach so the balancesByGl fixtures
  // resolve to the rent bucket instead of throwing UnclassifiedChargeError.
  fetchGlAccountsById: vi.fn(),
}));
vi.mock("../../src/lib/config.js", () => ({
  getDeMinimisThreshold: vi.fn(),
  getEstimatedCourtCosts: vi.fn(),
  getEstimatedAttorneyFees: vi.fn(),
}));
vi.mock("../../src/lib/noticeLineItems.js", async (importOriginal) => {
  // classifyBalanceLines/rentEquivalentBalance are pure, no external calls —
  // safe to use the real implementations so this test proves staleDraftCheck
  // actually classifies rather than asserting against a second hand-rolled
  // fake of the same logic. fetchAndClassifyLeaseCharges (a real Buildium
  // fetch) and insertNoticeLineItems (a real DB write) stay manual mocks.
  const actual = await importOriginal<typeof import("../../src/lib/noticeLineItems.js")>();
  return {
    ...actual,
    fetchAndClassifyLeaseCharges: vi.fn(),
    insertNoticeLineItems: vi.fn(),
    UnclassifiedChargeBlockedError: class UnclassifiedChargeBlockedError extends Error {},
  };
});
vi.mock("../../src/email/graphMailer.js", () => ({
  sendGraphMail: vi.fn(),
}));
vi.mock("../../src/lib/auditLog.js", () => ({
  writeAuditLog: vi.fn(),
}));
vi.mock("../../src/integrations/leadSimpleClient.js", () => ({
  mirrorNoticeToLeadSimple: vi.fn().mockResolvedValue({ mirrored: false, skippedReason: "not_configured" }),
}));
vi.mock("../../src/lib/appLogger.js", () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

import type { BuildiumGlAccount } from "../../src/buildium/client.js";
import { loadEnv } from "../../src/config/env.js";
import { fetchLeaseOutstandingBalance, fetchGlAccountsById } from "../../src/buildium/client.js";
import { getDeMinimisThreshold, getEstimatedCourtCosts, getEstimatedAttorneyFees } from "../../src/lib/config.js";
import { fetchAndClassifyLeaseCharges, insertNoticeLineItems } from "../../src/lib/noticeLineItems.js";
import { sendGraphMail } from "../../src/email/graphMailer.js";
import { writeAuditLog } from "../../src/lib/auditLog.js";
import { logInfo } from "../../src/lib/appLogger.js";
import { sendNotice } from "../../src/lib/sendNotice.js";

const loadEnvMock = vi.mocked(loadEnv);
const fetchLeaseOutstandingBalanceMock = vi.mocked(fetchLeaseOutstandingBalance);
const fetchGlAccountsByIdMock = vi.mocked(fetchGlAccountsById);
const getDeMinimisThresholdMock = vi.mocked(getDeMinimisThreshold);
const getEstimatedCourtCostsMock = vi.mocked(getEstimatedCourtCosts);
const getEstimatedAttorneyFeesMock = vi.mocked(getEstimatedAttorneyFees);
const fetchAndClassifyLeaseChargesMock = vi.mocked(fetchAndClassifyLeaseCharges);
const insertNoticeLineItemsMock = vi.mocked(insertNoticeLineItems);
const sendGraphMailMock = vi.mocked(sendGraphMail);
const writeAuditLogMock = vi.mocked(writeAuditLog);
const logInfoMock = vi.mocked(logInfo);

// Real "Rent Income" GL account (matching Buildium's actual default-account
// shape — see glClassification.ts) — every balancesByGl fixture below that
// represents a genuine still-owed balance uses this id so staleDraftCheck's
// classification resolves it to the rent bucket, not "unclassifiable."
const TEST_RENT_GL_ID = 3;
const TEST_RENT_GL_ACCOUNT: BuildiumGlAccount = {
  Id: TEST_RENT_GL_ID,
  Name: "Rent Income",
  Type: "Income",
  SubType: "Income",
  DefaultAccountName: "Rent Income",
  IsDefaultGLAccount: true,
};

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
    // Deliberately DIFFERENT from the sending PM's own name below (Alex
    // Rivera) — this is exactly the distinction Jason's 2026-08-05 fix is
    // about: the notice is assigned to Dana, but Alex is the one clicking
    // Send, so the signature must show Alex, not Dana.
    assigned_pm_name: "Dana Sampson",
  };
  const templateRow = {
    subject_line: "14-Day Notice — {{unit_label}}",
    body_markdown: "Dear {{tenant_name}}, you owe {{amount_due}}. Signed, {{pm_name}}.",
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
    if (sql.includes("FROM pm_users")) {
      // The sending staff member's identity — arrives via their LimeHQ
      // login and resolves to this pm_users row. The live-mode test below
      // asserts the Graph send goes out FROM this person's own mailbox,
      // and that the notice's own signature line shows THEIR name, not
      // the assigned PM's (Dana, above).
      return {
        rows: [{ id: 9, display_name: "Alex Rivera", email: "alex@limehousepm.com", leadsimple_user_id: "ls-user-alex" }],
      };
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
    fetchGlAccountsByIdMock.mockResolvedValue(new Map([[TEST_RENT_GL_ID, TEST_RENT_GL_ACCOUNT]]));
    fetchLeaseOutstandingBalanceMock.mockResolvedValue({
      leaseId: "2317038",
      balance: 1500,
      evictionPendingDate: null,
      balancesByGl: [{ glAccountId: TEST_RENT_GL_ID, balance: 1500 }],
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
        // Jason's decision: the notice goes out FROM the staff member who
        // clicked Send (their own Microsoft 365 mailbox), not a shared
        // compliance address — identity flows in via their LimeHQ login.
        senderMailbox: "alex@limehousepm.com",
        // Cover email, not the full legal text a second time — Jason's
        // correction, 2026-08-05. The signature check for THIS same
        // correction lives in the "signs the real PDF..." test below,
        // since the signature line only ever lived in the legal document,
        // never in this short cover note.
        bodyHtml: expect.stringContaining("Good "),
      })
    );
    expect(result).toEqual({ sent: true, voided: false });
  });

  it("signs the real PDF attachment with the actual sender (Alex), never the PM the notice happens to be assigned to (Dana)", async () => {
    loadEnvMock.mockReturnValue(fakeEnv({ SHADOW_MODE: false }));
    const client = makeFakeClient();

    await sendNotice(client, baseParams);

    const attachment = sendGraphMailMock.mock.calls[0][0].attachments[0];
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: attachment.contentBytes });
    const { text } = await parser.getText();

    // Jason's correction, 2026-08-05: the PDF's own "BY: {name}" signature
    // line must show whoever actually clicked Send, not the PM the
    // lease/notice happens to be assigned to — a real bug caught the
    // first time someone other than the assigned PM sent a real notice.
    expect(text).toContain("BY: Alex Rivera");
    expect(text).not.toContain("Dana Sampson");
  }, 30000);

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
