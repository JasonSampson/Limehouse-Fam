import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../../src/config/env.js";
import type { BuildiumGlAccount } from "../../src/buildium/client.js";

// Regression coverage for the 2026-08-14 fix (Sentinel/TARS/Judge review
// finding, second pass tonight): escalationCheck.ts picked up a real
// GL-classification call, a rent-equivalent-balance decision, and per-lease
// error isolation — none of it had a test before or after. This locks in:
// (1) the rent-equivalent balance (not the raw Buildium total) governs
// whether the PM gets emailed, (2) a non-rent fee never blocks the "stand
// down" path or gets misreported as "$0 owed", (3) one candidate's failure
// doesn't abort the reminder for every other expired notice that day.
vi.mock("../../src/config/env.js", () => ({
  loadEnv: vi.fn(),
}));
vi.mock("../../src/buildium/client.js", () => ({
  fetchLeaseOutstandingBalance: vi.fn(),
  fetchGlAccountsById: vi.fn(),
}));
vi.mock("../../src/lib/auditLog.js", () => ({
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/email/graphMailer.js", () => ({
  sendPmNotificationEmail: vi.fn().mockResolvedValue({ success: true }),
}));
vi.mock("../../src/lib/appLogger.js", () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
}));

import { loadEnv } from "../../src/config/env.js";
import { fetchLeaseOutstandingBalance, fetchGlAccountsById } from "../../src/buildium/client.js";
import { writeAuditLog } from "../../src/lib/auditLog.js";
import { sendPmNotificationEmail } from "../../src/email/graphMailer.js";
import { runEscalationCheck } from "../../src/jobs/escalationCheck.js";

const loadEnvMock = vi.mocked(loadEnv);
const fetchLeaseOutstandingBalanceMock = vi.mocked(fetchLeaseOutstandingBalance);
const fetchGlAccountsByIdMock = vi.mocked(fetchGlAccountsById);
const writeAuditLogMock = vi.mocked(writeAuditLog);
const sendPmNotificationEmailMock = vi.mocked(sendPmNotificationEmail);

function fakeEnv(overrides: Partial<Env> = {}): Env {
  return {
    SHADOW_MODE: true,
    JASON_ALERT_EMAIL: "jason@limehousepm.com",
    TEAMS_ALERT_WEBHOOK_URL: "https://outlook.office.com/webhook/fake-webhook-url",
    ...overrides,
  } as Env;
}

const RENT_GL_ID = 3;
const LEASE_CHANGE_FEE_GL_ID = 857392;
function fakeGlAccountsById(): Map<number, BuildiumGlAccount> {
  return new Map([
    [RENT_GL_ID, { Id: RENT_GL_ID, Name: "Rent Income", Type: "Income", SubType: "Income", DefaultAccountName: "Rent Income", IsDefaultGLAccount: true }],
    [LEASE_CHANGE_FEE_GL_ID, { Id: LEASE_CHANGE_FEE_GL_ID, Name: "Lease Change Fee", Type: "Income", SubType: "Income", DefaultAccountName: null, IsDefaultGLAccount: false }],
  ]);
}

interface CandidateRow {
  notice_id: number;
  lease_id: number;
  property_id: number;
  sent_at: Date;
  pm_email: string;
  pm_id: number;
  buildium_lease_id: string;
}

function fakeCandidate(overrides: Partial<CandidateRow> = {}): CandidateRow {
  return {
    notice_id: 1,
    lease_id: 10,
    property_id: 100,
    sent_at: new Date("2026-07-01T00:00:00Z"),
    pm_email: "dana@limehousepm.com",
    pm_id: 6,
    buildium_lease_id: "1000001",
    ...overrides,
  };
}

// Minimal fake pg Pool: the candidates SELECT is driven by an injected
// array; every INSERT is recorded and returns a synthetic success.
function fakePool(candidates: CandidateRow[]) {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const query = vi.fn(async (text: string, params?: unknown[]) => {
    calls.push({ text, params });
    if (text.includes("FROM notices n")) {
      return { rows: candidates };
    }
    if (text.includes("INSERT INTO escalation_reminders")) {
      return { rows: [], rowCount: 1 };
    }
    return { rows: [] };
  });
  return { query, calls } as unknown as { query: typeof query; calls: typeof calls };
}

