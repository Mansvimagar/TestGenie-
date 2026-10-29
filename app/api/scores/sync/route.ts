import { NextRequest } from "next/server";
import { z } from "zod";
import { fail, failWithData, ok } from "@/lib/api-response";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { fetchFormScores, GoogleResponsesError } from "@/lib/google/responses";
import { isGoogleConfigured } from "@/lib/google/auth";

const syncRequestSchema = z.object({ testId: z.string().uuid() }).strict();
const UPSERT_BATCH = 200;
const RECONNECT_CODES = new Set(["not_connected", "scope_missing", "token_expired"]);

/** Pulls responses for the signed-in faculty member's published test straight from Google Forms. */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail("Unauthorized", 401);

  const parsed = syncRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail("Invalid request.", 422);
  if (!isGoogleConfigured()) return fail("Google Forms integration is not configured on this server.", 503);

  const { data: test, error: testError } = await supabase
    .from("tests")
    .select("id, user_id, status, question_count, google_form_id")
    .eq("id", parsed.data.testId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (testError) return fail("Failed to load test.", 500);
  if (!test) return fail("Test not found.", 404);
  if (test.status !== "published" || !test.google_form_id) {
    return fail("Create the Google Form for this published test before syncing scores.", 409);
  }

  let mapped;
  try {
    mapped = await fetchFormScores({
      userId: user.id,
      formId: test.google_form_id,
      questionCount: test.question_count,
    });
  } catch (err) {
    if (err instanceof GoogleResponsesError) {
      console.error("Score sync failed", { code: err.code, testId: test.id });
      const status = RECONNECT_CODES.has(err.code) ? 409 : err.code === "form_unavailable" ? 422 : 502;
      return failWithData(err.message, { reconnectRequired: RECONNECT_CODES.has(err.code) }, status);
    }
    console.error("Score sync failed", { code: "unexpected", testId: test.id });
    return fail("Unable to sync scores. Please try again.", 500);
  }

  // Service role writes mirror the webhook; ownership of the test was verified above.
  const admin = createServiceRoleClient();
  for (let start = 0; start < mapped.rows.length; start += UPSERT_BATCH) {
    const batch = mapped.rows.slice(start, start + UPSERT_BATCH).map((row) => ({ ...row, test_id: test.id }));
    const { error } = await admin.from("scores").upsert(batch, { onConflict: "test_id,google_response_id" });
    if (error) {
      if (error.code === "42703" || error.code === "42P10") {
        return fail("Score ingestion schema is not ready. Apply the reviewed score idempotency migration first.", 503);
      }
      return fail("Unable to save the synced scores.", 500);
    }
  }

  return ok({ synced: mapped.rows.length, skipped: mapped.skipped });
}
