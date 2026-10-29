import { NextRequest } from "next/server";
import { ok, fail, failWithData } from "@/lib/api-response";
import { createClient } from "@/lib/supabase/server";
import { createFormRequestSchema } from "@/lib/validation/schemas";
import { createGoogleForm, GoogleFormsError } from "@/lib/google/forms";
import { isGoogleConfigured } from "@/lib/google/auth";
import { questionSchema } from "@/lib/validation/schemas";
import { randomUUID } from "node:crypto";
import type { Question } from "@/types/question";

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return fail("Unauthorized", 401);

  const body = await request.json().catch(() => null);
  const parsed = createFormRequestSchema.safeParse(body);
  if (!parsed.success) return fail("Invalid request.", 422);

  if (!isGoogleConfigured()) {
    return fail("Google Forms integration is not configured on this server.", 503);
  }

  const { data: test, error: testError } = await supabase
    .from("tests")
    .select("id, user_id, title, subject, status, question_count, google_form_id, google_form_url")
    .eq("id", parsed.data.testId)
    .maybeSingle();

  if (testError) return fail("Failed to load test.", 500);
  if (!test) return fail("Test not found.", 404);
  if (test.user_id !== user.id) return fail("Forbidden.", 403);
  if (test.status !== "published") return fail("Only published tests can be exported to Google Forms.", 409);

  if (parsed.data.formId && test.google_form_id && parsed.data.formId !== test.google_form_id) {
    return fail("This test already has a different saved Google Form. The saved form was not changed.", 409);
  }
  if (!parsed.data.formId && test.google_form_id && test.google_form_url) {
    return ok({ formId: test.google_form_id, formUrl: test.google_form_url, reused: true });
  }

  const { data: questions, error: questionsError } = await supabase
    .from("questions")
    .select("*")
    .eq("test_id", test.id)
    .order("position", { ascending: true });

  if (questionsError || !questions || questions.length === 0) {
    return fail("This test has no questions to export.", 422);
  }
  if (questions.length !== test.question_count) {
    return fail("The saved question count does not match this published test. Review the database record before exporting.", 409);
  }

  const formQuestions: Question[] = [];
  for (const [index, row] of questions.entries()) {
    const question = questionSchema.safeParse({
      id: row.id,
      topic: row.topic,
      question: row.question,
      options: row.options,
      correctAnswerIndex: row.correct_answer_index,
    });
    if (!question.success) {
      return fail(`Saved question ${index + 1} is incomplete or invalid. Review it before exporting.`, 422);
    }
    const normalizedOptions = question.data.options.map((option) => option.trim().toLocaleLowerCase());
    if (normalizedOptions.some((option) => !option) || new Set(normalizedOptions).size !== 4) {
      return fail(`Saved question ${index + 1} has empty or repeated options. Review it before exporting.`, 422);
    }
    formQuestions.push({
      ...question.data,
      options: question.data.options as Question["options"],
      correctAnswerIndex: question.data.correctAnswerIndex as Question["correctAnswerIndex"],
    });
  }

  const leaseToken = randomUUID();
  const { data: claimData, error: claimError } = await supabase.rpc("claim_google_form_creation", {
    p_test_id: test.id,
    p_lease_token: leaseToken,
  });
  if (claimError) {
    if (claimError.code === "PGRST202" || claimError.code === "42883") {
      return fail("Google Form retry coordination is not configured. Apply the reviewed local database migration before creating forms.", 503);
    }
    return fail("Unable to reserve this test for Google Form creation. Please retry.", 503);
  }
  const claim = claimData as { acquired?: boolean; formId?: string | null } | null;
  if (!claim?.acquired) {
    return fail("Google Form creation is already in progress for this test. Wait a moment and refresh.", 409);
  }

  const { data: latestTest, error: latestTestError } = await supabase
    .from("tests")
    .select("id, user_id, status, google_form_id, google_form_url")
    .eq("id", test.id)
    .eq("user_id", user.id)
    .maybeSingle();

  if (latestTestError || !latestTest || latestTest.status !== "published") {
    await supabase.rpc("release_google_form_creation", {
      p_test_id: test.id,
      p_lease_token: leaseToken,
      p_keep_for_recovery: false,
    });
    return fail("Unable to reserve this test for Google Form creation. Please retry.", 503);
  }

  if (parsed.data.formId && latestTest.google_form_id && parsed.data.formId !== latestTest.google_form_id) {
    await supabase.rpc("release_google_form_creation", {
      p_test_id: test.id,
      p_lease_token: leaseToken,
      p_keep_for_recovery: false,
    });
    return fail("This test already has a different saved Google Form. The saved form was not changed.", 409);
  }

  if (!parsed.data.formId && latestTest.google_form_id && latestTest.google_form_url) {
    await supabase.rpc("release_google_form_creation", {
      p_test_id: test.id,
      p_lease_token: leaseToken,
      p_keep_for_recovery: false,
    });
    return ok({ formId: latestTest.google_form_id, formUrl: latestTest.google_form_url, reused: true });
  }

  const recoveryFormId = parsed.data.formId ?? latestTest.google_form_id ?? claim.formId ?? undefined;
  let createdFormId: string | undefined = recoveryFormId;
  if (recoveryFormId && recoveryFormId !== claim.formId) {
    const { data: recorded, error: recordError } = await supabase.rpc("record_google_form_creation_form", {
      p_test_id: test.id,
      p_lease_token: leaseToken,
      p_form_id: recoveryFormId,
    });
    if (recordError || recorded !== true) {
      await supabase.rpc("release_google_form_creation", {
        p_test_id: test.id,
        p_lease_token: leaseToken,
        p_keep_for_recovery: false,
      });
      return fail("Unable to reserve the existing Google Form for recovery. Please retry.", 503);
    }
  }

  try {
    const { formId, formUrl } = await createGoogleForm({
      userId: user.id,
      title: test.title,
      subject: test.subject,
      existingFormId: recoveryFormId,
      questions: formQuestions,
      onFormCreated: async (createdId) => {
        createdFormId = createdId;
        const { data: recorded, error: recordError } = await supabase.rpc("record_google_form_creation_form", {
          p_test_id: test.id,
          p_lease_token: leaseToken,
          p_form_id: createdId,
        });
        if (recordError || recorded !== true) {
          throw new GoogleFormsError("The Google Form exists, but its recovery reference could not be recorded.", createdId);
        }
      },
    });
    createdFormId = formId;

    const { data: associatedTest, error: updateError } = await supabase
      .from("tests")
      .update({ google_form_id: formId, google_form_url: formUrl })
      .eq("id", test.id)
      .eq("user_id", user.id)
      .eq("status", "published")
      .select("id")
      .maybeSingle();

    if (updateError || !associatedTest) {
      await supabase.rpc("release_google_form_creation", {
        p_test_id: test.id,
        p_lease_token: leaseToken,
        p_keep_for_recovery: true,
      });
      return failWithData(
        "The Google Form exists, but its reference could not be saved. Use the recovery action below; do not create another form.",
        { formId, formUrl, recoveryRequired: true },
        500
      );
    }

    await supabase.rpc("release_google_form_creation", {
      p_test_id: test.id,
      p_lease_token: leaseToken,
      p_keep_for_recovery: false,
    });
    return ok({ formId, formUrl, reused: Boolean(recoveryFormId) });
  } catch (err) {
    if (err instanceof GoogleFormsError && err.formId) createdFormId = err.formId;
    await supabase.rpc("release_google_form_creation", {
      p_test_id: test.id,
      p_lease_token: leaseToken,
      p_keep_for_recovery: Boolean(createdFormId),
    });
    if (err instanceof GoogleFormsError) {
      return err.formId
        ? failWithData(err.message, { formId: err.formId, recoveryRequired: err.recoveryRequired }, 422)
        : fail(err.message, 422);
    }
    return fail("Unable to create Google Form.", 500);
  }
}
