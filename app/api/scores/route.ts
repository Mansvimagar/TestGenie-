import { NextRequest } from "next/server";
import { ok, fail } from "@/lib/api-response";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return fail("Unauthorized", 401);

  const testId = request.nextUrl.searchParams.get("testId");

  let query = supabase
    .from("scores")
    .select("*, tests!inner(id, title, user_id)")
    .eq("tests.user_id", user.id)
    .order("submitted_at", { ascending: false });

  if (testId) query = query.eq("test_id", testId);

  const { data, error } = await query;
  if (error) return fail("Failed to load scores.", 500);

  const scores = (data ?? []).map((row) => ({
    id: row.id,
    test_id: row.test_id,
    student_name: row.student_name,
    student_email: row.student_email,
    score: row.score,
    total_questions: row.total_questions,
    percentage: row.percentage,
    submitted_at: row.submitted_at,
    test_title: (row.tests as unknown as { title: string }).title,
  }));

  return ok({ scores });
}
