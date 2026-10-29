import { ok, fail } from "@/lib/api-response";
import { createClient } from "@/lib/supabase/server";
import { draftGenerationConfigSchema, updateTestSchema } from "@/lib/validation/schemas";
import { retrieveChunks } from "@/lib/rag/retrieval";
import { assessQuestionQuality } from "@/lib/validation/question-quality";
import type { Question } from "@/types/question";
import type { RetrievedChunk } from "@/types/generation";
import { reviewGroundingSupport } from "@/lib/ai/gemini";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return fail("Unauthorized", 401);

  const { id } = await params;

  const { data: test, error: testError } = await supabase
    .from("tests")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (testError) return fail("Failed to load test.", 500);
  if (!test) return fail("Test not found.", 404);

  const { data: questions, error: questionsError } = await supabase
    .from("questions")
    .select("*")
    .eq("test_id", id)
    .order("position", { ascending: true });

  if (questionsError) return fail("Failed to load questions.", 500);

  return ok({ test, questions });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return fail("Unauthorized", 401);

  const { id } = await params;

  const body = await request.json().catch(() => null);
  const parsed = updateTestSchema.safeParse(body);
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? "Invalid request.", 422);
  }

  const { title, subject, difficulty, questions } = parsed.data;

  const { data: existing, error: fetchError } = await supabase
    .from("tests")
    .select("id, user_id, status, syllabus_id, generation_config")
    .eq("id", id)
    .maybeSingle();

  if (fetchError) return fail("Failed to load test.", 500);
  if (!existing) return fail("Test not found.", 404);
  if (existing.user_id !== user.id) return fail("Forbidden.", 403);
  if (existing.status !== "draft") return fail("Published tests cannot be edited.", 409);

  let chunks: RetrievedChunk[] = [];
  if (existing.syllabus_id) {
    const configResult = draftGenerationConfigSchema.safeParse(existing.generation_config);
    if (!configResult.success || configResult.data.syllabusId !== existing.syllabus_id) {
      return fail("Saved generation settings are incomplete. Evidence validation is unavailable.", 409);
    }
    const config = configResult.data;
    const { data: syllabus, error: syllabusError } = await supabase
      .from("syllabi")
      .select("id, status")
      .eq("id", existing.syllabus_id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (syllabusError || !syllabus) return fail("Syllabus not found.", 404);
    if (syllabus.status !== "ready") return fail("Syllabus is not ready to validate this test.", 409);
    try {
      chunks = await retrieveChunks(supabase, {
        syllabusId: existing.syllabus_id,
        unit: config.unit,
        topic: config.topic,
        subtopic: config.subtopic,
        includedTopics: config.includedTopics,
        excludedTopics: config.excludedTopics,
        additionalInstructions: config.additionalInstructions,
        subject: config.subject,
      });
    } catch {
      return fail("Unable to validate the syllabus context. Please try again.", 503);
    }
    if (chunks.length === 0) return fail("No syllabus evidence is available for this test scope.", 422);
    if (!chunks.every((chunk) => chunk.embeddingProvider === "gemini")) {
      return fail("Syllabus evidence could not be verified. Re-ingest this syllabus with Gemini embeddings.", 409);
    }
  }
  const candidates: Question[] = questions.map((question, index) => ({
    ...question,
    id: question.id || `updated-${index}`,
    options: question.options as Question["options"],
    correctAnswerIndex: question.correctAnswerIndex as Question["correctAnswerIndex"],
  }));
  const checked = assessQuestionQuality(candidates, chunks);
  const reviewedQuestions = chunks.length > 0
    ? await reviewGroundingSupport(checked.questions, chunks)
    : checked.questions;
  if (reviewedQuestions.some((question) => !question.sourceChunkIds?.length)) {
    return fail("Every saved question needs a retrieved syllabus source. Regenerate or revise the unsupported questions.", 422);
  }

  const { error: updateError } = await supabase.rpc("update_test_questions", {
    p_test_id: id,
    p_title: title,
    p_subject: subject,
    p_difficulty: difficulty,
    p_questions: reviewedQuestions.map((q) => ({
      topic: q.topic,
      question: q.question,
      options: q.options,
      correctAnswerIndex: q.correctAnswerIndex,
      explanation: q.explanation ?? null,
      sourceChunkIds: q.sourceChunkIds ?? [],
      groundingStatus: q.groundingStatus ?? "needs_review",
      validationStatus: q.validationStatus ?? "not_applicable",
      validationMetadata: {
        ...(q.validationMetadata ?? {}),
        supportAssessment: q.supportAssessment ?? "uncertain",
        supportReviewNote: q.supportReviewNote ?? "Faculty verification required.",
        qualityIssues: q.qualityIssues ?? [],
      },
    })),
  });

  if (updateError) {
    const validationFailure = /invalid question|source evidence|source (?:chunk|ids)|gemini chunks|syllabus scope|draft tests can be edited|only draft/i
      .test(updateError.message);
    return validationFailure
      ? fail("Draft changes were rejected. Check that every question has in-scope Gemini syllabus evidence and that the test is still a draft.", 422)
      : fail("Failed to save test changes. Please try again.", 500);
  }

  return ok({ updated: true });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return fail("Unauthorized", 401);

  const { id } = await params;

  const { error, count } = await supabase
    .from("tests")
    .delete({ count: "exact" })
    .eq("id", id);

  if (error) return fail("Failed to delete test.", 500);
  if (!count) return fail("Test not found.", 404);

  return ok({ deleted: true });
}