describe("runEscalationCheck", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadEnvMock.mockReturnValue(fakeEnv());
    fetchGlAccountsByIdMock.mockResolvedValue(fakeGlAccountsById());
  });

  it("emails the PM and records the real balance when rent-equivalent balance is still owed", async () => {
    const candidate = fakeCandidate();
    fetchLeaseOutstandingBalanceMock.mockResolvedValue({
      leaseId: candidate.buildium_lease_id,
      balance: 1500,
      evictionPendingDate: null,
      balancesByGl: [{ glAccountId: RENT_GL_ID, balance: 1500 }],
    });
    const pool = fakePool([candidate]);

    const result = await runEscalationCheck(pool as never);

    expect(result).toEqual({ checked: 1, remindersSent: 1, errors: [] });
    expect(sendPmNotificationEmailMock).toHaveBeenCalledTimes(1);
    expect(sendPmNotificationEmailMock.mock.calls[0][0]).toBe(candidate.pm_email);
    const insertCall = pool.calls.find((c) => c.text.includes("INSERT INTO escalation_reminders"));
    expect(insertCall?.params?.[2]).toBe(1500); // real balance recorded, not the rent-equivalent figure
    expect(writeAuditLogMock).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({ eventType: "escalation.fired" })
    );
  });

  it("stands down without emailing the PM when rent is resolved, even though a non-rent fee (Lease Change Fee) is still owed", async () => {
    const candidate = fakeCandidate({ notice_id: 2, buildium_lease_id: "1000002" });
    fetchLeaseOutstandingBalanceMock.mockResolvedValue({
      leaseId: candidate.buildium_lease_id,
      balance: 300,
      evictionPendingDate: null,
      balancesByGl: [{ glAccountId: LEASE_CHANGE_FEE_GL_ID, balance: 300 }],
    });
    const pool = fakePool([candidate]);

    const result = await runEscalationCheck(pool as never);

    expect(result).toEqual({ checked: 1, remindersSent: 0, errors: [] });
    expect(sendPmNotificationEmailMock).not.toHaveBeenCalled();
    // balance_at_check is a hardcoded literal 0 on this "stood down" INSERT
    // variant (not a bound param) — reflects "rent resolved", never the raw
    // $300 non-rent balance.
    const insertCall = pool.calls.find((c) => c.text.includes("INSERT INTO escalation_reminders"));
    expect(insertCall?.text).toMatch(/VALUES \(\$1, .+, 0, \$3, now\(\)\)/);
    expect(insertCall?.params).toEqual([candidate.notice_id, candidate.sent_at, candidate.pm_id]);
    expect(writeAuditLogMock).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        eventType: "escalation.stood_down",
        eventSummary: expect.stringContaining("$300.00 in non-rent fees may still be outstanding"),
        eventData: { nonRentBalanceRemaining: 300 },
      })
    );
  });

  it("one candidate's failure doesn't abort the reminder for every other expired notice that day", async () => {
    const broken = fakeCandidate({ notice_id: 3, lease_id: 30, buildium_lease_id: "1000003" });
    const healthy = fakeCandidate({ notice_id: 4, lease_id: 40, buildium_lease_id: "1000004" });
    fetchLeaseOutstandingBalanceMock.mockImplementation(async (buildiumLeaseId: string) => {
      if (buildiumLeaseId === broken.buildium_lease_id) {
        throw new Error("Buildium API error 500 on /leases/outstandingbalances");
      }
      return {
        leaseId: buildiumLeaseId,
        balance: 900,
        evictionPendingDate: null,
        balancesByGl: [{ glAccountId: RENT_GL_ID, balance: 900 }],
      };
    });
    const pool = fakePool([broken, healthy]);

    const result = await runEscalationCheck(pool as never);

    expect(result.checked).toBe(2);
    expect(result.remindersSent).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain(`Notice ${broken.notice_id}`);
    expect(result.errors[0]).toContain("Buildium API error 500");
    expect(sendPmNotificationEmailMock).toHaveBeenCalledTimes(1);
    expect(sendPmNotificationEmailMock.mock.calls[0][0]).toBe(healthy.pm_email);
  });

  it("SHADOW_MODE=true: still calls sendPmNotificationEmail (which suppresses internally) and records the correct audit summary", async () => {
    loadEnvMock.mockReturnValue(fakeEnv({ SHADOW_MODE: true }));
    const candidate = fakeCandidate({ notice_id: 5, buildium_lease_id: "1000005" });
    fetchLeaseOutstandingBalanceMock.mockResolvedValue({
      leaseId: candidate.buildium_lease_id,
      balance: 1200,
      evictionPendingDate: null,
      balancesByGl: [{ glAccountId: RENT_GL_ID, balance: 1200 }],
    });
    const pool = fakePool([candidate]);

    await runEscalationCheck(pool as never);

    // escalationCheck.ts itself always calls sendPmNotificationEmail — the
    // suppression happens one layer down inside that function (see
    // graphMailer.ts), never here. This just proves the audit trail
    // correctly reflects shadow mode rather than claiming a real send.
    expect(sendPmNotificationEmailMock).toHaveBeenCalledTimes(1);
    expect(writeAuditLogMock).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        eventSummary: expect.stringContaining("SHADOW MODE"),
        eventData: expect.objectContaining({ shadowModeSuppressed: true }),
      })
    );
  });
});
