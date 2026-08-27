import { notFound } from "next/navigation";
import Link from "next/link";
import { BarChart3 } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";
import { TestDetailView } from "@/components/tests/test-detail-view";
import type { Question } from "@/types/question";

export default async function TestDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: test } = await supabase.from("tests").select("*").eq("id", id).maybeSingle();
  if (!test) notFound();

  const { data: questionRows } = await supabase
    .from("questions")
    .select("*")
    .eq("test_id", id)
    .order("position", { ascending: true });

  const questions: Question[] = (questionRows ?? []).map((q) => ({
    id: q.id,
    topic: q.topic,
    question: q.question,
    options: q.options,
    correctAnswerIndex: q.correct_answer_index,
  }));

  const { count: scoreCount } = await supabase
    .from("scores")
    .select("id", { count: "exact", head: true })
    .eq("test_id", id);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold text-slate-100">{test.title}</h1>
          <Badge className="capitalize">{test.difficulty}</Badge>
        </div>
        <p className="mt-1 text-sm text-slate-400">
          {test.subject} &middot; {questions.length} questions &middot; created {formatDate(test.created_at)}
        </p>
        <Link
          href={`/dashboard/scores?testId=${test.id}`}
          className="mt-2 inline-flex items-center gap-1.5 text-sm text-indigo-400 hover:underline"
        >
          <BarChart3 className="h-3.5 w-3.5" />
          View {scoreCount ?? 0} score{scoreCount === 1 ? "" : "s"} for this test
        </Link>
      </div>

      <TestDetailView test={test} initialQuestions={questions} />
    </div>
  );
}
