import mammoth from "mammoth";
// pdf-parse has no ESM types; import the default export via createRequire
// to stay CommonJS-compatible without fighting the package's packaging.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdfParse = require("pdf-parse") as (buffer: Buffer) => Promise<{ text: string }>;

export type SupportedExt = "docx" | "pdf";

export function extToSupportedExt(ext: string): SupportedExt | null {
  const normalized = ext.replace(/^\./, "").toLowerCase();
  if (normalized === "docx" || normalized === "pdf") return normalized;
  return null;
}

// Extracts plain text from an uploaded document's original bytes. Only
// .docx and .pdf are supported per the approved spec — anything else should
// be rejected before this function is called (see routes/adminDocumentRoutes.ts).
export async function extractText(buffer: Buffer, ext: SupportedExt): Promise<string> {
  if (ext === "docx") {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }
  // ext === "pdf"
  const result = await pdfParse(buffer);
  return result.text;
}
