import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env } from "../../src/config/env.js";

// Safety-critical coverage: sendAlert() posts job-failure alerts to a
// Microsoft Teams webhook (src/email/sendAlert.ts). Until the 2026-07-02 fix
// (commit "Add missing shadow-mode guard to PM notification email and Teams
// alert paths"), this function had NO shadow-mode check at all — it would
// always POST to the real webhook regardless of SHADOW_MODE. This file locks
// in that regression fix: in shadow mode the webhook must never be called,
// and outside shadow mode it must still actually be called (proving the
// branch is real, not a function that now silently always no-ops).
//
// Pure unit test: loadEnv and global fetch are both mocked, no DB, no real
// network call — see vitest.config.ts.
vi.mock("../../src/config/env.js", () => ({
  loadEnv: vi.fn(),
}));
vi.mock("../../src/lib/appLogger.js", () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
}));

import { loadEnv } from "../../src/config/env.js";
import { logInfo, logError } from "../../src/lib/appLogger.js";
import { sendAlert } from "../../src/email/sendAlert.js";

const loadEnvMock = vi.mocked(loadEnv);
const logInfoMock = vi.mocked(logInfo);
const logErrorMock = vi.mocked(logError);

function fakeEnv(overrides: Partial<Env> = {}): Env {
  return {
    SHADOW_MODE: true,
    TEAMS_ALERT_WEBHOOK_URL: "https://outlook.office.com/webhook/fake-webhook-url",
    ...overrides,
  } as Env;
}

describe("sendAlert — shadow mode guard (Teams webhook)", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));
    logInfoMock.mockClear();
    logErrorMock.mockClear();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("SHADOW_MODE=true: does NOT call the Teams webhook", async () => {
    loadEnvMock.mockReturnValue(fakeEnv({ SHADOW_MODE: true }));

    await sendAlert({
      to: "jason@limehousepm.com",
      subject: "Daily late-cycle job failed",
      body: "The nightly late-cycle job threw an error at step 3.",
    });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("SHADOW_MODE=true: logs that the alert was suppressed", async () => {
    loadEnvMock.mockReturnValue(fakeEnv({ SHADOW_MODE: true }));

    await sendAlert({
      to: "jason@limehousepm.com",
      subject: "Daily late-cycle job failed",
      body: "The nightly late-cycle job threw an error at step 3.",
    });

    expect(logInfoMock).toHaveBeenCalledWith(
      "shadow mode: Teams alert suppressed",
      expect.objectContaining({ jobName: "Daily late-cycle job failed" })
    );
  });

  it("SHADOW_MODE=true: resolves successfully (does not throw) even though nothing was sent", async () => {
    loadEnvMock.mockReturnValue(fakeEnv({ SHADOW_MODE: true }));

    await expect(
      sendAlert({
        to: "jason@limehousepm.com",
        subject: "Daily late-cycle job failed",
        body: "Body text",
      })
    ).resolves.toBeUndefined();
  });

  it("SHADOW_MODE=false: DOES call the Teams webhook (proves the guard is a real branch, not an always-no-op)", async () => {
    loadEnvMock.mockReturnValue(fakeEnv({ SHADOW_MODE: false }));

    await sendAlert({
      to: "jason@limehousepm.com",
      subject: "Daily late-cycle job failed",
      body: "The nightly late-cycle job threw an error at step 3.",
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://outlook.office.com/webhook/fake-webhook-url");
    expect(init?.method).toBe("POST");
    const payload = JSON.parse(init?.body as string);
    expect(payload.title).toBe("Daily late-cycle job failed");
    expect(payload["@type"]).toBe("MessageCard");
  });

  it("SHADOW_MODE=false: logs success after a real post succeeds", async () => {
    loadEnvMock.mockReturnValue(fakeEnv({ SHADOW_MODE: false }));

    await sendAlert({ to: "jason@limehousepm.com", subject: "Job failed", body: "body" });

    expect(logInfoMock).toHaveBeenCalledWith("alert posted to Teams", expect.objectContaining({ jobName: "Job failed" }));
  });

  it("SHADOW_MODE=false: a failed webhook POST throws and logs loudly (no silent swallow — there's no fallback channel)", async () => {
    loadEnvMock.mockReturnValue(fakeEnv({ SHADOW_MODE: false }));
    fetchSpy.mockResolvedValue(new Response("bad gateway", { status: 502 }));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      sendAlert({ to: "jason@limehousepm.com", subject: "Job failed", body: "body" })
    ).rejects.toThrow(/Teams webhook returned 502/);

    expect(logErrorMock).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});
