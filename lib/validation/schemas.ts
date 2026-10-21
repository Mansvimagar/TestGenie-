import { z } from "zod";

export const questionSchema = z.object({
  id: z.string(),
  topic: z.string().min(1, "Topic is required"),
  question: z.string().min(1, "Question text is required"),
  options: z
    .array(z.string().min(1, "Options cannot be empty"))
    .length(4, "Exactly 4 options are required"),
  correctAnswerIndex: z.number().int().min(0).max(3),
  explanation: z.string().trim().min(1, "Explanation is required").optional(),
  // Additive/optional -- present when generation went through the RAG
  // pipeline (lib/ai/gemini.ts#generateGroundedQuestions), absent for
  // legacy/mock/manual-paste-without-a-stored-syllabus questions.
  sourceChunkIds: z.array(z.string()).optional(),
  groundingStatus: z.enum(["grounded", "needs_review", "unsupported", "not_applicable"]).optional(),
  validationStatus: z.enum(["unique", "duplicate", "not_applicable"]).optional(),
});

export const questionsArraySchema = z.array(questionSchema).min(1);
export const groundedQuestionSchema = questionSchema.extend({
  explanation: z.string().trim().min(1, "Explanation is required"),
});
export const groundedQuestionsArraySchema = z.array(groundedQuestionSchema).min(1);
export const supportAssessmentSchema = z.object({
  assessments: z.array(z.object({
    questionIndex: z.number().int().min(0),
    verdict: z.enum(["supported", "unsupported", "uncertain"]),
    note: z.string().trim().max(300),
  }).strict()),
}).strict();

export const difficultySchema = z.enum(["easy", "medium", "hard", "mixed"]);

// Legacy shape retained for existing consumers; the active /api/generate
// route accepts grounded requests only.
export const legacyGenerateRequestSchema = z.object({
  syllabusText: z.string().min(50, "Syllabus text is too short to generate reliable questions"),
  testTitle: z.string().min(1),
  subject: z.string().min(1),
  questionCount: z.number().int().min(1).max(50),
  difficulty: difficultySchema,
});

// New shape: scoped RAG generation against a previously ingested syllabus.
export const groundedGenerateRequestSchema = z.object({
  syllabusId: z.string().uuid(),
  testTitle: z.string().trim().min(1),
  subject: z.string().trim().min(1),
  questionCount: z.number().int().min(1).max(50),
  difficulty: difficultySchema,
  unit: z.string().trim().min(1).nullable().optional(),
  topic: z.string().trim().min(1).nullable().optional(),
  additionalInstructions: z.string().trim().max(1000).optional(),
  questionType: z.literal("mcq").optional(),
}).strict();

// Retained for compatibility with existing consumers. The active
// /api/generate route intentionally parses grounded requests only.
export const generateRequestSchema = z.union([
  groundedGenerateRequestSchema,
  legacyGenerateRequestSchema,
]);

export type GroundedGenerateRequest = z.infer<typeof groundedGenerateRequestSchema>;
export type LegacyGenerateRequest = z.infer<typeof legacyGenerateRequestSchema>;

export const saveTestSchema = z.object({
  title: z.string().min(1),
  subject: z.string().min(1),
  syllabusText: z.string().min(1),
  difficulty: difficultySchema,
  questions: questionsArraySchema,
  // Optional/additive: present when the test was generated via the RAG
  // pipeline, so it can be persisted on tests.syllabus_id /
  // tests.generation_config (migration 004) and reused later for
  // single-question regeneration (POST /api/questions/[id]/regenerate).
  syllabusId: z.string().uuid().optional(),
  generationConfig: z.record(z.string(), z.unknown()).optional(),
});

const draftQuestionSchema = z.object({
  topic: z.string().trim().min(1, "Topic is required"),
  question: z.string().trim().min(1, "Question text is required"),
  options: z.array(z.string().trim().min(1, "Options cannot be empty")).length(4),
  correctAnswerIndex: z.number().int().min(0).max(3),
  explanation: z.string().trim().min(1, "Explanation is required"),
}).strict();

export const draftGenerationConfigSchema = z.object({
  syllabusId: z.string().uuid(),
  title: z.string().trim().min(1),
  subject: z.string().trim().min(1),
  questionCount: z.number().int().min(1).max(50),
  difficulty: difficultySchema,
  unit: z.string().nullable().optional(),
  topic: z.string().nullable().optional(),
  subtopic: z.string().nullable().optional(),
  includedTopics: z.array(z.string()).optional(),
  excludedTopics: z.array(z.string()).optional(),
  additionalInstructions: z.string().max(1000).optional(),
  questionType: z.literal("mcq").optional(),
}).strict();

export const createDraftTestSchema = z.object({
  syllabusId: z.string().uuid(),
  generationConfig: draftGenerationConfigSchema,
  questions: z.array(draftQuestionSchema).min(1).max(50),
}).strict().superRefine((value, context) => {
  if (value.syllabusId !== value.generationConfig.syllabusId) {
    context.addIssue({ code: "custom", message: "Syllabus ID does not match generation configuration." });
  }
  if (value.questions.length > value.generationConfig.questionCount) {
    context.addIssue({ code: "custom", message: "Question count exceeds the generation configuration." });
  }
});

export const updateTestSchema = z.object({
  title: z.string().min(1),
  subject: z.string().min(1),
  difficulty: difficultySchema,
  questions: questionsArraySchema,
});

export const createFormRequestSchema = z.object({
  testId: z.string().uuid(),
});

export const publishTestRequestSchema = z.object({
  facultyReviewConfirmed: z.literal(true),
}).strict();

// POST /api/syllabus with a JSON body (manual paste) instead of multipart
// form data (PDF upload). See app/api/syllabus/route.ts.
export const ingestManualSyllabusSchema = z.object({
  name: z.string().min(1).max(200).default("Pasted syllabus"),
  text: z.string().trim().min(50, "Paste at least a few sentences of syllabus content.")
    .max(500_000, "Syllabus text must be 500,000 characters or fewer."),
}).strict();

