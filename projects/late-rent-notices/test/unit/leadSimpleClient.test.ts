import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env } from "../../src/config/env.js";

vi.mock("../../src/config/env.js", () => ({ loadEnv: vi.fn() }));
vi.mock("../../src/lib/appLogger.js", () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }));

import { loadEnv } from "../../src/config/env.js";
import { findTenantDealId, mirrorNoticeToLeadSimple } from "../../src/integrations/leadSimpleClient.js";

const loadEnvMock = vi.mocked(loadEnv);
const TENANTS_PIPELINE = "e4d64073-dbf8-422c-bd90-1c63c3cb4eb2";

// Response shapes below are copied from REAL API responses observed live
// against Jason's account on 2026-08-03 (GET /deals?search=...), not
// invented — e.g. the same tenant genuinely appearing twice, once in "New
// Applicant" and once in "Buildium Rental Tenants", and `emails` being an
// ARRAY of strings despite the swagger spec declaring it a plain string
// (that mismatch was a real crash caught by running against the live API).
function makeDeal(id: string, pipelineId: string, pipelineName: string, contacts: { name: string; emails: string[] }[]) {
  return { id, name: contacts.map((c) => c.name).join(" & "), pipeline: { id: pipelineId, name: pipelineName }, contacts };
}

function envWith(overrides: Partial<Env> = {}): Env {
  return {
    LEADSIMPLE_API_KEY: "test-key",
    LEADSIMPLE_TENANTS_PIPELINE_ID: TENANTS_PIPELINE,
    ...overrides,
  } as Env;
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  loadEnvMock.mockReturnValue(envWith());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) };
}

describe("findTenantDealId — matching a tenant to their Buildium Rental Tenants deal", () => {
  it("finds the deal whose contacts include the recipient email, matching case-insensitively", async () => {
    // Real observed behavior: Buildium stores chooseVITO@cox.net, LeadSimple
    // stores choosevito@cox.net — the match must not depend on case.
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: [makeDeal("deal-1", TENANTS_PIPELINE, "Buildium Rental Tenants", [{ name: "Angelo Morlino", emails: ["choosevito@cox.net"] }])] })
    );
    const result = await findTenantDealId(["chooseVITO@cox.net"]);
    expect(result).toEqual({ dealId: "deal-1", dealName: "Angelo Morlino" });
    expect(fetchMock.mock.calls[0][0]).toContain(`pipeline_id=${TENANTS_PIPELINE}`);
  });

  it("never matches a deal from a different pipeline, even if the search returns it", async () => {
    // The same tenant really does have a second deal in "New Applicant" —
    // collections notes must never land there.
    fetchMock.mockResolvedValue(
      jsonResponse({ data: [makeDeal("applicant-deal", "other-pipeline-id", "New Applicant", [{ name: "Amber Wilkins", emails: ["ambercoltkam1413@gmail.com"] }])] })
    );
    const result = await findTenantDealId(["ambercoltkam1413@gmail.com"]);
    expect(result).toBeNull();
  });

  it("tries each recipient email until one matches (co-tenant whose email is second)", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: [] }))
      .mockResolvedValueOnce(
        jsonResponse({ data: [makeDeal("deal-2", TENANTS_PIPELINE, "Buildium Rental Tenants", [{ name: "Jacob Watson", emails: ["watsonja@bakerdc.com"] }])] })
      );
    const result = await findTenantDealId(["unknown@example.com", "watsonja@bakerdc.com"]);
    expect(result).toEqual({ dealId: "deal-2", dealName: "Jacob Watson" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns null (not an error) when no deal matches any recipient email", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [] }));
    expect(await findTenantDealId(["nobody@example.com"])).toBeNull();
  });

  it("throws on an API error response rather than silently reporting no match", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "rate limited" }, 429));
    await expect(findTenantDealId(["a@example.com"])).rejects.toThrow(/429/);
  });
});

