import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";
import { describe, it, expect } from "vitest";
import { extractText, extToSupportedExt } from "../../src/rag/extractText.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(__dirname, "../fixtures");

const NULL_CHAR = String.fromCharCode(0);

function buildXlsxBuffer(): Buffer {
  const ws = XLSX.utils.aoa_to_sheet([
    ["Name", "Age"],
    ["Alice", "30"],
    ["Bob", "25"],
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

function buildMultiSheetXlsxBuffer(): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["A"], ["1"]]), "First");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["B"], ["2"]]), "Second");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

describe("extToSupportedExt", () => {
  it.each([
    [".pdf", "pdf"],
    [".docx", "docx"],
    [".xlsx", "xlsx"],
    [".csv", "csv"],
    [".txt", "txt"],
    [".md", "md"],
    [".PDF", "pdf"],
    ["docx", "docx"],
  ])("recognizes %s as %s", (input, expected) => {
    expect(extToSupportedExt(input)).toBe(expected);
  });

  it("returns null for an unsupported extension", () => {
    expect(extToSupportedExt(".exe")).toBeNull();
    expect(extToSupportedExt(".png")).toBeNull();
  });
});

describe("extractText", () => {
  it("extracts plain text from a .txt buffer", async () => {
    const text = await extractText(Buffer.from("Hello from a text file.", "utf-8"), "txt");
    expect(text).toBe("Hello from a text file.");
  });

  it("extracts plain text from a .md buffer", async () => {
    const text = await extractText(Buffer.from("# Heading\n\nSome markdown text.", "utf-8"), "md");
    expect(text).toBe("# Heading\n\nSome markdown text.");
  });

  it("extracts clean, chunkable text from a .csv buffer (handles quoted fields with embedded commas)", async () => {
    const csv = 'name,note\nAlice,"Hello, world"\nBob,plain\n';
    const text = await extractText(Buffer.from(csv, "utf-8"), "csv");
    expect(text).toContain("Alice");
    expect(text).toContain("Hello, world");
    expect(text).toContain("Bob");
    // Must not contain literal null bytes / BOM mojibake (the sheet_to_txt bug this avoided).
    expect(text.includes(NULL_CHAR)).toBe(false);
  });

  it("extracts clean text from a single-sheet .xlsx buffer, with no sheet label needed", async () => {
    const text = await extractText(buildXlsxBuffer(), "xlsx");
    expect(text).toContain("Alice");
    expect(text).toContain("30");
    expect(text).not.toContain("--- Sheet:");
    expect(text.includes(NULL_CHAR)).toBe(false);
  });

  it("labels each sheet by name when an .xlsx workbook has more than one sheet", async () => {
    const text = await extractText(buildMultiSheetXlsxBuffer(), "xlsx");
    expect(text).toContain("--- Sheet: First ---");
    expect(text).toContain("--- Sheet: Second ---");
  });

  it("extracts real text from a real .docx file (existing, untouched branch)", async () => {
    const buffer = await fs.readFile(path.join(fixturesDir, "sample.docx"));
    const text = await extractText(buffer, "docx");
    expect(text.trim().length).toBeGreaterThan(0);
  });
});
