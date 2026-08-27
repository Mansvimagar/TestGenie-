import type { Difficulty } from "@/types/question";

export function buildGenerationPrompt(params: {
  syllabusText: string;
  subject: string;
  questionCount: number;
  difficulty: Difficulty;
}): string {
  const { syllabusText, subject, questionCount, difficulty } = params;

  return `You are an academic assessment generator for a college-level "${subject}" course.

Generate exactly ${questionCount} multiple-choice questions ONLY from the supplied syllabus text below.
Do not invent topics that are unrelated to the syllabus.

Rules:
- Each question must have exactly four answer options.
- There must be exactly one correct answer per question, given as a 0-based index into "options".
- Distractors (wrong options) must be plausible, not obviously wrong.
- Avoid ambiguous wording -- each question must have a single unambiguous correct answer.
- Do not generate duplicate or near-duplicate questions.
- Requested difficulty: "${difficulty}". ${difficultyInstruction(difficulty)}
- Assign a short topic label (e.g. a unit or concept name from the syllabus) to every question.
- Return only structured JSON matching the supplied schema. Do not include commentary.

Syllabus:
"""
${syllabusText}
"""`;
}

function difficultyInstruction(difficulty: Difficulty): string {
  switch (difficulty) {
    case "easy":
      return "Favor direct recall of definitions and facts stated in the syllabus.";
    case "medium":
      return "Favor understanding and application of concepts, not just recall.";
    case "hard":
      return "Favor analysis, comparison, and multi-step reasoning across concepts.";
    case "mixed":
      return "Distribute questions across easy, medium, and hard difficulty roughly evenly.";
  }
}