describe("mirrorNoticeToLeadSimple", () => {
  const payload = {
    noticeId: 42,
    recipientEmails: ["watsonja@bakerdc.com"],
    recipientNames: ["Jacob Watson"],
    subject: "NOTICE OF DEFAULT — FAILURE TO PAY RENT — Unit 1",
    amountDue: "$1,875.50",
    deliveryStatus: "sent",
    sentByPmName: "Jason Sampson",
    sentByLeadSimpleUserId: "bcae78e5-c7d0-4068-a0e9-4deab3793410",
    sentAtIso: "2026-08-03T17:00:00.000Z",
    pdf: Buffer.from("%PDF-fake"),
    pdfFilename: "14-Day-Notice-Unit-1.pdf",
  };

  it("skips without any network call when LEADSIMPLE_API_KEY is not configured", async () => {
    loadEnvMock.mockReturnValue(envWith({ LEADSIMPLE_API_KEY: undefined }));
    const result = await mirrorNoticeToLeadSimple(payload);
    expect(result).toEqual({ mirrored: false, skippedReason: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips with no_matching_deal (no note, no upload) when the tenant has no deal", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [] }));
    const result = await mirrorNoticeToLeadSimple(payload);
    expect(result).toEqual({ mirrored: false, skippedReason: "no_matching_deal" });
    expect(fetchMock).toHaveBeenCalledTimes(1); // only the search — nothing was written
  });

  it("creates the outbound-email note and uploads the PDF to the matched deal", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ data: [makeDeal("deal-9", TENANTS_PIPELINE, "Buildium Rental Tenants", [{ name: "Jacob Watson", emails: ["watsonja@bakerdc.com"] }])] })
      )
      .mockResolvedValueOnce(jsonResponse({ id: "note-1" }, 201))
      .mockResolvedValueOnce(jsonResponse({ id: "file-1" }, 201));

    const result = await mirrorNoticeToLeadSimple(payload);
    expect(result).toEqual({ mirrored: true, dealId: "deal-9", dealName: "Jacob Watson" });

    const [noteUrl, noteInit] = fetchMock.mock.calls[1];
    expect(noteUrl).toBe("https://api.leadsimple.com/rest/notes");
    const noteBody = new URLSearchParams(noteInit.body as string);
    expect(noteBody.get("parent_id")).toBe("deal-9");
    expect(noteBody.get("parent_type")).toBe("Deal");
    expect(noteBody.get("kind")).toBe("email");
    expect(noteBody.get("direction")).toBe("outbound");
    expect(noteBody.get("description")).toContain("$1,875.50");
    expect(noteBody.get("description")).toContain("Jacob Watson");
    // The note is attributed to the ACTUAL sender in LeadSimple's own UI,
    // not just described as such in the text — Jason's correction,
    // 2026-08-05 (every note previously showed as posted by the API key's
    // owner regardless of who really sent it).
    expect(noteBody.get("user_id")).toBe("bcae78e5-c7d0-4068-a0e9-4deab3793410");

    const [fileUrl, fileInit] = fetchMock.mock.calls[2];
    expect(fileUrl).toBe("https://api.leadsimple.com/rest/uploaded_files");
    const form = fileInit.body as FormData;
    expect(form.get("uploadable_id")).toBe("deal-9");
    expect(form.get("uploadable_type")).toBe("deals");
    expect(form.get("file")).toBeInstanceOf(Blob);
  });

  it("omits user_id entirely (not even blank) when the sending PM has no known LeadSimple account", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ data: [makeDeal("deal-9", TENANTS_PIPELINE, "Buildium Rental Tenants", [{ name: "Jacob Watson", emails: ["watsonja@bakerdc.com"] }])] })
      )
      .mockResolvedValueOnce(jsonResponse({ id: "note-1" }, 201))
      .mockResolvedValueOnce(jsonResponse({ id: "file-1" }, 201));

    await mirrorNoticeToLeadSimple({ ...payload, sentByLeadSimpleUserId: null });

    const [, noteInit] = fetchMock.mock.calls[1];
    const noteBody = new URLSearchParams(noteInit.body as string);
    expect(noteBody.has("user_id")).toBe(false);
  });

  it("propagates a note-create failure so the caller can log it (send itself is already committed)", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ data: [makeDeal("deal-9", TENANTS_PIPELINE, "Buildium Rental Tenants", [{ name: "Jacob Watson", emails: ["watsonja@bakerdc.com"] }])] })
      )
      .mockResolvedValueOnce(jsonResponse({ error: "boom" }, 500));
    await expect(mirrorNoticeToLeadSimple(payload)).rejects.toThrow(/note create failed/);
  });
});
