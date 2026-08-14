import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { AddressInfo } from "node:net";

// Route-level integration test for the 2026-08-14 tab restructure:
// GET /api/notices (now drafts-only) and the new GET /api/notices/sent
// (sent-only). Every other test for this file either exercises the SQL
// directly or hits a :id-scoped route — nobody had actually booted the real
// Express router and confirmed the two list endpoints split status
// correctly (TARS review finding, 2026-08-14). Same pattern as
// noticeSendRoute.test.ts: boots src/routes/noticeRoutes.ts unmodified
// against the real disposable test Postgres.
//
// testDb.js imported first, same hard safety requirement as
// noticeSendRoute.test.ts — see that file's header comment.
import {
  getTestSuperuserPool,
  truncateAllTables,
  closeAllTestPools,
} from "../support/testDb.js";
import {
  seedPmUser,
  seedProperty,
  seedPmPropertyAssignment,
  seedLease,
  seedActiveConfigValue,
  seedLetterTemplate,
  seedLateCycle,
  seedNotice,
} from "../support/seed.js";

process.env.BUILDIUM_CLIENT_ID ??= "test-client-id";
process.env.BUILDIUM_CLIENT_SECRET ??= "test-client-secret";
process.env.BUILDIUM_BASE_URL ??= "https://api.example.invalid";
process.env.LIMEHQ_HANDOFF_SECRET ??= "test-handoff-secret-min16chars";
process.env.GRAPH_TENANT_ID ??= "test-tenant-id";
process.env.GRAPH_CLIENT_ID ??= "test-graph-client-id";
process.env.GRAPH_CLIENT_SECRET ??= "test-graph-client-secret";
process.env.GRAPH_SENDER_MAILBOX ??= "notices@example.invalid";
process.env.SESSION_COOKIE_SECRET ??= "test-session-cookie-secret-32-chars-min";
process.env.JASON_ALERT_EMAIL ??= "jason@example.invalid";
process.env.TEAMS_ALERT_WEBHOOK_URL ??= "https://example.invalid/webhook";

// GET /api/notices fires onDemandLatenessTrigger.ts's fire-and-forget check
// (unrelated to what this file tests) — mocked to a no-op so a real Buildium
// call / child-process spawn never happens from a test.
vi.mock("../../src/lib/onDemandLatenessTrigger.js", () => ({
  maybeTriggerOnDemandLatenessCheck: vi.fn().mockResolvedValue(undefined),
}));

describe("GET /api/notices and GET /api/notices/sent — tab split (real Postgres)", () => {
  const superuser = getTestSuperuserPool();
  let baseUrl: string;
  let closeServer: () => Promise<void>;
  let pmA: number;
  let draftNoticeId: number;
  let sentNoticeId: number;

  async function sessionCookieFor(pmUserId: number): Promise<string> {
    const { createSessionToken, SESSION_COOKIE_NAME } = await import("../../src/auth/session.js");
    const token = await createSessionToken({
      pmUserId,
      email: `pm-${pmUserId}@limehousepm.com`,
      isFallbackDecisionMaker: false,
      authenticatedAt: Date.now(),
    });
    return `${SESSION_COOKIE_NAME}=${token}`;
  }

  beforeAll(async () => {
    await truncateAllTables();

    pmA = await seedPmUser(superuser, { email: "pm-a-list@limehousepm.com", role: "pm" });
    const property = await seedProperty(superuser, { buildiumPropertyId: "PROP-LIST-TEST", name: "List Test Property" });
    await seedPmPropertyAssignment(superuser, pmA, property);

    const deMinimisConfigId = await seedActiveConfigValue(superuser, {
      configKey: "de_minimis_threshold_usd",
      value: 100,
      setByPmId: pmA,
    });
    const letterTemplateId = await seedLetterTemplate(superuser, { createdByPmId: pmA });

    const draftLeaseId = await seedLease(superuser, { buildiumLeaseId: "LIST-TEST-DRAFT", propertyId: property });
    const draftLateCycleId = await seedLateCycle(superuser, { leaseId: draftLeaseId, deMinimisConfigId, dueDate: "2026-08-01" });
    draftNoticeId = await seedNotice(superuser, {
      lateCycleId: draftLateCycleId,
      leaseId: draftLeaseId,
      letterTemplateId,
      assignedPmId: pmA,
    });

    const sentLeaseId = await seedLease(superuser, { buildiumLeaseId: "LIST-TEST-SENT", propertyId: property });
    const sentLateCycleId = await seedLateCycle(superuser, { leaseId: sentLeaseId, deMinimisConfigId, dueDate: "2026-07-01" });
    sentNoticeId = await seedNotice(superuser, {
      lateCycleId: sentLateCycleId,
      leaseId: sentLeaseId,
      letterTemplateId,
      assignedPmId: pmA,
    });
    await superuser.query(
      "UPDATE notices SET status = 'sent', sent_at = now(), sent_by_pm_id = $1, ledger_verified = true WHERE id = $2",
      [pmA, sentNoticeId]
    );

    const express = (await import("express")).default;
    const cookieParser = (await import("cookie-parser")).default;
    const { noticeRoutes } = await import("../../src/routes/noticeRoutes.js");

    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use(noticeRoutes);

    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
    closeServer = () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  afterAll(async () => {
    await closeServer();
    await closeAllTestPools();
    const { closePools } = await import("../../src/db/pool.js");
    await closePools();
  });

  it("GET /api/notices returns the draft notice, never the sent one", async () => {
    const cookie = await sessionCookieFor(pmA);
    const res = await fetch(`${baseUrl}/api/notices`, { headers: { Cookie: cookie } });
    const body = await res.json();

    expect(res.status).toBe(200);
    const ids = body.notices.map((n: { id: number }) => n.id);
    expect(ids).toContain(draftNoticeId);
    expect(ids).not.toContain(sentNoticeId);
    expect(body.notices.every((n: { status: string }) => n.status === "draft")).toBe(true);
  });

  it("GET /api/notices/sent returns the sent notice, never the draft one", async () => {
    const cookie = await sessionCookieFor(pmA);
    const res = await fetch(`${baseUrl}/api/notices/sent`, { headers: { Cookie: cookie } });
    const body = await res.json();

    expect(res.status).toBe(200);
    const ids = body.notices.map((n: { id: number }) => n.id);
    expect(ids).toContain(sentNoticeId);
    expect(ids).not.toContain(draftNoticeId);
    expect(body.notices.every((n: { status: string }) => n.status === "sent")).toBe(true);
  });

  it("GET /api/notices/sent is NOT shadowed by the GET /api/notices/:id route (route ordering)", async () => {
    // If Express ever matched "/api/notices/sent" against the :id route
    // instead, "sent" would fail Number.isInteger and 400 with "Invalid
    // notice id." — asserting a real 200 with a `notices` array proves the
    // literal-path route actually won, not just that ordering "looks" right
    // by inspection.
    const cookie = await sessionCookieFor(pmA);
    const res = await fetch(`${baseUrl}/api/notices/sent`, { headers: { Cookie: cookie } });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(Array.isArray(body.notices)).toBe(true);
    expect(body.error).toBeUndefined();
  });
});
