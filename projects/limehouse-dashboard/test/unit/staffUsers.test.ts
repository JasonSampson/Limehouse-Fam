import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQuery = vi.fn();
vi.mock("../../src/db/pool.js", () => ({
  getPool: () => ({ query: mockQuery }),
}));

const {
  findByEmail,
  inviteStaff,
  bumpLastLogin,
  listAll,
  updateRole,
  setActive,
} = await import("../../src/db/staffUsers.js");

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

describe("inviteStaff", () => {
  it("inserts with role and returns the new row", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row({ role: "admin" })] });
    const result = await inviteStaff({ email: "jane@limehousepm.com", role: "admin" });
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("email, role"),
      ["jane@limehousepm.com", "admin"]
    );
    expect(result.role).toBe("admin");
  });
});

describe("bumpLastLogin", () => {
  it("updates last_login_at for the given id", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await bumpLastLogin(5);
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining("SET last_login_at = now()"), [5]);
  });
});

describe("listAll", () => {
  it("returns every staff row ordered by created_at", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row({ id: 1 }), row({ id: 2 })] });
    const result = await listAll();
    expect(result).toHaveLength(2);
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining("ORDER BY created_at ASC"));
  });
});

describe("updateRole", () => {
  it("updates the role column", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row({ role: "admin" })] });
    const result = await updateRole(1, "admin");
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining("SET role = $2"), [1, "admin"]);
    expect(result.role).toBe("admin");
  });
});

describe("setActive", () => {
  it("updates the active column", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row({ active: false })] });
    const result = await setActive(1, false);
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining("SET active = $2"), [1, false]);
    expect(result.active).toBe(false);
  });
});
