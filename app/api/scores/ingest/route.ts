import { timingSafeEqual } from "node:crypto";
import { NextRequest } from "next/server";
import { fail, ok } from "@/lib/api-response";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { googleFormScoreWebhookSchema } from "@/lib/validation/schemas";

function hasValidWebhookSecret(request: NextRequest, expected: string): boolean {
  const authorization = request.headers.get("authorization") ?? "";
  const provided = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const expectedBuffer = Buffer.from(expected, "utf8");
  const providedBuffer = Buffer.from(provided, "utf8");
  return expectedBuffer.length === providedBuffer.length
    && timingSafeEqual(expectedBuffer, providedBuffer);
}

/** Receives a graded Google Forms submission from the configured Apps Script. */
export async function POST(request: NextRequest) {
  const secret = process.env.GOOGLE_FORMS_WEBHOOK_SECRET;
  if (!secret) return fail("Score ingestion is not configured on this server.", 503);
  if (!hasValidWebhookSecret(request, secret)) return fail("Unauthorized webhook request.", 401);

  const body = await request.json().catch(() => null);
  const parsed = googleFormScoreWebhookSchema.safeParse(body);
  if (!parsed.success) return fail("Invalid Google Forms score payload.", 422);

  const supabase = createServiceRoleClient();
  const { data: test, error: testError } = await supabase
    .from("tests")
    .select("id, status, question_count, google_form_id")
    .eq("google_form_id", parsed.data.formId)
    .maybeSingle();

  if (testError) return fail("Unable to verify the Google Form.", 500);
  if (!test || test.status !== "published") return fail("Published test for this Form was not found.", 404);
  if (parsed.data.totalQuestions !== test.question_count) {
    return fail("The Google Form graded question count does not match this published test.", 409);
  }
  if (parsed.data.score > test.question_count) {
    return fail("The reported score exceeds the number of questions in this test.", 422);
  }

  const score = parsed.data.score;
  const percentage = Math.round((score / test.question_count) * 10_000) / 100;
  const { error: upsertError } = await supabase.from("scores").upsert({
    test_id: test.id,
    google_response_id: parsed.data.responseId,
    student_name: parsed.data.studentName || parsed.data.studentEmail || "Google Forms respondent",
    student_email: parsed.data.studentEmail ?? "",
    score,
    total_questions: test.question_count,
    percentage,
    submitted_at: parsed.data.submittedAt ?? new Date().toISOString(),
  }, { onConflict: "test_id,google_response_id" });

  if (upsertError) {
    if (upsertError.code === "42703" || upsertError.code === "42P10") {
      return fail("Score ingestion schema is not ready. Apply the reviewed score idempotency migration first.", 503);
    }
    return fail("Unable to save this Google Forms score.", 500);
  }

  return ok({ accepted: true, duplicateSafe: true });
}
