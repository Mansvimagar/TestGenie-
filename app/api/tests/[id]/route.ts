import { ok, fail } from "@/lib/api-response";
import { createClient } from "@/lib/supabase/server";
import { saveTestSchema } from "@/lib/validation/schemas";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return fail("Unauthorized", 401);

  const { id } = await params;

  const { data: test, error: testError } = await supabase
    .from("tests")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (testError) return fail("Failed to load test.", 500);
  if (!test) return fail("Test not found.", 404);

  const { data: questions, error: questionsError } = await supabase
    .from("questions")
    .select("*")
    .eq("test_id", id)
    .order("position", { ascending: true });

  if (questionsError) return fail("Failed to load questions.", 500);

  return ok({ test, questions });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return fail("Unauthorized", 401);

  const { id } = await params;

  const body = await request.json().catch(() => null);
  const parsed = saveTestSchema.safeParse(body);
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? "Invalid request.", 422);
  }

  const { title, subject, difficulty, questions } = parsed.data;

  const { data: existing, error: fetchError } = await supabase
    .from("tests")
    .select("id, user_id")
    .eq("id", id)
    .maybeSingle();

  if (fetchError) return fail("Failed to load test.", 500);
  if (!existing) return fail("Test not found.", 404);
  if (existing.user_id !== user.id) return fail("Forbidden.", 403);

  const { error: updateError } = await supabase
    .from("tests")
    .update({ title, subject, difficulty, question_count: questions.length })
    .eq("id", id);

  if (updateError) return fail("Failed to update test.", 500);

  const { error: deleteError } = await supabase.from("questions").delete().eq("test_id", id);
  if (deleteError) return fail("Failed to update questions.", 500);

  const { error: insertError } = await supabase.from("questions").insert(
    questions.map((q, position) => ({
      test_id: id,
      topic: q.topic,
      question: q.question,
      options: q.options,
      correct_answer_index: q.correctAnswerIndex,
      position,
    }))
  );

  if (insertError) return fail("Failed to save questions.", 500);

  return ok({ updated: true });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return fail("Unauthorized", 401);

  const { id } = await params;

  const { error, count } = await supabase
    .from("tests")
    .delete({ count: "exact" })
    .eq("id", id);

  if (error) return fail("Failed to delete test.", 500);
  if (!count) return fail("Test not found.", 404);

  return ok({ deleted: true });
}
