export type SyllabusSourceType = "pdf" | "manual";
export type SyllabusStatus = "pending" | "processing" | "ready" | "error";

export interface Syllabus {
  id: string;
  user_id: string;
  name: string;
  file_path: string | null;
  source_type: SyllabusSourceType;
  raw_text: string | null;
  status: SyllabusStatus;
  page_count: number | null;
  processing_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface SyllabusChunkRow {
  id: string;
  syllabus_id: string;
  unit: string | null;
  topic: string | null;
  subtopic: string | null;
  content: string;
  page_start: number | null;
  page_end: number | null;
  chunk_index: number;
  metadata: Record<string, unknown>;
  created_at: string;
  // embedding is intentionally never typed/read here -- the app never pulls
  // the raw vector into application code once it has been stored.
}

/** One detected unit/topic/subtopic outline entry, before chunking. */
export interface DetectedTopic {
  name: string;
  subtopics: string[];
  /** Character offsets into the cleaned full text. */
  startOffset: number;
  endOffset: number;
}

export interface DetectedUnit {
  name: string;
  topics: DetectedTopic[];
  startOffset: number;
  endOffset: number;
}

export interface DocumentStructure {
  units: DetectedUnit[];
  /**
   * false when no UNIT/MODULE/CHAPTER-style heading was confidently found.
   * In that case `units` still contains exactly one synthetic "Full
   * Syllabus" unit so downstream chunking has a uniform shape to consume --
   * the low confidence is what should stop the UI from presenting this as
   * real structure, not the absence of a unit.
   */
  confident: boolean;
}

/** Lightweight outline sent to the client so it can render Unit/Topic selects. */
export interface SyllabusOutline {
  syllabusId: string;
  structureConfident: boolean;
  units: {
    name: string;
    topics: { name: string; subtopics: string[] }[];
  }[];
}

/** Metadata returned after a PDF or pasted syllabus is ingested. */
export interface SyllabusIngestionSummary {
  syllabusId: string;
  outline: SyllabusOutline;
  chunkCount: number;
}
