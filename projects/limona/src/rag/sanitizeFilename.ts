// Strips any directory components from a client-supplied filename before it
// is used to build a real filesystem path. path.basename() alone is not
// enough here: it only recognizes the *current platform's* separator
// (backslash is not a separator under the posix path module), so a
// filename crafted with the "other" style of separator could still smuggle
// path segments through on some platform. Splitting on both `/` and `\`
// and keeping only the final segment is safe cross-platform regardless of
// which separator convention the OS running this code uses.
//
// Shared by src/rag/ingest.ts (documents) and src/rag/assetIngest.ts
// (assets) — this is the fix for a path-traversal vulnerability Judge
// caught earlier, and both upload paths need to stay protected identically.
// Keep this the ONE place this logic lives so a future fix here can't
// accidentally apply to only one upload path.
export function sanitizeFilename(filename: string): string {
  const base = filename.split(/[/\\]/).pop() || "";
  return base === "." || base === ".." || base === "" ? "unnamed" : base;
}
