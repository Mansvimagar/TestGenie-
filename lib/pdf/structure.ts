import "server-only";
import type { DetectedTopic, DetectedUnit, DocumentStructure } from "@/types/syllabus";

// Matches lines like "UNIT I", "Unit 1:", "Unit - II", "MODULE 3", "Chapter 4"
// at the start of a line. Deliberately generic -- no university-specific
// vocabulary or hardcoded unit names, per constraint.
const UNIT_HEADING_RE =
  /^\s*(unit|module|chapter)\s*[-:]?\s*([ivxlcdm]+|\d+)\s*[:\-–.]?\s*(.*)$/i;

// Matches numbered subsection headings such as "1.2 CPU Scheduling",
// "3) Round Robin", or an explicit "Topic: X" / "Topics: X" line.
const TOPIC_HEADING_RE = /^\s*(?:(\d+(?:\.\d+)*)[.)]\s+(.{2,120})|topics?\s*[:\-]\s*(.{2,200}))\s*$/i;

// Bullet / dash-prefixed lines directly under a topic are treated as
// subtopics, e.g. "- FCFS", "* SJF", "• Priority Scheduling".
const SUBTOPIC_RE = /^\s*[-*•]\s+(.{2,150})\s*$/;

const MIN_UNIT_BODY_CHARS = 20;

/**
 * Detects UNIT/MODULE/CHAPTER-style structure in cleaned syllabus text.
 * Works purely off the document's own headings -- it never invents unit or
 * topic names that aren't present in the text. If no heading pattern is
 * found with reasonable confidence, the entire document is returned as one
 * synthetic "Full Syllabus" unit and `confident` is set to false so callers
 * (UI, chunker) know not to present this as real structure.
 */
export function detectStructure(text: string): DocumentStructure {
  const lines = text.split("\n");

  type LineMatch = { lineIndex: number; offset: number; kind: "unit" | "topic"; title: string };
  const matches: LineMatch[] = [];

  let offset = 0;
  const lineOffsets: number[] = [];
  for (const line of lines) {
    lineOffsets.push(offset);
    offset += line.length + 1; // +1 for the '\n' that .split removed
  }

  lines.forEach((line, i) => {
    const unitMatch = line.match(UNIT_HEADING_RE);
    if (unitMatch) {
      const label = `${capitalize(unitMatch[1])} ${unitMatch[2].toUpperCase()}`;
      const title = unitMatch[3]?.trim() ? `${label} - ${unitMatch[3].trim()}` : label;
      matches.push({ lineIndex: i, offset: lineOffsets[i], kind: "unit", title });
      return;
    }
    const topicMatch = line.match(TOPIC_HEADING_RE);
    if (topicMatch) {
      const title = (topicMatch[2] ?? topicMatch[3] ?? "").trim();
      if (title) matches.push({ lineIndex: i, offset: lineOffsets[i], kind: "topic", title });
    }
  });

  const unitMatches = matches.filter((m) => m.kind === "unit");

  if (unitMatches.length === 0) {
    // No confident unit structure. Still try to extract flat topics so the
    // faculty gets *some* scoping options rather than nothing, but mark the
    // whole thing as unconfident.
    const flatTopics = buildTopics(
      matches.filter((m) => m.kind === "topic"),
      lines,
      lineOffsets,
      0,
      text.length
    );

    const singleUnit: DetectedUnit = {
      name: "Full Syllabus",
      topics: flatTopics,
      startOffset: 0,
      endOffset: text.length,
    };

    return { units: [singleUnit], confident: false };
  }

  const units: DetectedUnit[] = [];
  for (let u = 0; u < unitMatches.length; u++) {
    const start = unitMatches[u];
    const end = unitMatches[u + 1];
    const startOffset = start.offset;
    const endOffset = end ? end.offset : text.length;

    if (endOffset - startOffset < MIN_UNIT_BODY_CHARS) continue; // heading with no real body

    const topicMatchesInUnit = matches.filter(
      (m) => m.kind === "topic" && m.offset >= startOffset && m.offset < endOffset
    );

    const topics = buildTopics(topicMatchesInUnit, lines, lineOffsets, startOffset, endOffset);

    units.push({ name: start.title, topics, startOffset, endOffset });
  }

  if (units.length === 0) {
    return {
      units: [{ name: "Full Syllabus", topics: [], startOffset: 0, endOffset: text.length }],
      confident: false,
    };
  }

  return { units, confident: true };
}

function buildTopics(
  topicMatches: { lineIndex: number; offset: number; title: string }[],
  lines: string[],
  lineOffsets: number[],
  rangeStart: number,
  rangeEnd: number
): DetectedTopic[] {
  if (topicMatches.length === 0) return [];

  const topics: DetectedTopic[] = [];
  for (let t = 0; t < topicMatches.length; t++) {
    const start = topicMatches[t];
    const end = topicMatches[t + 1];
    const startOffset = start.offset;
    const endOffset = end ? end.offset : rangeEnd;
    if (startOffset < rangeStart || startOffset >= rangeEnd) continue;

    // Collect bullet lines between this topic heading and the next as subtopics.
    const subtopics: string[] = [];
    let li = start.lineIndex + 1;
    while (li < lines.length && lineOffsets[li] < endOffset) {
      const bulletMatch = lines[li].match(SUBTOPIC_RE);
      if (bulletMatch) subtopics.push(bulletMatch[1].trim());
      li++;
    }

    topics.push({ name: start.title, subtopics, startOffset, endOffset });
  }
  return topics;
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}
