import type { BuildiumOwner } from "../buildium/client.js";

// Owners drill-down — ADDED 2026-07-12, per Jason directly. Buildium's raw
// /rentals/owners list overcounts real owners in two ways he pointed out
// after seeing the vendor site's (also-wrong) "251" figure:
//   1. A single property can have more than one owner RECORD (co-owners —
//      e.g. a married couple each listed separately, or a trust alongside
//      an individual). CONFIRMED LIVE: 73 of this account's properties
//      have 2+ owner records tied to them.
//   2. The SAME real owner sometimes uses a different name/LLC for
//      different properties (e.g. "Ramcroft LLC" and "Parker Hayslett" —
//      confirmed live to share both phone and email, no property overlap
//      at all otherwise).
// Buildium has no field that says "these records are the same real
// owner" — per Jason's own call, two owner records are grouped together
// (counted once) if they share a property, a phone number, or an email
// address. This necessarily also merges a few real cases that could
// theoretically be two separate people who just share a phone (e.g. a
// married couple each an owner in their own right) — Jason reviewed the
// real matches this would produce and confirmed merging all of them is
// the right call, rather than carving out exceptions with no reliable way
// to tell the two cases apart from Buildium's data alone.
function normalizePhone(number: string): string {
  return number.replace(/\D/g, "");
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function ownerDisplayName(owner: BuildiumOwner): string {
  if (owner.IsCompany && owner.CompanyName) return owner.CompanyName;
  return `${owner.FirstName ?? ""} ${owner.LastName ?? ""}`.trim();
}

// Plain union-find (path compression only, no rank) — the input sizes here
// (hundreds of owner records) don't need the union-by-rank optimization.
class UnionFind {
  private readonly parent: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i);
  }

  find(i: number): number {
    if (this.parent[i] !== i) this.parent[i] = this.find(this.parent[i]);
    return this.parent[i];
  }

  union(a: number, b: number): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) this.parent[rootA] = rootB;
  }
}

export interface OwnerGroup {
  names: string[]; // every distinct name/LLC this real owner appears under, in first-seen order
  propertyIds: string[];
  active: boolean; // true if ANY member record is currently active
  earliestStart: string | null; // "YYYY-MM-DD", earliest ManagementAgreementStartDate across members
  latestEnd: string | null; // only populated when the group is NOT active — see groupOwners' note below
}

// Groups the FULL owner list (active and inactive together) so a link
// through an inactive record (e.g. an old individual record later
// replaced by an LLC one, sharing the same email) is never missed — the
// caller filters to active groups afterward, not before grouping.
export function groupOwners(owners: BuildiumOwner[]): OwnerGroup[] {
  const uf = new UnionFind(owners.length);

  const byProperty = new Map<number, number[]>();
  const byPhone = new Map<string, number[]>();
  const byEmail = new Map<string, number[]>();

  owners.forEach((owner, i) => {
    for (const propertyId of owner.PropertyIds ?? []) {
      const list = byProperty.get(propertyId) ?? [];
      list.push(i);
      byProperty.set(propertyId, list);
    }
    for (const phone of owner.PhoneNumbers) {
      const key = normalizePhone(phone.Number);
      if (!key) continue;
      const list = byPhone.get(key) ?? [];
      list.push(i);
      byPhone.set(key, list);
    }
    for (const email of [owner.Email, owner.AlternateEmail]) {
      if (!email) continue;
      const key = normalizeEmail(email);
      if (!key) continue;
      const list = byEmail.get(key) ?? [];
      list.push(i);
      byEmail.set(key, list);
    }
  });

  for (const list of [...byProperty.values(), ...byPhone.values(), ...byEmail.values()]) {
    for (let i = 1; i < list.length; i++) uf.union(list[0], list[i]);
  }

  const membersByRoot = new Map<number, number[]>();
  owners.forEach((_, i) => {
    const root = uf.find(i);
    const list = membersByRoot.get(root) ?? [];
    list.push(i);
    membersByRoot.set(root, list);
  });

  const groups: OwnerGroup[] = [];
  for (const memberIndices of membersByRoot.values()) {
    const members = memberIndices.map((i) => owners[i]);

    const names: string[] = [];
    for (const name of members.map(ownerDisplayName)) {
      if (name && !names.includes(name)) names.push(name);
    }

    const propertyIds = [...new Set(members.flatMap((o) => o.PropertyIds ?? []))].map(String);
    const active = members.some((o) => o.IsActive);

    const startDates = members.map((o) => o.ManagementAgreementStartDate).filter((d): d is string => d !== null);
    const earliestStart = startDates.length > 0 ? startDates.sort()[0] : null;

    // End date only means something once the WHOLE group has wound down —
    // a stray EndDate on one old/replaced record while another member is
    // still active would be misleading to show as "this owner ended."
    const endDates = members.map((o) => o.ManagementAgreementEndDate).filter((d): d is string => d !== null);
    const latestEnd = !active && endDates.length > 0 ? endDates.sort().reverse()[0] : null;

    groups.push({ names, propertyIds, active, earliestStart, latestEnd });
  }

  return groups;
}
