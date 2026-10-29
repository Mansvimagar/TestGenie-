import { NextRequest } from "next/server";
import { ok, fail } from "@/lib/api-response";
import { createClient } from "@/lib/supabase/server";
import { createDraftTestSchema } from "@/lib/validation/schemas";
import { retrieveChunks } from "@/lib/rag/retrieval";
import { assessQuestionQuality } from "@/lib/validation/question-quality";
import { reviewGroundingSupport } from "@/lib/ai/gemini";
import type { Question } from "@/types/question";
import type { RetrievedChunk } from "@/types/generation";
import { assertQuestionProvenance } from "@/lib/rag/provenance";

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return fail("Unauthorized", 401);

  const { data, error } = await supabase
    .from("tests")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) return fail("Failed to load tests.", 500);
  return ok({ tests: data });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return fail("Unauthorized", 401);

  const body = await request.json().catch(() => null);
  const parsed = createDraftTestSchema.safeParse(body);
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? "Invalid request.", 422);
  }

  const { syllabusId, generationConfig, questions } = parsed.data;
  const { data: syllabus, error: syllabusError } = await supabase
    .from("syllabi")
    .select("id, status")
    .eq("id", syllabusId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (syllabusError || !syllabus) return fail("Syllabus not found.", 404);
  if (syllabus.status !== "ready") return fail("Syllabus is not ready to save with this draft.", 409);

  let chunks: RetrievedChunk[];
  try {
    chunks = await retrieveChunks(supabase, {
      syllabusId,
      unit: generationConfig.unit,
      topic: generationConfig.topic,
      subtopic: generationConfig.subtopic,
      includedTopics: generationConfig.includedTopics,
      excludedTopics: generationConfig.excludedTopics,
      additionalInstructions: generationConfig.additionalInstructions,
      subject: generationConfig.subject,
    });
  } catch {
    return fail("Unable to validate the syllabus context before saving. Please try again.", 503);
  }
  if (chunks.length === 0 || !chunks.some((chunk) => chunk.content.trim())) {
    return fail("No syllabus evidence is available for this draft scope.", 422);
  }
  if (!chunks.every((chunk) => chunk.embeddingProvider === "gemini")) {
    return fail("Syllabus evidence could not be verified. Re-ingest this syllabus with Gemini embeddings.", 409);
  }

  const candidates: Question[] = questions.map((question, index) => ({
    id: `draft-${index}`,
    ...question,
    options: question.options as Question["options"],
    correctAnswerIndex: question.correctAnswerIndex as Question["correctAnswerIndex"],
  }));
  const quality = await reviewGroundingSupport(assessQuestionQuality(candidates, chunks).questions, chunks);
  if (quality.some((question) => !question.sourceChunkIds?.length)) {
    return fail("Every saved question needs a retrieved syllabus source. Regenerate or revise the unsupported questions.", 422);
  }
  try {
    assertQuestionProvenance(quality, chunks, {
      syllabusId,
      unit: generationConfig.unit,
      topic: generationConfig.topic,
      subtopic: generationConfig.subtopic,
      includedTopics: generationConfig.includedTopics,
      excludedTopics: generationConfig.excludedTopics,
    });
  } catch {
    return fail("Question evidence did not match the saved syllabus scope. Please regenerate this draft.", 409);
  }

  const { data: test, error: saveError } = await supabase.rpc("save_draft_test", {
    p_syllabus_id: syllabusId,
    p_generation_config: generationConfig,
    p_questions: quality.map((question) => ({
      topic: question.topic,
      question: question.question,
      options: question.options,
      correctAnswerIndex: question.correctAnswerIndex,
      explanation: question.explanation,
      sourceChunkIds: question.sourceChunkIds ?? [],
      groundingStatus: question.groundingStatus ?? "needs_review",
      validationStatus: question.validationStatus ?? "not_applicable",
      validationMetadata: {
        ...question.validationMetadata,
        supportAssessment: question.supportAssessment ?? "uncertain",
        supportReviewNote: question.supportReviewNote ?? "Faculty verification required.",
        qualityIssues: question.qualityIssues ?? [],
      },
    })),
  });

  if (saveError) {
    const validationFailure = /invalid draft|invalid question|source evidence|source (?:chunk|ids)|gemini chunks|syllabus scope|options must|explanation/i
      .test(saveError.message);
    return validationFailure
      ? fail("Draft not saved: review the question content and ensure every question has valid in-scope Gemini syllabus evidence.", 422)
      : fail("Failed to save the draft. Please try again.", 500);
  }
  if (!test || typeof test !== "object" || !("id" in test)) {
    return fail("Failed to save the draft. Please try again.", 500);
  }

  return ok({ test }, 201);
}
