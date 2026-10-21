import { NextRequest } from "next/server";
import { ok, fail } from "@/lib/api-response";
import { createClient } from "@/lib/supabase/server";
import { draftGenerationConfigSchema } from "@/lib/validation/schemas";
import { retrieveChunks, RetrievalError } from "@/lib/rag/retrieval";
import { generateGroundedQuestions, GenerationError, reviewGroundingSupport } from "@/lib/ai/gemini";
import { assessQuestionQuality } from "@/lib/validation/question-quality";
import type { GenerationConfig, RetrievedChunk } from "@/types/generation";
import type { Question } from "@/types/question";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; questionId: string }> }
) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail("Unauthorized", 401);

  const { id: testId, questionId } = await params;
  const { data: test, error: testError } = await supabase
    .from("tests")
    .select("id, user_id, status, syllabus_id, generation_config")
    .eq("id", testId)
    .maybeSingle();
  if (testError) return fail("Failed to load test.", 500);
  if (!test) return fail("Test not found.", 404);
  if (test.user_id !== user.id) return fail("Forbidden.", 403);
  if (test.status !== "draft") return fail("Only draft questions can be regenerated.", 409);
  if (!test.syllabus_id) return fail("This test is not linked to an ingested syllabus.", 409);

  const configResult = draftGenerationConfigSchema.safeParse(test.generation_config);
  if (!configResult.success || configResult.data.syllabusId !== test.syllabus_id) {
    return fail("Saved generation settings are incomplete. Regeneration is unavailable.", 409);
  }
  const savedConfig = configResult.data;

  const { data: existingQuestion, error: questionError } = await supabase
    .from("questions")
    .select("id")
    .eq("id", questionId)
    .eq("test_id", testId)
    .maybeSingle();
  if (questionError) return fail("Failed to load question.", 500);
  if (!existingQuestion) return fail("Question not found.", 404);

  const { data: otherQuestionRows, error: otherQuestionsError } = await supabase
    .from("questions")
    .select("id, topic, question, options, correct_answer_index")
    .eq("test_id", testId)
    .neq("id", questionId);
  if (otherQuestionsError) return fail("Failed to load questions for duplicate review.", 500);

  const { data: syllabus, error: syllabusError } = await supabase
    .from("syllabi")
    .select("id, status")
    .eq("id", test.syllabus_id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (syllabusError || !syllabus) return fail("Syllabus not found.", 404);
  if (syllabus.status !== "ready") return fail("Syllabus is not ready for regeneration.", 409);

  let chunks: RetrievedChunk[];
  try {
    chunks = await retrieveChunks(supabase, {
      syllabusId: test.syllabus_id,
      unit: savedConfig.unit,
      topic: savedConfig.topic,
      subtopic: savedConfig.subtopic,
      includedTopics: savedConfig.includedTopics,
      excludedTopics: savedConfig.excludedTopics,
      additionalInstructions: savedConfig.additionalInstructions,
      subject: savedConfig.subject,
    });
  } catch (error) {
    if (error instanceof RetrievalError) return fail("Syllabus retrieval failed. Please try again.", 503);
    return fail("Unable to retrieve syllabus context. Please try again.", 503);
  }
  if (chunks.length === 0) return fail("No syllabus evidence is available for this test scope.", 422);
  if (!chunks.every((chunk) => chunk.embeddingProvider === "gemini")) {
    return fail("Syllabus evidence could not be verified. Re-ingest this syllabus with Gemini embeddings.", 409);
  }

  try {
    const config: GenerationConfig = { ...savedConfig, questionCount: 1 };
    const generated = await generateGroundedQuestions(config, chunks);
    const existingQuestions: Question[] = (otherQuestionRows ?? []).map((question) => ({
      id: question.id,
      topic: question.topic,
      question: question.question,
      options: question.options as Question["options"],
      correctAnswerIndex: question.correct_answer_index as Question["correctAnswerIndex"],
    }));
    const qualityResults = assessQuestionQuality(
      [...existingQuestions, ...generated.slice(0, 1)],
      chunks
    ).questions;
    const candidate = qualityResults.slice(-1);
    const [replacement] = await reviewGroundingSupport(candidate, chunks);
    const { data: updatedQuestion, error: updateError } = await supabase
      .from("questions")
      .update({
        topic: replacement.topic,
        question: replacement.question,
        options: replacement.options,
        correct_answer_index: replacement.correctAnswerIndex,
        explanation: replacement.explanation,
        source_chunk_ids: replacement.sourceChunkIds ?? [],
        grounding_status: "needs_review",
        validation_status: replacement.validationStatus ?? "unique",
        validation_metadata: {
          ...(replacement.validationMetadata ?? {}),
          supportAssessment: replacement.supportAssessment ?? "uncertain",
          supportReviewNote: replacement.supportReviewNote ?? "Faculty verification required.",
          qualityIssues: replacement.qualityIssues ?? [],
        },
      })
      .eq("id", questionId)
      .eq("test_id", testId)
      .select("id")
      .maybeSingle();
    if (updateError) return fail("Failed to save the regenerated question.", 500);
    if (!updatedQuestion) return fail("Question no longer exists in this test.", 404);
    return ok({ question: replacement });
  } catch (error) {
    if (error instanceof GenerationError) return fail(error.message, 422);
    return fail("Unable to regenerate this question. Please try again.", 500);
  }
}
