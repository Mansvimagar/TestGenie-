import { NextRequest } from "next/server";
import { ok, fail } from "@/lib/api-response";
import { extractTextFromPdf, PdfParseError } from "@/lib/pdf/parser";
import { createClient } from "@/lib/supabase/server";

const MAX_FILE_SIZE = 15 * 1024 * 1024;

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return fail("Unauthorized", 401);

  const formData = await request.formData();
  const file = formData.get("file");

  if (!file || !(file instanceof File)) {
    return fail("No file was uploaded.", 400);
  }
  if (file.type !== "application/pdf") {
    return fail("Only PDF files are supported.", 400);
  }
  if (file.size === 0) {
    return fail("The uploaded file is empty.", 400);
  }
  if (file.size > MAX_FILE_SIZE) {
    return fail("The PDF exceeds the 15MB size limit.", 400);
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const syllabusText = await extractTextFromPdf(buffer);
    return ok({ syllabusText });
  } catch (err) {
    if (err instanceof PdfParseError) return fail(err.message, 422);
    return fail("Unexpected error while processing the PDF.", 500);
  }
}
