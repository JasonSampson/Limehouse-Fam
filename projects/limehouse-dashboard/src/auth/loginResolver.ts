import type { VerifiedIdentity } from "./entra.js";
import { findByEntraId, findByEmail, linkFirstLogin, bumpLastLogin, type StaffUserRow } from "../db/staffUsers.js";

export type LoginResolution =
  | { outcome: "authorized"; user: StaffUserRow }
  | { outcome: "rejected" };

// The one genuinely new piece vs. late-rent-notices' pm_users lookup (which
// only ever matches by entra_object_id, since every row there already has
// one hand-inserted). staff_users rows start with entra_object_id NULL until
// Jason invites someone and they sign in for the first time, so this must
// try entra_object_id first (returning user), then fall back to email
// (first-ever login for an invite), and never create a row itself.
export async function resolveLogin(identity: VerifiedIdentity): Promise<LoginResolution> {
  const byEntraId = await findByEntraId(identity.entraObjectId);
  if (byEntraId) {
    if (!byEntraId.active) return { outcome: "rejected" };
    await bumpLastLogin(byEntraId.id);
    return { outcome: "authorized", user: { ...byEntraId, lastLoginAt: new Date().toISOString() } };
  }

  const byEmail = await findByEmail(identity.email);
  if (byEmail && byEmail.entraObjectId === null) {
    if (!byEmail.active) return { outcome: "rejected" };
    const linked = await linkFirstLogin({
      id: byEmail.id,
      entraObjectId: identity.entraObjectId,
      displayName: identity.displayName,
    });
    return { outcome: "authorized", user: linked };
  }

  // No match by entra_object_id, no match by email, OR a same-email row
  // already linked to a DIFFERENT entra_object_id (shouldn't happen given
  // the unique constraint, but treated as rejected rather than silently
  // logging someone into the wrong account) — never create a row here.
  return { outcome: "rejected" };
}
