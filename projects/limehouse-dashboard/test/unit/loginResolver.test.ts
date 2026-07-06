import { describe, it, expect, vi, beforeEach } from "vitest";
import type { VerifiedIdentity } from "../../src/auth/entra.js";

// Mocks the DB layer directly (not getPool) so this test exercises exactly
// the three-way branch logic in resolveLogin — returning user / first-login
// -for-an-invited-email / not-found-or-inactive — without needing real SQL
// fixtures. Matches late-rent-notices' approach of mocking token
// verification/DB rather than hitting a real Microsoft or Postgres round-trip.
const mockFindByEntraId = vi.fn();
const mockFindByEmail = vi.fn();
const mockLinkFirstLogin = vi.fn();
const mockBumpLastLogin = vi.fn();

vi.mock("../../src/db/staffUsers.js", () => ({
  findByEntraId: (...args: unknown[]) => mockFindByEntraId(...args),
  findByEmail: (...args: unknown[]) => mockFindByEmail(...args),
  linkFirstLogin: (...args: unknown[]) => mockLinkFirstLogin(...args),
  bumpLastLogin: (...args: unknown[]) => mockBumpLastLogin(...args),
}));

const { resolveLogin } = await import("../../src/auth/loginResolver.js");

const identity: VerifiedIdentity = {
  entraObjectId: "oid-123",
  displayName: "Jane Doe",
  email: "jane@limehousepm.com",
};

function staffRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    entraObjectId: null,
    email: "jane@limehousepm.com",
    displayName: null,
    role: "staff" as const,
    active: true,
    lastLoginAt: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  mockFindByEntraId.mockReset();
  mockFindByEmail.mockReset();
  mockLinkFirstLogin.mockReset();
  mockBumpLastLogin.mockReset();
});

describe("resolveLogin", () => {
  it("returning user: matches by entra_object_id, bumps last login, authorizes", async () => {
    mockFindByEntraId.mockResolvedValueOnce(staffRow({ entraObjectId: "oid-123", active: true }));

    const result = await resolveLogin(identity);

    expect(result.outcome).toBe("authorized");
    expect(mockBumpLastLogin).toHaveBeenCalledWith(1);
    expect(mockFindByEmail).not.toHaveBeenCalled();
    expect(mockLinkFirstLogin).not.toHaveBeenCalled();
  });

  it("returning user who has been deactivated: rejected, no bump", async () => {
    mockFindByEntraId.mockResolvedValueOnce(staffRow({ entraObjectId: "oid-123", active: false }));

    const result = await resolveLogin(identity);

    expect(result.outcome).toBe("rejected");
    expect(mockBumpLastLogin).not.toHaveBeenCalled();
  });

  it("first login for an invited email: no entra_object_id match, falls back to email, links it", async () => {
    mockFindByEntraId.mockResolvedValueOnce(null);
    mockFindByEmail.mockResolvedValueOnce(staffRow({ entraObjectId: null, active: true }));
    mockLinkFirstLogin.mockResolvedValueOnce(
      staffRow({ entraObjectId: "oid-123", displayName: "Jane Doe", active: true })
    );

    const result = await resolveLogin(identity);

    expect(result.outcome).toBe("authorized");
    expect(mockLinkFirstLogin).toHaveBeenCalledWith({
      id: 1,
      entraObjectId: "oid-123",
      displayName: "Jane Doe",
    });
    if (result.outcome === "authorized") {
      expect(result.user.entraObjectId).toBe("oid-123");
    }
  });

  it("invited email but inactive: rejected, never links", async () => {
    mockFindByEntraId.mockResolvedValueOnce(null);
    mockFindByEmail.mockResolvedValueOnce(staffRow({ entraObjectId: null, active: false }));

    const result = await resolveLogin(identity);

    expect(result.outcome).toBe("rejected");
    expect(mockLinkFirstLogin).not.toHaveBeenCalled();
  });

  it("no match by entra_object_id or email: rejected, never creates a row", async () => {
    mockFindByEntraId.mockResolvedValueOnce(null);
    mockFindByEmail.mockResolvedValueOnce(null);

    const result = await resolveLogin(identity);

    expect(result.outcome).toBe("rejected");
    expect(mockLinkFirstLogin).not.toHaveBeenCalled();
  });

  it("email matches a row that's already linked to a different entra_object_id: rejected (never re-links)", async () => {
    mockFindByEntraId.mockResolvedValueOnce(null);
    mockFindByEmail.mockResolvedValueOnce(staffRow({ entraObjectId: "some-other-oid", active: true }));

    const result = await resolveLogin(identity);

    expect(result.outcome).toBe("rejected");
    expect(mockLinkFirstLogin).not.toHaveBeenCalled();
  });
});
