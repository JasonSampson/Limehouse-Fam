// Path-normalization logic for the static-page gate in server.ts, pulled out
// into its own module so it can be unit-tested directly instead of via a
// copy-pasted parallel implementation (Sentinel flagged the old test file
// for exactly that drift risk while reviewing the second bug fixed here).
export const ADMIN_ONLY_PAGES = new Set(["/team-performance.html", "/ceo-view.html"]);

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
  if (!effectivePath.endsWith(".html")) return false;
  if (effectivePath === "/login.html") return false;
  return true;
}

export function isAdminOnlyPage(effectivePath: string): boolean {
  return ADMIN_ONLY_PAGES.has(effectivePath);
}
