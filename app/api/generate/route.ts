import { NextRequest } from "next/server";
import { ok, fail } from "@/lib/api-response";
import { createClient } from "@/lib/supabase/server";
import { generateRequestSchema } from "@/lib/validation/schemas";
import { generateQuestions, GenerationError } from "@/lib/ai/gemini";

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return fail("Unauthorized", 401);

  const body = await request.json().catch(() => null);
  const parsed = generateRequestSchema.safeParse(body);
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? "Invalid request.", 422);
  }

  try {
    const questions = await generateQuestions({
      syllabusText: parsed.data.syllabusText,
      subject: parsed.data.subject,
      questionCount: parsed.data.questionCount,
      difficulty: parsed.data.difficulty,
    });
    return ok({ questions });
  } catch (err) {
    if (err instanceof GenerationError) return fail(err.message, 422);
    return fail("AI generation failed. Please try again.", 500);
  }
}
