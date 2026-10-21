import "server-only";

const MAX_FILE_SIZE = 15 * 1024 * 1024; // 15MB

export class PdfParseError extends Error {}

export async function extractTextFromPdf(buffer: Buffer): Promise<string> {
  if (buffer.length === 0) {
    throw new PdfParseError("The uploaded file is empty.");
  }
  if (buffer.length > MAX_FILE_SIZE) {
    throw new PdfParseError("The PDF exceeds the 15MB size limit.");
  }

  const pdfParse = (await import("pdf-parse")).default;

  let text: string;
  try {
    const result = await pdfParse(buffer);
    text = result.text;
  } catch {
    throw new PdfParseError("Could not read this PDF. It may be corrupted or password-protected.");
  }

  const cleaned = cleanText(text);

  if (cleaned.length < 50) {
    throw new PdfParseError(
      "No usable text was found in this PDF. It may be a scanned image — try pasting the syllabus text manually."
    );
  }

  return cleaned;
}

function cleanTextInternal(raw: string): string {
  return raw
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

// Exported so the manual-paste ingestion path (lib/syllabus/ingest.ts) can
// apply the same normalization pasted text gets from a PDF, without
// duplicating the whitespace-cleanup rules in two places.
export function cleanText(raw: string): string {
  return cleanTextInternal(raw);
}
