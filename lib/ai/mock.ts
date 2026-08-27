import "server-only";
import type { Difficulty, Question } from "@/types/question";

// Deterministic mock provider -- same Question shape as Gemini, so the UI can
// be built and tested with AI_PROVIDER=mock and no API key.
export function generateMockQuestions(params: {
  syllabusText: string;
  subject: string;
  questionCount: number;
  difficulty: Difficulty;
}): Question[] {
  const topics = extractTopics(params.syllabusText, params.subject);

  return Array.from({ length: params.questionCount }, (_, i) => {
    const topic = topics[i % topics.length];
    const correctAnswerIndex = (i % 4) as 0 | 1 | 2 | 3;
    const options: [string, string, string, string] = ["A", "B", "C", "D"].map(
      (label, idx) =>
        idx === correctAnswerIndex
          ? `${topic} -- correct concept (${params.difficulty})`
          : `${topic} -- distractor option ${label}`
    ) as [string, string, string, string];

    return {
      id: crypto.randomUUID(),
      topic,
      question: `[Mock] Which statement about "${topic}" is correct? (Q${i + 1})`,
      options,
      correctAnswerIndex,
    };
  });
}

function extractTopics(syllabusText: string, subject: string): string[] {
  const lines = syllabusText
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 3 && l.length < 80);

  const candidates = lines.slice(0, 20);
  return candidates.length > 0 ? candidates : [subject];
}
