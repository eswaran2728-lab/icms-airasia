import "server-only";

import fs from "node:fs";
import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from "pdf-lib";
import { getOfficialFormTemplate, type OfficialFormKind } from "@/lib/pdf-templates";

const DEFAULT_SIZE = 9;
const INK = rgb(0, 0, 0);
const MARK = rgb(0.75, 0.08, 0.08);

// Template bytes rarely change and are small (~100KB) — cache per warm
// serverless instance instead of re-reading disk on every PDF generation.
const templateCache = new Map<string, Buffer>();

export interface LoadedTemplate {
  pdfDoc: PDFDocument;
  page: PDFPage;
  font: PDFFont;
  fontBold: PDFFont;
}

/**
 * Loads the official template PDF for `kind` and embeds standard fonts.
 * Throws (never falls back to a generated PDF) if the template file is
 * missing — callers should surface this as a clear, logged error rather
 * than silently producing the old custom layout.
 */
export async function loadOfficialTemplate(kind: OfficialFormKind): Promise<LoadedTemplate> {
  const { absolutePath, pageIndex } = getOfficialFormTemplate(kind);
  let bytes = templateCache.get(absolutePath);
  if (!bytes) {
    try {
      bytes = fs.readFileSync(absolutePath);
    } catch (e) {
      throw new Error(
        `Official form template is unavailable (${kind}, ${absolutePath}): ${(e as Error).message}`
      );
    }
    templateCache.set(absolutePath, bytes);
  }
  const pdfDoc = await PDFDocument.load(bytes);
  const page = pdfDoc.getPages()[pageIndex];
  if (!page) {
    throw new Error(`Official form template is unavailable (${kind}, page ${pageIndex}).`);
  }
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  return { pdfDoc, page, font, fontBold };
}

/**
 * Draws a value at an exact PDF-space coordinate (bottom-left origin,
 * matching the template's own coordinate system). No-op for empty/
 * nullish values — official-form fields are left blank, never filled
 * with a placeholder like "N/A".
 */
export function drawValue(
  page: PDFPage,
  font: PDFFont,
  x: number,
  y: number,
  value: string | number | null | undefined,
  opts: { size?: number; maxWidth?: number } = {}
): void {
  const text = value === null || value === undefined ? "" : String(value).trim();
  if (!text) return;
  const size = opts.size ?? DEFAULT_SIZE;
  let out = text;
  if (opts.maxWidth) {
    while (out.length > 1 && font.widthOfTextAtSize(out, size) > opts.maxWidth) {
      out = out.slice(0, -1);
    }
    if (out.length < text.length) out = out.slice(0, Math.max(0, out.length - 3)) + "...";
  }
  page.drawText(out, { x, y, size, font, color: INK });
}

/**
 * Word-wraps `value` across up to `maxLines` lines starting at
 * (x, yTop), each at most `maxWidth` wide. Text beyond maxLines is
 * dropped, not fabricated — matches the fixed number of blank lines the
 * physical form provides for remarks.
 */
export function drawWrapped(
  page: PDFPage,
  font: PDFFont,
  x: number,
  yTop: number,
  value: string | null | undefined,
  opts: { size?: number; maxWidth: number; maxLines: number; lineHeight?: number }
): void {
  const text = (value ?? "").trim();
  if (!text) return;
  const size = opts.size ?? DEFAULT_SIZE;
  const lineHeight = opts.lineHeight ?? size + 1;
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const attempt = current ? `${current} ${word}` : word;
    if (current && font.widthOfTextAtSize(attempt, size) > opts.maxWidth) {
      lines.push(current);
      current = word;
      if (lines.length === opts.maxLines) break;
    } else {
      current = attempt;
    }
  }
  if (lines.length < opts.maxLines && current) lines.push(current);
  lines.slice(0, opts.maxLines).forEach((line, i) => {
    page.drawText(line, { x, y: yTop - i * lineHeight, size, font, color: INK });
  });
}

/**
 * Embeds and draws a stored signature PNG at an exact position, scaled
 * down (never up) to fit within (maxWidth, maxHeight) while preserving
 * aspect ratio. No-op if no signature exists — an unsigned part is left
 * blank, never a fabricated signature.
 */
export async function drawSignature(
  pdfDoc: PDFDocument,
  page: PDFPage,
  bytes: Buffer | null,
  x: number,
  y: number,
  maxWidth: number,
  maxHeight: number
): Promise<void> {
  if (!bytes) return;
  try {
    const img = await pdfDoc.embedPng(bytes);
    const scale = Math.min(maxWidth / img.width, maxHeight / img.height, 1);
    page.drawImage(img, { x, y, width: img.width * scale, height: img.height * scale });
  } catch {
    // Corrupt/unsupported signature image — leave the area blank rather
    // than fail the whole PDF over one bad image.
  }
}

/**
 * Draws a rectangle outline around a printed option that's already
 * static text on the template (e.g. "SRA Warehouse" / "Aircraft" on the
 * Part D delivery-location line) to mark it selected, since there is no
 * blank field there to write into.
 */
export function markSelected(page: PDFPage, x: number, y: number, width: number, height: number): void {
  page.drawRectangle({
    x: x - 2,
    y: y - 2,
    width: width + 4,
    height: height + 4,
    borderColor: MARK,
    borderWidth: 1.1,
  });
}

/** Draws a small X mark just left of a cargo-type label to show it was selected — vector-drawn (not a text glyph) so it can't hit a font-encoding gap. */
export function markCargoTick(page: PDFPage, labelX: number, labelY: number): void {
  const cx = labelX - 8;
  const cy = labelY + 3;
  const r = 3.6;
  page.drawLine({ start: { x: cx - r, y: cy - r }, end: { x: cx + r, y: cy + r }, color: MARK, thickness: 1.3 });
  page.drawLine({ start: { x: cx - r, y: cy + r }, end: { x: cx + r, y: cy - r }, color: MARK, thickness: 1.3 });
}
