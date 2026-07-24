import mammoth from "mammoth";
import * as XLSX from "xlsx";
// pdf-parse has no ESM types; import the default export via createRequire
// to stay CommonJS-compatible without fighting the package's packaging.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdfParse = require("pdf-parse") as (buffer: Buffer) => Promise<{ text: string }>;

export type SupportedExt = "docx" | "pdf" | "xlsx" | "csv" | "txt" | "md";

export function extToSupportedExt(ext: string): SupportedExt | null {
  const normalized = ext.replace(/^\./, "").toLowerCase();
  if (
    normalized === "docx" ||
    normalized === "pdf" ||
    normalized === "xlsx" ||
    normalized === "csv" ||
    normalized === "txt" ||
    normalized === "md"
  ) {
    return normalized;
  }
  return null;
}

// Concatenates every sheet of a parsed workbook into one chunkable text
// blob, labeling sheets by name only when there's more than one (a
// single-sheet workbook — the common case — doesn't need a label at all).
//
// Uses sheet_to_csv rather than sheet_to_txt: sheet_to_txt reproduces
// Excel's legacy "Text (Tab delimited)" export, which is UTF-16LE with a
// BOM — as a JS string that comes through with a literal BOM character and
// a null byte after every character, which is unusable/unchunkable text.
// sheet_to_csv produces plain, clean UTF-8-safe text.
function workbookToText(workbook: XLSX.WorkBook): string {
  const sheetNames = workbook.SheetNames;
  const sheetTexts = sheetNames.map((name) => XLSX.utils.sheet_to_csv(workbook.Sheets[name]));
  if (sheetNames.length <= 1) {
    return sheetTexts[0] ?? "";
  }
  return sheetNames.map((name, i) => `--- Sheet: ${name} ---\n${sheetTexts[i]}`).join("\n\n");
}

// Extracts plain text from an uploaded document's original bytes. Only the
// extensions in SupportedExt are accepted — anything else should be
// rejected before this function is called (see routes/adminDocumentRoutes.ts).
export async function extractText(buffer: Buffer, ext: SupportedExt): Promise<string> {
  if (ext === "docx") {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }
  if (ext === "pdf") {
    const result = await pdfParse(buffer);
    return result.text;
  }
  if (ext === "xlsx") {
    const workbook = XLSX.read(buffer, { type: "buffer" });
    return workbookToText(workbook);
  }
  if (ext === "csv") {
    // Read as a string (not a raw buffer) so XLSX's CSV parser correctly
    // handles quoted fields and embedded commas rather than splitting on
    // every comma naively.
    const workbook = XLSX.read(buffer.toString("utf-8"), { type: "string" });
    return workbookToText(workbook);
  }
  // ext === "txt" || ext === "md"
  return buffer.toString("utf-8");
}
