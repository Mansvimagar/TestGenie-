import type { Question } from "@/types/question";
import type { RetrievedChunk } from "@/types/generation";

const STOP_WORDS = new Set([
  "a", "an", "the", "in", "on", "at", "to", "of", "by", "is", "it", "as", "or", "if", "be", "do",
  "we", "he", "so", "up", "no", "my", "me", "all", "and", "any", "but", "can", "day", "did", "for",
  "get", "had", "has", "her", "him", "his", "how", "its", "let", "may", "new", "not", "now", "off",
  "old", "one", "our", "out", "own", "say", "see", "she", "too", "two", "use", "way", "who", "why",
  "yes", "yet", "about", "after", "again", "among", "also", "are", "because", "been", "being",
  "between", "could", "does", "from", "have", "into", "more", "most", "only", "other", "should",
  "some", "than", "that", "their", "there", "these", "they", "this", "those", "through", "under",
  "using", "what", "when", "where", "which", "while", "with", "would", "your", "true", "false",
]);

interface QuestionQualityMetadata {
  sourceChunkIds: string[];
  groundingStatus: "needs_review";
  validationStatus: "unique" | "duplicate";
  qualityIssues: string[];
  validationMetadata: Record<string, unknown>;
}

export interface QuestionQualityResult {
  questions: Question[];
  metadata: QuestionQualityMetadata[];
}

/**
 * Links questions only to chunks actually supplied by retrieval. Token overlap
 * is a candidate-evidence signal, not an entailment or factuality proof.
 */
export function assessQuestionQuality(
  input: Question[],
  chunks: RetrievedChunk[]
): QuestionQualityResult {
  const metadata: QuestionQualityMetadata[] = input.map((question) => {
    const questionTerms = terms(question.question);
    const answerTerms = terms(question.options[question.correctAnswerIndex] ?? "");
    const explanationTerms = terms(question.explanation ?? "");
    const matches = chunks
      .map((chunk) => {
        const chunkTerms = terms(chunk.content);
        const questionOverlap = intersectionSize(questionTerms, chunkTerms);
        const answerOverlap = intersectionSize(answerTerms, chunkTerms);
        const explanationOverlap = intersectionSize(explanationTerms, chunkTerms);
        const effectiveAnswerOverlap = answerTerms.size > 0 ? answerOverlap : explanationOverlap;
        const score = questionOverlap + effectiveAnswerOverlap * 2;
        return { chunk, questionOverlap, answerOverlap: effectiveAnswerOverlap, score };
      })
      .filter((match) => match.questionOverlap >= Math.min(2, questionTerms.size) && match.answerOverlap > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    const issues: string[] = [];
    const normalizedOptions = question.options.map(normalize);
    if (!question.topic.trim()) issues.push("Topic is missing.");
    if (!question.question.trim()) issues.push("Question text is missing.");
    if (question.options.length !== 4 || question.options.some((option) => !option.trim())) {
      issues.push("Question must have four non-empty answer options.");
    }
    if (!Number.isInteger(question.correctAnswerIndex) || question.correctAnswerIndex < 0 || question.correctAnswerIndex > 3) {
      issues.push("Correct-answer index is invalid.");
    }
    if (new Set(normalizedOptions).size !== 4) issues.push("Answer options contain duplicates.");
    if (!question.explanation?.trim()) issues.push("Add an explanation for the correct answer.");
    if (matches.length === 0) {
      issues.push("No retrieved text matched both the question and keyed answer; verify or rewrite this item.");
    }

    return {
      sourceChunkIds: matches.map(({ chunk }) => chunk.chunkId),
      groundingStatus: "needs_review" as const,
      validationStatus: "unique" as const,
      qualityIssues: issues,
      validationMetadata: {
        evidenceMatchMethod: "lexical_overlap_candidate_only",
        candidateMatchCount: matches.length,
        facultyVerificationRequired: true,
      },
    };
  });

  const duplicateIndexes = new Set<number>();
  for (let i = 0; i < input.length; i++) {
    for (let j = i + 1; j < input.length; j++) {
      const similarity = jaccard(terms(input[i].question), terms(input[j].question));
      if (normalize(input[i].question) === normalize(input[j].question) || similarity >= 0.82) {
        duplicateIndexes.add(i);
        duplicateIndexes.add(j);
        metadata[i].qualityIssues.push(`Near-duplicate of question ${j + 1}.`);
        metadata[j].qualityIssues.push(`Near-duplicate of question ${i + 1}.`);
      }
    }
  }

  for (const index of duplicateIndexes) metadata[index].validationStatus = "duplicate";

  return {
    metadata,
    questions: input.map((question, index) => ({ ...question, ...metadata[index] })),
  };
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

function terms(value: string): Set<string> {
  return new Set(
    normalize(value)
      .split(" ")
      .filter((term) => term.length >= 2 && !STOP_WORDS.has(term))
  );
}

function intersectionSize(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const term of a) if (b.has(term)) count++;
  return count;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const overlap = intersectionSize(a, b);
  return overlap / (a.size + b.size - overlap);
}
