import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env } from "../../src/config/env.js";

// Safety-critical coverage: sendPmNotificationEmail() (src/email/graphMailer.ts)
// emails a Portfolio Manager directly (e.g. a bounce notification). Until the
// 2026-07-02 fix (commit "Add missing shadow-mode guard to PM notification
// email and Teams alert paths"), this function had NO shadow-mode check —
// it would call Microsoft Graph's real sendMail API regardless of
// SHADOW_MODE. This file locks in the fix: in shadow mode, Graph must never
// be called (neither the token endpoint nor sendMail), and outside shadow
// mode it must still actually attempt the call.
//
// Pure unit test: loadEnv and global fetch are mocked, no DB, no real
// network call — see vitest.config.ts.
vi.mock("../../src/config/env.js", () => ({
  loadEnv: vi.fn(),
}));
vi.mock("../../src/lib/appLogger.js", () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
}));

import { loadEnv } from "../../src/config/env.js";
import { logInfo } from "../../src/lib/appLogger.js";
import { sendPmNotificationEmail } from "../../src/email/graphMailer.js";

const loadEnvMock = vi.mocked(loadEnv);
const logInfoMock = vi.mocked(logInfo);

function fakeEnv(overrides: Partial<Env> = {}): Env {
  return {
    SHADOW_MODE: true,
    GRAPH_TENANT_ID: "fake-tenant-id",
    GRAPH_CLIENT_ID: "fake-client-id",
    GRAPH_CLIENT_SECRET: "fake-client-secret",
    GRAPH_SENDER_MAILBOX: "compliance@limehousepm.com",
    ...overrides,
  } as Env;
}

describe("sendPmNotificationEmail — shadow mode guard (Microsoft Graph)", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch");
    logInfoMock.mockClear();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("SHADOW_MODE=true: does NOT call Graph at all (no token request, no sendMail)", async () => {
    loadEnvMock.mockReturnValue(fakeEnv({ SHADOW_MODE: true }));

    const result = await sendPmNotificationEmail(
      "pm.rivera@limehousepm.com",
      "Notice 4821 bounced",
      "The 14-day notice for lease 2317038 failed to deliver."
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ success: true });
  });

  it("SHADOW_MODE=true: logs that the PM notification was suppressed, without leaking PII into the log", async () => {
    loadEnvMock.mockReturnValue(fakeEnv({ SHADOW_MODE: true }));

    await sendPmNotificationEmail(
      "pm.rivera@limehousepm.com",
      "Notice 4821 bounced",
      "The 14-day notice for lease 2317038 failed to deliver."
    );

    expect(logInfoMock).toHaveBeenCalledWith("shadow mode: PM notification email suppressed", expect.any(Object));
    // The logged fields must not contain the recipient email, subject, or body.
    const loggedFields = logInfoMock.mock.calls[0][1];
    const loggedJson = JSON.stringify(loggedFields ?? {});
    expect(loggedJson).not.toContain("pm.rivera@limehousepm.com");
    expect(loggedJson).not.toContain("2317038");
  });

  it("SHADOW_MODE=true: resolves successfully (does not throw), so the caller's flow isn't broken by the no-op", async () => {
    loadEnvMock.mockReturnValue(fakeEnv({ SHADOW_MODE: true }));

    await expect(
      sendPmNotificationEmail("pm.rivera@limehousepm.com", "subject", "body")
    ).resolves.toEqual({ success: true });
  });

  it("SHADOW_MODE=false: DOES attempt the real Graph call (token fetch, then sendMail) — proves the guard is a real branch", async () => {
    loadEnvMock.mockReturnValue(fakeEnv({ SHADOW_MODE: false }));
    fetchSpy.mockImplementation(async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("login.microsoftonline.com")) {
        return new Response(JSON.stringify({ access_token: "fake-token", expires_in: 3600 }), { status: 200 });
      }
      if (urlStr.includes("graph.microsoft.com") && urlStr.includes("sendMail")) {
        return new Response(null, { status: 202 });
      }
      throw new Error(`Unexpected fetch call to ${urlStr}`);
    });

    const result = await sendPmNotificationEmail(
      "pm.rivera@limehousepm.com",
      "Notice 4821 bounced",
      "The 14-day notice for lease 2317038 failed to deliver."
    );

    expect(fetchSpy).toHaveBeenCalled();
    const sendMailCall = fetchSpy.mock.calls.find((c) => String(c[0]).includes("sendMail"));
    expect(sendMailCall).toBeDefined();
    const sendMailInit = sendMailCall?.[1] as RequestInit;
    const body = JSON.parse(sendMailInit.body as string);
    expect(body.message.toRecipients[0].emailAddress.address).toBe("pm.rivera@limehousepm.com");
    expect(body.message.subject).toBe("Notice 4821 bounced");
    expect(result).toEqual({ success: true });
  });

  it("SHADOW_MODE=false: a failed Graph sendMail surfaces success:false rather than throwing", async () => {
    loadEnvMock.mockReturnValue(fakeEnv({ SHADOW_MODE: false }));
    fetchSpy.mockImplementation(async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("login.microsoftonline.com")) {
        return new Response(JSON.stringify({ access_token: "fake-token", expires_in: 3600 }), { status: 200 });
      }
      return new Response("bad request", { status: 400 });
    });

    const result = await sendPmNotificationEmail("pm.rivera@limehousepm.com", "subject", "body");

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain("400");
  });
});
