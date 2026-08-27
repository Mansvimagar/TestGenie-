import "server-only";
import { GoogleGenAI } from "@google/genai";
import type { Difficulty, Question } from "@/types/question";
import { questionsArraySchema } from "@/lib/validation/schemas";
import { buildGenerationPrompt } from "./prompts";
import { GEMINI_RESPONSE_SCHEMA } from "./schema";
import { generateMockQuestions } from "./mock";

export class GenerationError extends Error {}

interface GenerateParams {
  syllabusText: string;
  subject: string;
  questionCount: number;
  difficulty: Difficulty;
}

export async function generateQuestions(params: GenerateParams): Promise<Question[]> {
  if (process.env.AI_PROVIDER === "mock") {
    return generateMockQuestions(params);
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new GenerationError(
      "GEMINI_API_KEY is not configured. Set AI_PROVIDER=mock for local development without a key."
    );
  }

  const model = process.env.GEMINI_MODEL || "gemini-2.0-flash";
  const client = new GoogleGenAI({ apiKey });
  const prompt = buildGenerationPrompt(params);

  // One retry: if Gemini returns JSON that fails our Zod validation (missing
  // field, wrong option count, out-of-range index), ask once more before
  // giving up -- we never forward unvalidated output to the client.
  for (let attempt = 0; attempt < 2; attempt++) {
    let raw: string;
    try {
      const response = await client.models.generateContent({
        model,
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: GEMINI_RESPONSE_SCHEMA,
          temperature: 0.4,
        },
      });
      raw = response.text ?? "";
    } catch (err) {
      throw new GenerationError(
        err instanceof Error ? `Gemini request failed: ${err.message}` : "Gemini request failed."
      );
    }

    const parsed = tryParse(raw);
    if (!parsed) continue;

    const withIds = (parsed.questions ?? []).map((q) => ({
      ...(q as Record<string, unknown>),
      id: crypto.randomUUID(),
    }));

    const result = questionsArraySchema.safeParse(withIds);
    if (result.success && result.data.length === params.questionCount) {
      return result.data as Question[];
    }
  }

  throw new GenerationError(
    "The AI did not return a valid set of questions after two attempts. Please try again."
  );
}

function tryParse(raw: string): { questions?: unknown[] } | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
