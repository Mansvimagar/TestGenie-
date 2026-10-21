import { groundedQuestionsArraySchema } from "@/lib/validation/schemas";
import type { Question } from "@/types/question";

/** Parse untrusted model JSON and discard all model-asserted identity/provenance. */
export function parseGroundedQuestionResponse(
  raw: string,
  requestedCount: number
): Question[] | null {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { questions?: unknown }).questions)) {
    return null;
  }

  const candidates = (payload as { questions: unknown[] }).questions.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const question = { ...(value as Record<string, unknown>) };
    delete question.sourceChunkIds;
    delete question.groundingStatus;
    delete question.validationStatus;
    delete question.id;
    return {
      ...question,
      id: crypto.randomUUID(),
      groundingStatus: "needs_review",
      validationStatus: "not_applicable",
    };
  });

  const result = groundedQuestionsArraySchema.safeParse(candidates);
  if (!result.success || result.data.length > requestedCount) return null;
  return result.data as Question[];
}
