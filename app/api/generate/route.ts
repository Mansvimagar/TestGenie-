import { NextRequest } from "next/server";
import { ok, fail } from "@/lib/api-response";
import { createClient } from "@/lib/supabase/server";
import { groundedGenerateRequestSchema } from "@/lib/validation/schemas";
import { generateGroundedQuestions, GenerationError, reviewGroundingSupport } from "@/lib/ai/gemini";
import { retrieveChunks, RetrievalError } from "@/lib/rag/retrieval";
import { assessQuestionQuality } from "@/lib/validation/question-quality";
import type { GenerationConfig } from "@/types/generation";
import { hasUsableEvidence } from "@/lib/rag/scope";
import { assertQuestionProvenance } from "@/lib/rag/provenance";
import {
  AIProviderConfigurationError,
  getAIProvider,
  type AIProvider,
} from "@/lib/ai/provider";

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail("Unauthorized", 401);

  const body = await request.json().catch(() => null);
  const parsed = groundedGenerateRequestSchema.safeParse(body);
  if (!parsed.success) {
    return fail("Invalid generation request. Check the request fields and values.", 422);
  }

  let provider: AIProvider;
  try {
    provider = getAIProvider();
  } catch (err) {
    if (err instanceof AIProviderConfigurationError) return fail(err.message, 503);
    return fail("AI provider configuration is invalid.", 503);
  }

  // Mock embeddings are deterministic placeholders, not semantic retrieval.
  if (provider === "mock") {
    return fail("Syllabus-grounded generation is unavailable in mock AI mode.", 503);
  }

  const input = parsed.data;
  const { data: syllabus, error: syllabusError } = await supabase
    .from("syllabi")
    .select("id, status")
    .eq("id", input.syllabusId)
    .eq("user_id", user.id)
    .maybeSingle();

  // Do not disclose whether another user's syllabus exists.
  if (syllabusError || !syllabus) return fail("Syllabus not found.", 404);
  if (syllabus.status !== "ready") return fail("Syllabus is not ready for generation.", 409);

  const config: GenerationConfig = {
    syllabusId: input.syllabusId,
    title: input.testTitle,
    subject: input.subject,
    questionCount: input.questionCount,
    difficulty: input.difficulty,
    unit: input.unit ?? null,
    topic: input.topic ?? null,
    additionalInstructions: input.additionalInstructions,
    questionType: "mcq",
  };

  try {
    const chunks = await retrieveChunks(supabase, {
      syllabusId: input.syllabusId,
      unit: config.unit,
      topic: config.topic,
      additionalInstructions: config.additionalInstructions,
      subject: config.subject,
    });
    if (!hasUsableEvidence(chunks)) {
      return fail("No syllabus content was found in the selected scope. Choose another scope.", 422);
    }
    if (!chunks.every((chunk) => chunk.embeddingProvider === "gemini")) {
      return fail(
        "Some syllabus chunks have mock or unverified embedding provenance. Re-ingest the syllabus using Gemini embeddings and select the new syllabus before generating.",
        409
      );
    }

    const generatedQuestions = await generateGroundedQuestions(config, chunks);
    const { questions: qualityChecked } = assessQuestionQuality(generatedQuestions, chunks);
    assertQuestionProvenance(qualityChecked, chunks, {
      syllabusId: config.syllabusId,
      unit: config.unit,
      topic: config.topic,
    });
    const questions = await reviewGroundingSupport(qualityChecked, chunks);
    const evidenceById = new Map(chunks.map((chunk) => [chunk.chunkId, chunk]));
    const questionsWithEvidence = questions.map((question) => ({
      ...question,
      sourceEvidence: (question.sourceChunkIds ?? []).flatMap((chunkId) => {
        const chunk = evidenceById.get(chunkId);
        return chunk ? [{
          chunkId,
          unit: chunk.unit,
          topic: chunk.topic,
          pageStart: chunk.pageStart,
          pageEnd: chunk.pageEnd,
          content: chunk.content,
        }] : [];
      }),
    }));
    return ok({ questions: questionsWithEvidence, syllabusId: config.syllabusId, generationConfig: config });
  } catch (err) {
    if (err instanceof GenerationError) return fail(err.message, 422);
    if (err instanceof RetrievalError) return fail("Syllabus retrieval failed. Please try again.", 503);
    return fail("AI generation failed. Please try again.", 500);
  }
}
