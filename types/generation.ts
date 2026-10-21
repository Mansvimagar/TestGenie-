import type { Difficulty } from "./question";

/**
 * A retrieved chunk plus its similarity to the retrieval query. Returned as
 * a structured object (not a bare string) so the prompt builder can use
 * unit/topic/page metadata without re-parsing the content.
 */
export interface RetrievedChunk {
  chunkId: string;
  syllabusId: string;
  content: string;
  unit: string | null;
  topic: string | null;
  subtopic: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  similarity: number;
  /** Provider marker from chunk metadata; legacy chunks may not have one. */
  embeddingProvider?: "gemini" | "mock";
}

/**
 * Faculty-facing generation scope. `title`/`subject`/`questionCount`/
 * `difficulty` are the original MVP fields and remain required for backward
 * compatibility with the existing save-test flow. Everything else is new
 * and optional -- omitting all of it reproduces the old "whole syllabus"
 * behavior (RAG retrieval simply isn't scoped to a unit/topic).
 */
export interface GenerationConfig {
  syllabusId: string;
  title: string;
  subject: string;
  questionCount: number;
  difficulty: Difficulty;
  unit?: string | null;
  topic?: string | null;
  subtopic?: string | null;
  includedTopics?: string[];
  excludedTopics?: string[];
  additionalInstructions?: string;
  questionType?: "mcq";
}

export type GroundingStatus = "grounded" | "needs_review" | "unsupported" | "not_applicable";
export type ValidationStatus = "unique" | "duplicate" | "not_applicable";

/** Server-side post-generation validation metadata retained for review. */
export interface QuestionValidation {
  sourceChunkIds: string[];
  groundingStatus: GroundingStatus;
  validationStatus: ValidationStatus;
  metadata: Record<string, unknown>;
}
