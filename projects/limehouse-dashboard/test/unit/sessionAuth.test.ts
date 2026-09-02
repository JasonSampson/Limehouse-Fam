import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.SESSION_COOKIE_SECRET = "test_secret_at_least_16_chars_long";
process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
process.env.BUILDIUM_CLIENT_ID = "test_id";
process.env.BUILDIUM_CLIENT_SECRET = "test_secret";
process.env.ENTRA_TENANT_ID = "test-tenant";
process.env.ENTRA_CLIENT_ID = "test-client";
process.env.ENTRA_CLIENT_SECRET = "test-client-secret";
process.env.ENTRA_REDIRECT_URI = "https://localhost:3100/auth/callback";

const { issueSession, getSessionUser, requireLogin, requirePermission, SESSION_COOKIE_NAME } = await import(
  "../../src/auth/session.js"
);

// Minimal fake Express res that just records what issueSession/clearSession
// write, so this test exercises the real cookie-signing/verification code
// path rather than mocking jose itself.
function fakeRes() {
  const cookies: Record<string, string> = {};
  return {
    cookie: vi.fn((name: string, value: string) => {
      cookies[name] = value;
    }),
    clearCookie: vi.fn(),
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    _cookies: cookies,
  };
}

function fakeReqWithCookie(cookieValue: string | undefined) {
  return { cookies: cookieValue ? { [SESSION_COOKIE_NAME]: cookieValue } : {} } as any;
}

describe("getSessionUser", () => {
  it("returns null when there is no session cookie", async () => {
    const result = await getSessionUser(fakeReqWithCookie(undefined));
    expect(result).toBeNull();
  });

  it("returns null for a garbage/invalid token", async () => {
    const result = await getSessionUser(fakeReqWithCookie("not-a-real-token"));
    expect(result).toBeNull();
  });

  it("returns the decoded id/permissions for a token issued by issueSession", async () => {
    const res = fakeRes();
    await issueSession(res as any, { id: 42, permissions: ["dashboard.ceo_view.view"] });
    const token = res._cookies[SESSION_COOKIE_NAME];

    const result = await getSessionUser(fakeReqWithCookie(token));
    expect(result).toEqual({ id: 42, permissions: ["dashboard.ceo_view.view"] });
  });
});

describe("requireLogin", () => {
  it("responds 401 and does not call next when there is no valid session", async () => {
    const req = fakeReqWithCookie(undefined);
    const res = fakeRes();
    const next = vi.fn();

    await requireLogin(req, res as any, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("attaches req.user and calls next for a valid session", async () => {
    const res = fakeRes();
    await issueSession(res as any, { id: 7, permissions: ["dashboard.financials.view"] });
    const token = res._cookies[SESSION_COOKIE_NAME];

    const req = fakeReqWithCookie(token);
    const next = vi.fn();
    await requireLogin(req, res as any, next);

    expect(next).toHaveBeenCalled();
    expect(req.user).toEqual({ id: 7, permissions: ["dashboard.financials.view"] });
  });
});

describe("requirePermission", () => {
  it("responds 403 and does not call next when the session lacks the key", () => {
    const req = { user: { id: 7, permissions: ["dashboard.financials.view"] } } as any;
    const res = fakeRes();
    const next = vi.fn();

    requirePermission("dashboard.ceo_view.view")(req, res as any, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("calls next when the session holds the key", () => {
    const req = { user: { id: 1, permissions: ["dashboard.ceo_view.view"] } } as any;
    const res = fakeRes();
    const next = vi.fn();

    requirePermission("dashboard.ceo_view.view")(req, res as any, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});
