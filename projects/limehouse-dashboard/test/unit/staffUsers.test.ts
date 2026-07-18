import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQuery = vi.fn();
vi.mock("../../src/db/pool.js", () => ({
  getPool: () => ({ query: mockQuery }),
}));

const { findByEmail, bumpLastLogin } = await import("../../src/db/staffUsers.js");

function row(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    email: "jane@limehousepm.com",
    display_name: null,
    role: "staff",
    active: true,
    last_login_at: null,
    created_at: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  mockQuery.mockReset();
});

describe("findByEmail", () => {
  it("looks up case-insensitively via lower(email)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row()] });
    await findByEmail("Jane@LimehousePM.com");
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining("lower(email) = lower($1)"), [
      "Jane@LimehousePM.com",
    ]);
  });

  it("returns null when no row matches", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const result = await findByEmail("nobody@limehousepm.com");
    expect(result).toBeNull();
  });
});

describe("bumpLastLogin", () => {
  it("updates last_login_at for the given id", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await bumpLastLogin(5);
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining("SET last_login_at = now()"), [5]);
  });
});
