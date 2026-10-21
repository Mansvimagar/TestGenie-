import type { GroundingStatus, ValidationStatus } from "./generation";

export interface Question {
  id: string;
  topic: string;
  question: string;
  options: [string, string, string, string];
  correctAnswerIndex: 0 | 1 | 2 | 3;
  /** Optional for legacy questions created before explanations were stored. */
  explanation?: string;
  /**
   * All fields below are optional and additive so every existing call site
   * (mock mode, legacy full-syllabus generation, the question editor) keeps
   * compiling and rendering unchanged when they're absent.
   */
  sourceChunkIds?: string[];
  groundingStatus?: GroundingStatus;
  validationStatus?: ValidationStatus;
  qualityIssues?: string[];
  supportAssessment?: "supported" | "unsupported" | "uncertain";
  supportReviewNote?: string;
  validationMetadata?: Record<string, unknown>;
  sourceEvidence?: { chunkId: string; unit: string | null; topic: string | null; pageStart: number | null; pageEnd: number | null; content: string }[];
}

export type Difficulty = "easy" | "medium" | "hard" | "mixed";

