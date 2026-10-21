import "server-only";
import type { DocumentStructure } from "@/types/syllabus";

// Target size, not a hard cap -- kept conservative so several chunks fit
// comfortably inside a single Gemini prompt alongside the generation rules.
// Configurable via env so it can be tuned without a code change.
export const CHUNK_TARGET_CHARS = Number(process.env.SYLLABUS_CHUNK_TARGET_CHARS ?? 1400);
export const CHUNK_MIN_CHARS = 200;

export interface PendingChunk {
  unit: string | null;
  topic: string | null;
  subtopic: string | null;
  content: string;
  chunkIndex: number;
  metadata: Record<string, unknown>;
}

/**
 * Splits detected units/topics into chunks small enough to embed and
 * retrieve individually. Prefers to cut on unit/topic boundaries first
 * (so a chunk never mixes two topics when the document naturally
 * separates them) and only falls back to paragraph-boundary splitting
 * within a single topic when that topic's body is longer than the chunk
 * target.
 */
export function chunkSyllabus(fullText: string, structure: DocumentStructure): PendingChunk[] {
  const chunks: PendingChunk[] = [];
  let chunkIndex = 0;

  for (const unit of structure.units) {
    if (unit.topics.length === 0) {
      // No sub-headings detected inside this unit -- chunk its raw body by
      // paragraph instead of pretending a topic exists.
      const body = fullText.slice(unit.startOffset, unit.endOffset).trim();
      for (const part of splitByParagraph(body)) {
        chunks.push({
          unit: unit.name === "Full Syllabus" ? null : unit.name,
          topic: null,
          subtopic: null,
          content: part,
          chunkIndex: chunkIndex++,
          metadata: { structureConfident: structure.confident },
        });
      }
      continue;
    }

    for (const topic of unit.topics) {
      const body = fullText.slice(topic.startOffset, topic.endOffset).trim();
      const dominantSubtopic = topic.subtopics.length === 1 ? topic.subtopics[0] : null;

      for (const part of splitByParagraph(body)) {
        chunks.push({
          unit: unit.name === "Full Syllabus" ? null : unit.name,
          topic: topic.name,
          subtopic: dominantSubtopic,
          content: part,
          chunkIndex: chunkIndex++,
          metadata: {
            structureConfident: structure.confident,
            subtopics: topic.subtopics.length > 1 ? topic.subtopics : undefined,
          },
        });
      }
    }
  }

  // Guaranteed non-empty: if literally nothing above produced a chunk
  // (e.g. detectStructure somehow returned an empty unit list), fall back
  // to naive fixed-size splitting of the whole document rather than
  // silently storing zero chunks for a syllabus.
  if (chunks.length === 0) {
    for (const part of splitByParagraph(fullText)) {
      chunks.push({
        unit: null,
        topic: null,
        subtopic: null,
        content: part,
        chunkIndex: chunkIndex++,
        metadata: { structureConfident: false, fallback: true },
      });
    }
  }

  return chunks;
}

/**
 * Splits `text` into pieces close to CHUNK_TARGET_CHARS, cutting on
 * paragraph breaks (blank lines) where possible and only falling back to a
 * hard character cut for a single paragraph that alone exceeds the target.
 */
function splitByParagraph(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= CHUNK_TARGET_CHARS) return [trimmed];

  const paragraphs = trimmed.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  let buffer = "";

  for (const para of paragraphs) {
    const candidate = buffer ? `${buffer}\n\n${para}` : para;
    if (candidate.length <= CHUNK_TARGET_CHARS) {
      buffer = candidate;
      continue;
    }

    if (buffer) {
      out.push(buffer);
      buffer = "";
    }

    if (para.length <= CHUNK_TARGET_CHARS) {
      buffer = para;
    } else {
      // A single paragraph is itself larger than the target -- hard-split it.
      for (let i = 0; i < para.length; i += CHUNK_TARGET_CHARS) {
        out.push(para.slice(i, i + CHUNK_TARGET_CHARS));
      }
    }
  }

  if (buffer) out.push(buffer);
  return out.filter((c) => c.length >= CHUNK_MIN_CHARS || out.length === 1);
}
