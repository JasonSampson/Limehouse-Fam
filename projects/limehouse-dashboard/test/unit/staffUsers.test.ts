import { describe, it, expect, vi, beforeEach } from "vitest";

// Same DB-mocking convention as getScoredRoles.test.ts: mock getPool() so
// these are pure unit tests, no real Postgres connection required.
const mockQuery = vi.fn();
vi.mock("../../src/db/pool.js", () => ({
  getPool: () => ({ query: mockQuery }),
}));

const {
  findByEntraId,
  findByEmail,
  inviteStaff,
  linkFirstLogin,
  bumpLastLogin,
  listAll,
  updateRole,
  setActive,
} = await import("../../src/db/staffUsers.js");

function row(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    entra_object_id: null,
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

describe("findByEntraId", () => {
  it("returns null when no row matches", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const result = await findByEntraId("some-oid");
    expect(result).toBeNull();
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining("entra_object_id = $1"), ["some-oid"]);
  });

  it("maps a matching row to camelCase", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row({ entra_object_id: "oid-1" })] });
    const result = await findByEntraId("oid-1");
    expect(result).toEqual({
      id: 1,
      entraObjectId: "oid-1",
      email: "jane@limehousepm.com",
      displayName: null,
      role: "staff",
      active: true,
      lastLoginAt: null,
      createdAt: "2026-07-01T00:00:00.000Z",
    });
  });
});

describe("findByEmail", () => {
  it("looks up case-insensitively via lower(email)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row()] });
    await findByEmail("Jane@LimehousePM.com");
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining("lower(email) = lower($1)"), [
      "Jane@LimehousePM.com",
    ]);
  });
});

describe("inviteStaff", () => {
  it("inserts with entra_object_id NULL", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row({ role: "admin" })] });
    const result = await inviteStaff({ email: "jane@limehousepm.com", role: "admin" });
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("entra_object_id, email, role) VALUES (NULL, $1, $2)"),
      ["jane@limehousepm.com", "admin"]
    );
    expect(result.role).toBe("admin");
  });
});

describe("linkFirstLogin", () => {
  it("sets entra_object_id, display_name, and last_login_at", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [row({ entra_object_id: "oid-2", display_name: "Jane Doe", last_login_at: "2026-07-04T00:00:00.000Z" })],
    });
    const result = await linkFirstLogin({ id: 1, entraObjectId: "oid-2", displayName: "Jane Doe" });
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining("SET entra_object_id = $2, display_name = $3"), [
      1,
      "oid-2",
      "Jane Doe",
    ]);
    expect(result.entraObjectId).toBe("oid-2");
    expect(result.displayName).toBe("Jane Doe");
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
