import type { SessionPayload } from "./session.js";

const FRESH_REAUTH_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

// The fallback-decision-maker send action requires fresh re-authentication,
// not a stale session — it is the most consequential single action in the
// system. This checks that the session's authenticatedAt timestamp is
// recent; the route handler must force a full Entra re-login (not just
// re-check this) when it isn't, then re-issue the session with a fresh
// authenticatedAt before allowing the fallback send to proceed.
export function isReauthFresh(session: SessionPayload): boolean {
  return Date.now() - session.authenticatedAt < FRESH_REAUTH_WINDOW_MS;
}
