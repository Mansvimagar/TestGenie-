import { NextRequest } from "next/server";
import { fail, ok } from "@/lib/api-response";
import { assessQuestionQuality } from "@/lib/validation/question-quality";
import { publishTestRequestSchema, questionSchema } from "@/lib/validation/schemas";
import { createClient } from "@/lib/supabase/server";
import type { Question } from "@/types/question";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail("Unauthorized", 401);

  const body = await request.json().catch(() => null);
  const parsed = publishTestRequestSchema.safeParse(body);
  if (!parsed.success) return fail("Confirm faculty review before publishing.", 422);

  const { id } = await params;
  const { data: test, error: testError } = await supabase
    .from("tests")
    .select("id, user_id, status")
    .eq("id", id)
    .maybeSingle();

  if (testError) return fail("Failed to load test.", 500);
  if (!test) return fail("Test not found.", 404);
  if (test.user_id !== user.id) return fail("Forbidden.", 403);
  if (test.status !== "draft") return fail("Only draft tests can be published.", 409);

  const { data: rows, error: questionsError } = await supabase
    .from("questions")
    .select("id, topic, question, options, correct_answer_index, explanation")
    .eq("test_id", id)
    .order("position", { ascending: true });

  if (questionsError) return fail("Failed to load questions for review.", 500);
  if (!rows?.length) return fail("Add at least one question before publishing.", 422);

  const questions: Question[] = [];
  for (const row of rows) {
    const parsedQuestion = questionSchema.safeParse({
      id: row.id,
      topic: row.topic,
      question: row.question,
      options: row.options,
      correctAnswerIndex: row.correct_answer_index,
      explanation: row.explanation ?? undefined,
    });
    if (!parsedQuestion.success) {
      return fail("One or more saved questions are incomplete or invalid.", 422);
    }
    questions.push(parsedQuestion.data as Question);
  }

  const quality = assessQuestionQuality(questions, []);
  const blockingIssues = quality.questions.flatMap((question, index) =>
    (question.qualityIssues ?? [])
      .filter((issue) => !issue.startsWith("No retrieved text matched"))
      .map((issue) => `Question ${index + 1}: ${issue}`)
  );
  if (blockingIssues.length > 0) {
    return fail(`Resolve question issues before publishing: ${blockingIssues.slice(0, 3).join(" ")}`, 422);
  }

  const { error: publishError } = await supabase.rpc("publish_test", { p_test_id: id });
  if (publishError) {
    if (publishError.code === "PGRST202" || publishError.code === "42883") {
      return fail("Publishing is not configured yet. Apply the pending database migration and retry.", 503);
    }
    return fail("Unable to publish this test. Refresh it and review its status and questions.", 409);
  }

  return ok({ published: true });
}
