import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

// Covers the property-53 bug TARS found: downloadPropertyImage() must reject
// a 200-OK response whose body isn't real image bytes (e.g. an HTML error/
// login page served from an expired signed URL) instead of silently
// returning it as if it were a photo.

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = global.fetch;

function setRequiredEnvDefaults() {
  process.env.DATABASE_URL = "postgres://example/test";
  process.env.DATABASE_URL_JOB = "postgres://example/test";
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
  process.env.BUILDIUM_CLIENT_ID = "test-id";
  process.env.BUILDIUM_CLIENT_SECRET = "test-secret";
  process.env.BUILDIUM_BASE_URL = "https://api.buildium.com/v1";
  process.env.GOOGLE_MAPS_API_KEY = "test-key";
  process.env.JASON_ALERT_EMAIL = "jason@limehousepm.com";
  process.env.TEAMS_ALERT_WEBHOOK_URL = "https://example.com/webhook";
}

describe("detectImageFormat", () => {
  it("recognizes a real JPEG by magic bytes", async () => {
    const { detectImageFormat } = await import("../../src/buildium/client.js?t=" + Date.now());
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
    expect(detectImageFormat(jpeg)).toBe("jpeg");
  });

  it("recognizes a real PNG by magic bytes", async () => {
    const { detectImageFormat } = await import("../../src/buildium/client.js?t=" + Date.now());
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
    expect(detectImageFormat(png)).toBe("png");
  });

  it("rejects an HTML page (the actual property-53 bytes shape)", async () => {
    const { detectImageFormat } = await import("../../src/buildium/client.js?t=" + Date.now());
    const html = Buffer.from("<!DOCTYPE html><html><head><title>Sign in</title></head><body></body></html>", "utf8");
    expect(detectImageFormat(html)).toBeNull();
  });
});

describe("downloadPropertyImage", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    setRequiredEnvDefaults();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    global.fetch = ORIGINAL_FETCH;
  });

  it("throws instead of returning bytes when the signed URL serves HTML (simulated bad Buildium response)", async () => {
    const { downloadPropertyImage } = await import("../../src/buildium/client.js?t=" + Date.now());

    const htmlBody = "<html><body>Please sign in again</body></html>";
    global.fetch = vi.fn(async (url: string, opts?: RequestInit) => {
      if (opts?.method === "POST") {
        return new Response(JSON.stringify({ DownloadUrl: "https://cdn.example.com/expired-signed-url" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // The signed-URL fetch: simulates Buildium's actual observed failure —
      // HTTP 200 with an HTML body instead of the photo.
      return new Response(htmlBody, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    }) as unknown as typeof fetch;

    await expect(downloadPropertyImage(53, 2171022)).rejects.toThrow(/did not download as real image/);
  });

  it("returns bytes normally when the signed URL serves a real JPEG", async () => {
    const { downloadPropertyImage } = await import("../../src/buildium/client.js?t=" + Date.now());

    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    global.fetch = vi.fn(async (url: string, opts?: RequestInit) => {
      if (opts?.method === "POST") {
        return new Response(JSON.stringify({ DownloadUrl: "https://cdn.example.com/good-signed-url" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(jpegBytes, { status: 200, headers: { "content-type": "image/jpeg" } });
    }) as unknown as typeof fetch;

    const result = await downloadPropertyImage(1, 999);
    expect(result.bytes.equals(jpegBytes)).toBe(true);
    expect(result.contentType).toBe("image/jpeg");
  });
});
