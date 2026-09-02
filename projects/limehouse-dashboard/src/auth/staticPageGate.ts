// Path-normalization logic for the static-page gate in server.ts, pulled out
// into its own module so it can be unit-tested directly instead of via a
// copy-pasted parallel implementation (Sentinel flagged the old test file
// for exactly that drift risk while reviewing the second bug fixed here).
// CHANGED [today]: was a flat set gated by one "admin" role flag; each page
// now maps to its own specific dashboard.* permission key, checked directly
// against the list LimeHQ granted at sign-in (see src/auth/session.ts).
export const GATED_PAGES: Record<string, string> = {
  "/team-performance.html": "dashboard.team_performance.view",
  "/ceo-view.html": "dashboard.ceo_view.view",
};

// Sentinel found that express's req.path is NOT percent-decoded (e.g.
// "/ceo-view%2ehtml" arrives as that literal string), so a raw path can fail
// the ".html" check here while express.static decodes "%2e" -> "." itself
// downstream and serves the real file anyway. Decoding once, up front, before
// either comparison closes that gap for "%2e" and any other percent-encodable
// character in an admin filename, not just the one Sentinel happened to try.
//
// decodeURIComponent throws on a malformed percent-sequence (e.g. a lone "%"
// or "%2h"). Treat that as suspicious rather than letting it fall through to
// next() unnormalized: null means "could not safely determine what this path
// means," and callers must deny/redirect on null, not treat it as "not gated."
export function normalizePath(rawPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  return (decoded === "/" ? "/index.html" : decoded).toLowerCase();
}

export function isGatedHtmlRequest(effectivePath: string): boolean {
  return effectivePath.endsWith(".html");
}

// Returns the permission key required for this page, or null if the page
// isn't gated at all (open to any signed-in dashboard user).
export function requiredPermissionForPage(effectivePath: string): string | null {
  return GATED_PAGES[effectivePath] ?? null;
}
