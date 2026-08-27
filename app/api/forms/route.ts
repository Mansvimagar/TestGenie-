import { NextRequest } from "next/server";
import { ok, fail } from "@/lib/api-response";
import { createClient } from "@/lib/supabase/server";
import { createFormRequestSchema } from "@/lib/validation/schemas";
import { createGoogleForm, GoogleFormsError } from "@/lib/google/forms";
import { isGoogleConfigured } from "@/lib/google/auth";

export async function POST(request: NextRequest) {
  if (!isGoogleConfigured()) {
    return fail("Google Forms integration is not connected on this server.", 422);
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return fail("Unauthorized", 401);

  const body = await request.json().catch(() => null);
  const parsed = createFormRequestSchema.safeParse(body);
  if (!parsed.success) return fail("Invalid request.", 422);

  const { data: test, error: testError } = await supabase
    .from("tests")
    .select("*")
    .eq("id", parsed.data.testId)
    .maybeSingle();

  if (testError) return fail("Failed to load test.", 500);
  if (!test) return fail("Test not found.", 404);
  if (test.user_id !== user.id) return fail("Forbidden.", 403);

  const { data: questions, error: questionsError } = await supabase
    .from("questions")
    .select("*")
    .eq("test_id", test.id)
    .order("position", { ascending: true });

  if (questionsError || !questions || questions.length === 0) {
    return fail("This test has no questions to export.", 422);
  }

  try {
    const { formId, formUrl } = await createGoogleForm({
      userId: user.id,
      title: test.title,
      subject: test.subject,
      questions: questions.map((q) => ({
        id: q.id,
        topic: q.topic,
        question: q.question,
        options: q.options,
        correctAnswerIndex: q.correct_answer_index,
      })),
    });

    const { error: updateError } = await supabase
      .from("tests")
      .update({ google_form_id: formId, google_form_url: formUrl })
      .eq("id", test.id);

    if (updateError) {
      return fail(
        "The Google Form was created, but saving its URL failed. Refresh and try again.",
        500
      );
    }

    return ok({ formId, formUrl });
  } catch (err) {
    if (err instanceof GoogleFormsError) return fail(err.message, 422);
    return fail("Unable to create Google Form.", 500);
  }
}
