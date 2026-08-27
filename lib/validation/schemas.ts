import { z } from "zod";

export const questionSchema = z.object({
  id: z.string(),
  topic: z.string().min(1, "Topic is required"),
  question: z.string().min(1, "Question text is required"),
  options: z
    .array(z.string().min(1, "Options cannot be empty"))
    .length(4, "Exactly 4 options are required"),
  correctAnswerIndex: z.number().int().min(0).max(3),
});

export const questionsArraySchema = z.array(questionSchema).min(1);

export const difficultySchema = z.enum(["easy", "medium", "hard", "mixed"]);

export const generateRequestSchema = z.object({
  syllabusText: z.string().min(50, "Syllabus text is too short to generate reliable questions"),
  testTitle: z.string().min(1),
  subject: z.string().min(1),
  questionCount: z.number().int().min(1).max(50),
  difficulty: difficultySchema,
});

export const saveTestSchema = z.object({
  title: z.string().min(1),
  subject: z.string().min(1),
  syllabusText: z.string().min(1),
  difficulty: difficultySchema,
  questions: questionsArraySchema,
});

export const createFormRequestSchema = z.object({
  testId: z.string().uuid(),
});
