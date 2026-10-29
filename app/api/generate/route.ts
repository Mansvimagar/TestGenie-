import { NextRequest } from "next/server";
import { ok, fail } from "@/lib/api-response";
import { createClient } from "@/lib/supabase/server";
import { groundedGenerateRequestSchema } from "@/lib/validation/schemas";
import { generateGroundedQuestionBatches, GenerationError, reviewGroundingSupport } from "@/lib/ai/gemini";
import { httpStatusForFailure } from "@/lib/ai/model";
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

// Must exceed REQUEST_GENERATION_BUDGET_MS (240s) plus retrieval and the support review.
export const maxDuration = 300;

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

  const correlationId = crypto.randomUUID();
  let stage = "retrieve";
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

    stage = "gemini_generate";
    // Grounding and provenance checks run on every batch before it is merged.
    const generation = await generateGroundedQuestionBatches(config, chunks, {
      allowPartial: input.allowPartial === true,
      validateBatch: (batch) => {
        const { questions: qualityChecked } = assessQuestionQuality(batch, chunks);
        if (qualityChecked.some((question) => !question.sourceChunkIds?.length)) {
          throw new GenerationError(
            "The retrieved syllabus context could not support every generated question. Choose another scope or reduce the question count."
          );
        }
        assertQuestionProvenance(qualityChecked, chunks, {
          syllabusId: config.syllabusId,
          unit: config.unit,
          topic: config.topic,
        });
        return qualityChecked;
      },
    });
    stage = "support_review";
    const questions = await reviewGroundingSupport(generation.questions, chunks);
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
    return ok({
      questions: questionsWithEvidence,
      syllabusId: config.syllabusId,
      generationConfig: config,
      partial: generation.partial,
      requestedCount: generation.requested,
    });
  } catch (err) {
    // Only the error class and a length-capped message are logged: no keys, syllabus text or user data.
    console.error("Generation request failed", {
      correlationId,
      stage,
      errorName: err instanceof Error ? err.name.slice(0, 80) : "NonErrorThrown",
      message: err instanceof Error ? err.message.replace(/\s+/g, " ").slice(0, 200) : "Non-Error exception",
    });
    const ref = ` (ref ${correlationId.slice(0, 8)})`;
    if (err instanceof GenerationError) return fail(err.message + ref, httpStatusForFailure(err.kind));
    if (err instanceof RetrievalError) return fail(`Syllabus retrieval failed. Please try again.${ref}`, 503);
    return fail(`AI generation failed at the ${stage.replace(/_/g, " ")} step. Please try again.${ref}`, 500);
  }
}
