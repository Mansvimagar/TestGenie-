import { createClient } from "@/lib/supabase/server";
import { ScoresTable } from "@/components/scores/scores-table";
import type { ScoreWithTest } from "@/types/score";

export default async function ScoresPage({
  searchParams,
}: {
  searchParams: Promise<{ testId?: string }>;
}) {
  const { testId } = await searchParams;
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("scores")
    .select("*, tests!inner(title)")
    .order("submitted_at", { ascending: false });

  const scores: ScoreWithTest[] = (data ?? []).map((row) => ({
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

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-100">Scores</h1>
        <p className="text-sm text-slate-400">Results from students who submitted your Google Forms.</p>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-rose-300">
          Scores could not be loaded. Refresh the page or try again later.
        </p>
      ) : (
        <ScoresTable scores={scores} initialTestFilter={testId} />
      )}
    </div>
  );
}
