import { NextRequest } from "next/server";
import { ok, fail } from "@/lib/api-response";
import { createClient } from "@/lib/supabase/server";
import { saveTestSchema } from "@/lib/validation/schemas";

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return fail("Unauthorized", 401);

  const { data, error } = await supabase
    .from("tests")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) return fail("Failed to load tests.", 500);
  return ok({ tests: data });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return fail("Unauthorized", 401);

  const body = await request.json().catch(() => null);
  const parsed = saveTestSchema.safeParse(body);
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? "Invalid request.", 422);
  }

  const { title, subject, syllabusText, difficulty, questions } = parsed.data;

  const { data: test, error: testError } = await supabase
    .from("tests")
    .insert({
      user_id: user.id,
      title,
      subject,
      syllabus_text: syllabusText,
      difficulty,
      question_count: questions.length,
      status: "published",
    })
    .select()
    .single();

  if (testError || !test) {
    return fail("Failed to save the test.", 500);
  }

  const { error: questionsError } = await supabase.from("questions").insert(
    questions.map((q, position) => ({
      test_id: test.id,
      topic: q.topic,
      question: q.question,
      options: q.options,
      correct_answer_index: q.correctAnswerIndex,
      position,
    }))
  );

  if (questionsError) {
    await supabase.from("tests").delete().eq("id", test.id);
    return fail("Failed to save questions.", 500);
  }

  return ok({ test }, 201);
}
