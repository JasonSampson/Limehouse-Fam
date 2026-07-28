import { describe, it, expect } from "vitest";
import { normalizePath, isGatedHtmlRequest, isAdminOnlyPage } from "../../src/auth/staticPageGate.js";

// Exercises the real gate-normalization logic from src/server.ts (extracted
// into src/auth/staticPageGate.ts so it's importable) rather than a
// copy-pasted parallel implementation. The previous version of this file
// re-implemented the logic inline, which is how a second real bypass
// (percent-encoding, e.g. GET /ceo-view%2ehtml) went uncaught even with
// "full" test coverage of the case-sensitivity bug — the test could pass
// forever while drifting from what server.ts actually does.

describe("normalizePath", () => {
  it("maps root to index.html", () => {
    expect(normalizePath("/")).toBe("/index.html");
  });

  it("lowercases case variants", () => {
    for (const variant of ["/ceo-view.html", "/CEO-VIEW.HTML", "/Ceo-View.html"]) {
      expect(normalizePath(variant)).toBe("/ceo-view.html");
    }
  });

  it("decodes percent-encoded paths, closing the %2e bypass Sentinel found", () => {
    expect(normalizePath("/ceo-view%2ehtml")).toBe("/ceo-view.html");
    expect(normalizePath("/CEO-VIEW%2EHTML")).toBe("/ceo-view.html");
    expect(normalizePath("/team-performance%2ehtml")).toBe("/team-performance.html");
  });

  it("returns null for malformed percent-sequences instead of throwing", () => {
    expect(normalizePath("/ceo-view%2h.html")).toBeNull();
    expect(normalizePath("/ceo-view.html%")).toBeNull();
  });
});

describe("isGatedHtmlRequest", () => {
  it("treats normalized .html paths as gated", () => {
    expect(isGatedHtmlRequest("/ceo-view.html")).toBe(true);
    expect(isGatedHtmlRequest("/index.html")).toBe(true);
  });

  it("does not gate non-.html paths", () => {
    expect(isGatedHtmlRequest("/api/some-data")).toBe(false);
    expect(isGatedHtmlRequest("/app.js")).toBe(false);
  });
});

describe("isAdminOnlyPage", () => {
  it("recognizes both admin-only pages once normalized", () => {
    for (const page of ["/team-performance.html", "/ceo-view.html"]) {
      expect(isAdminOnlyPage(page)).toBe(true);
    }
  });

  it("does not flag the shared dashboard as admin-only", () => {
    expect(isAdminOnlyPage("/index.html")).toBe(false);
  });
});

describe("end-to-end normalization (case + percent-encoding combined)", () => {
  it("catches every known bypass variant of both admin pages", () => {
    const bypassAttempts = [
      "/ceo-view%2ehtml",
      "/CEO-VIEW%2EHTML",
      "/team-performance%2ehtml",
      "/CEO-VIEW.HTML",
      "/Team-Performance.Html",
    ];
    for (const attempt of bypassAttempts) {
      const normalized = normalizePath(attempt);
      expect(normalized).not.toBeNull();
      expect(isGatedHtmlRequest(normalized as string)).toBe(true);
      expect(isAdminOnlyPage(normalized as string)).toBe(true);
    }
  });
});
