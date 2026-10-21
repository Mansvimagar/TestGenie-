import type { RetrievedChunk } from "@/types/generation";

export interface RetrievalScope {
  syllabusId: string;
  unit?: string | null;
  topic?: string | null;
  subtopic?: string | null;
  includedTopics?: string[];
  excludedTopics?: string[];
}

export function matchesChunkScope(chunk: RetrievedChunk, scope: RetrievalScope): boolean {
  if (chunk.syllabusId !== scope.syllabusId) return false;
  if (scope.unit && chunk.unit !== scope.unit) return false;
  if (scope.topic && chunk.topic !== scope.topic) return false;
  if (scope.subtopic && chunk.subtopic !== scope.subtopic) return false;

  const normalize = (value: string | null | undefined) => value?.trim().toLowerCase() ?? "";
  if (scope.includedTopics?.length) {
    const included = new Set(scope.includedTopics.map(normalize));
    if (!included.has(normalize(chunk.topic))) return false;
  }
  if (scope.excludedTopics?.length) {
    const excluded = new Set(scope.excludedTopics.map(normalize));
    if (excluded.has(normalize(chunk.topic))) return false;
  }
  return true;
}

export function filterChunksToScope<T extends RetrievedChunk>(
  chunks: T[],
  scope: RetrievalScope
): T[] {
  return chunks.filter((chunk) => matchesChunkScope(chunk, scope) && hasUsableEvidence([chunk]));
}

export function hasUsableEvidence(chunks: RetrievedChunk[]): boolean {
  return chunks.some((chunk) => typeof chunk.content === "string" && chunk.content.trim().length > 0);
}
