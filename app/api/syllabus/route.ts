import { NextRequest } from "next/server";
import { ok, fail } from "@/lib/api-response";
import { cleanText, extractTextFromPdf, PdfParseError } from "@/lib/pdf/parser";
import { createClient } from "@/lib/supabase/server";
import { ingestSyllabus } from "@/lib/syllabus/ingest";
import { ingestManualSyllabusSchema } from "@/lib/validation/schemas";
import type { SyllabusIngestionSummary, SyllabusSourceType } from "@/types/syllabus";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AIProviderConfigurationError } from "@/lib/ai/provider";

const MAX_FILE_SIZE = 15 * 1024 * 1024;

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return fail("Unauthorized", 401);

  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";

  if (contentType.includes("application/json")) {
    const body = await request.json().catch(() => null);
    const parsed = ingestManualSyllabusSchema.safeParse(body);
    if (!parsed.success) {
      return fail(parsed.error.issues[0]?.message ?? "Invalid syllabus text.", 422);
    }

    const cleanedText = cleanText(parsed.data.text);
    if (cleanedText.length < 50) {
      return fail("Paste at least a few sentences of syllabus content.", 422);
    }
    if (cleanedText.length > 500_000) {
      return fail("Syllabus text must be 500,000 characters or fewer.", 422);
    }

    return persistSyllabus(
      supabase,
      user.id,
      parsed.data.name,
      "manual",
      cleanedText
    );
  }

  if (!contentType.includes("multipart/form-data")) {
    return fail("Upload a PDF or send syllabus text as JSON.", 415);
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return fail("Invalid PDF upload form data.", 400);
  }

  const file = formData.get("file");
  if (!file || !(file instanceof File)) return fail("No file was uploaded.", 400);
  if (file.type !== "application/pdf") return fail("Only PDF files are supported.", 400);
  if (file.size === 0) return fail("The uploaded file is empty.", 400);
  if (file.size > MAX_FILE_SIZE) {
    return fail("The PDF exceeds the 15MB size limit.", 400);
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const cleanedText = await extractTextFromPdf(buffer);
    return persistSyllabus(
      supabase,
      user.id,
      file.name.slice(0, 200) || "Uploaded syllabus.pdf",
      "pdf",
      cleanedText
    );
  } catch (err) {
    if (err instanceof PdfParseError) return fail(err.message, 422);
    return fail("Unexpected error while processing the PDF.", 500);
  }
}

async function persistSyllabus(
  supabase: SupabaseClient,
  userId: string,
  name: string,
  sourceType: SyllabusSourceType,
  cleanedText: string
) {
  try {
    const result = await ingestSyllabus({
      supabase,
      userId,
      name,
      sourceType,
      cleanedText,
    });

    const response: SyllabusIngestionSummary = {
      syllabusId: result.syllabus.id,
      outline: result.outline,
      chunkCount: result.chunkCount,
    };

    return ok(response, 201);
  } catch (err) {
    console.error("Syllabus ingestion failed", {
      operation: "syllabus_ingestion",
      sourceType: sourceType === "manual" ? "text" : "pdf",
      errorName: err instanceof Error ? err.name : "NonErrorThrown",
      message: sanitizeDiagnosticMessage(err),
    });
    if (err instanceof AIProviderConfigurationError) return fail(err.message, 503);
    return fail("Syllabus ingestion failed. Please try again.", 500);
  }
}

function sanitizeDiagnosticMessage(err: unknown): string {
  if (!(err instanceof Error)) return "Non-Error exception";

  return err.message
    .replace(/AIza[\w-]{20,}/g, "[REDACTED]")
    .replace(/\b(Bearer|Basic)\s+\S+/gi, "$1 [REDACTED]")
    .replace(
      /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|authorization|secret)\s*[:=]\s*["']?[^\s&,"']+/gi,
      "$1=[REDACTED]"
    )
    .replace(/(https?:\/\/)[^/@\s]+@/gi, "$1[REDACTED]@")
    .replace(/([?&][^=&#\s]+=)[^&#\s]*/g, "$1[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(/\s+/g, " ")
    .slice(0, 300);
}
