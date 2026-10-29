import { NextRequest } from "next/server";
import { z } from "zod";
import { fail, ok } from "@/lib/api-response";
import { createClient } from "@/lib/supabase/server";
import { isGoogleConfigured } from "@/lib/google/auth";
import { addIdentityFieldsForUser, getIdentityFieldsState, GoogleFormsError } from "@/lib/google/forms";
import { IdentityFieldsError } from "@/lib/google/identity-fields";

const testIdSchema = z.string().uuid();

async function loadOwnedForm(testId: unknown) {
  const parsed = testIdSchema.safeParse(testId);
  if (!parsed.success) return { error: fail("Invalid request.", 422) };
  if (!isGoogleConfigured()) return { error: fail("Google Forms integration is not configured on this server.", 503) };

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: fail("Unauthorized", 401) };

  const { data: test, error } = await supabase
    .from("tests")
    .select("id, status, google_form_id")
    .eq("id", parsed.data)
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) return { error: fail("Failed to load test.", 500) };
  if (!test) return { error: fail("Test not found.", 404) };
  if (test.status !== "published" || !test.google_form_id) {
    return { error: fail("This test has no Google Form yet.", 409) };
  }
  return { userId: user.id, formId: test.google_form_id as string };
}

function googleFailure(err: unknown) {
  if (err instanceof IdentityFieldsError) return fail(err.message, 409);
  if (err instanceof GoogleFormsError) return fail(err.message, 422);
  return fail("Unable to update the Google Form. Please try again.", 500);
}

/** Reports whether the saved Form has the student detail fields, without changing anything. */
export async function GET(request: NextRequest) {
  const loaded = await loadOwnedForm(request.nextUrl.searchParams.get("testId"));
  if ("error" in loaded) return loaded.error;
  try {
    return ok({ state: await getIdentityFieldsState(loaded.userId, loaded.formId) });
  } catch (err) {
    return googleFailure(err);
  }
}

/** Adds the four student detail fields to an old Form that has none and no responses. */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const loaded = await loadOwnedForm((body as { testId?: unknown } | null)?.testId);
  if ("error" in loaded) return loaded.error;
  try {
    const result = await addIdentityFieldsForUser(loaded.userId, loaded.formId);
    return ok({ result });
  } catch (err) {
    return googleFailure(err);
  }
}
