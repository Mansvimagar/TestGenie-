import type { Question } from "@/types/question";
import type { RetrievedChunk } from "@/types/generation";
import { matchesChunkScope, type RetrievalScope } from "./scope";

export class ProvenanceValidationError extends Error {}

/**
 * Ensures every persisted/returned source ID was supplied by this server-side
 * retrieval and still matches the requested syllabus scope. This validates
 * reference integrity only; it does not prove semantic support.
 */
export function assertQuestionProvenance(
  questions: Question[],
  chunks: RetrievedChunk[],
  scope: RetrievalScope
): void {
  const eligibleIds = new Set(
    chunks.filter((chunk) => matchesChunkScope(chunk, scope)).map((chunk) => chunk.chunkId)
  );

  for (const question of questions) {
    const ids = question.sourceChunkIds ?? [];
    if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== "string" || !eligibleIds.has(id))) {
      throw new ProvenanceValidationError("Question provenance does not match retrieved syllabus evidence.");
    }
  }
}
