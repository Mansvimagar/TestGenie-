import { NextRequest } from "next/server";
import { fail, ok } from "@/lib/api-response";
import { isUndefinedColumnError } from "@/lib/database-errors";
import { assessQuestionQuality } from "@/lib/validation/question-quality";
import { publishTestRequestSchema, questionSchema } from "@/lib/validation/schemas";
import { createClient } from "@/lib/supabase/server";
import type { Question } from "@/types/question";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail("Unauthorized", 401);

  const body = await request.json().catch(() => null);
  const parsed = publishTestRequestSchema.safeParse(body);
  if (!parsed.success) return fail("Confirm faculty review before publishing.", 422);

  const { id } = await params;
  const { data: test, error: testError } = await supabase
    .from("tests")
    .select("id, user_id, status")
    .eq("id", id)
    .maybeSingle();

  if (testError) return fail("Failed to load test.", 500);
  if (!test) return fail("Test not found.", 404);
  if (test.user_id !== user.id) return fail("Forbidden.", 403);
  if (test.status !== "draft") return fail("Only draft tests can be published.", 409);

  const { data: rows, error: questionsError } = await supabase
    .from("questions")
    .select("id, topic, question, options, correct_answer_index, explanation, source_chunk_ids")
    .eq("test_id", id)
    .order("position", { ascending: true });

  if (questionsError) {
    console.error("[publish] Failed to load questions:", {
      code: questionsError.code,
      message: questionsError.message,
      details: questionsError.details,
      hint: questionsError.hint,
    });

    if (isUndefinedColumnError(questionsError)) {
      return fail("Question review database schema is incomplete. Run the reviewed database preflight and repair before retrying.", 503);
    }
    return fail("Failed to load questions for review.", 500);
  }
  if (!rows?.length) return fail("Add at least one question before publishing.", 422);
  if (rows.some((row) => !Array.isArray(row.source_chunk_ids) || row.source_chunk_ids.length === 0)) {
    return fail("Every question needs syllabus source evidence before publishing. Regenerate or revise the unsupported questions.", 422);
  }

  const questions: Question[] = [];
  for (const row of rows) {
    const parsedQuestion = questionSchema.safeParse({
      id: row.id,
      topic: row.topic,
      question: row.question,
      options: row.options,
      correctAnswerIndex: row.correct_answer_index,
      explanation: row.explanation ?? undefined,
    });
    if (!parsedQuestion.success) {
      return fail("One or more saved questions are incomplete or invalid.", 422);
    }
    questions.push(parsedQuestion.data as Question);
  }

  const quality = assessQuestionQuality(questions, []);
  const blockingIssues = quality.questions.flatMap((question, index) =>
    (question.qualityIssues ?? [])
      .filter((issue) => !issue.startsWith("No retrieved text matched"))
      .map((issue) => `Question ${index + 1}: ${issue}`)
  );
  if (blockingIssues.length > 0) {
    return fail(`Resolve question issues before publishing: ${blockingIssues.slice(0, 3).join(" ")}`, 422);
  }

  // Persist the authenticated faculty member's explicit review action. The
  // database rechecks ownership, scope, provenance, and question validity.
  const { error: reviewError } = await supabase.rpc("attest_test_review", { p_test_id: id });
  if (reviewError) {
    if (reviewError.code === "PGRST202" || reviewError.code === "42883") {
      return fail("Review attestation is not configured yet. Apply the reviewed database repair and retry.", 503);
    }
    return fail("Faculty review could not be recorded. Confirm the questions and syllabus evidence, then retry.", 422);
  }

  const { error: publishError } = await supabase.rpc("publish_test", { p_test_id: id });
  if (publishError) {
    if (publishError.code === "PGRST202" || publishError.code === "42883") {
      return fail("Publishing is not configured yet. Apply the pending database migration and retry.", 503);
    }
    if (/source|syllabus|review|question|duplicate|explanation|options|draft/i.test(publishError.message)) {
      return fail("Publication was blocked by database review. Check explanations, duplicate warnings, syllabus evidence, and the saved faculty review, then retry.", 422);
    }
    return fail("Unable to publish this test. Refresh it and review its status and questions.", 409);
  }

  return ok({ published: true });
}
