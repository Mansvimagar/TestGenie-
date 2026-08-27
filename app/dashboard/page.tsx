import Link from "next/link";
import { FileText, CheckCircle2, Percent, ListChecks, Sparkles } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { StatCard } from "@/components/dashboard/stat-card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: tests } = await supabase
    .from("tests")
    .select("id, question_count, google_form_id")
    .eq("user_id", user!.id);

  const testIds = (tests ?? []).map((t) => t.id);

  const { data: scores } = testIds.length
    ? await supabase.from("scores").select("percentage").in("test_id", testIds)
    : { data: [] as { percentage: number }[] };

  const totalTests = tests?.length ?? 0;
  const publishedTests = (tests ?? []).filter((t) => t.google_form_id).length;
  const questionsGenerated = (tests ?? []).reduce((sum, t) => sum + t.question_count, 0);
  const averageScore =
    scores && scores.length > 0
      ? Math.round(scores.reduce((sum, s) => sum + Number(s.percentage), 0) / scores.length)
      : null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-100">Dashboard</h1>
          <p className="text-sm text-slate-400">Welcome back, {user?.email}</p>
        </div>
        <Link href="/dashboard/generate">
          <Button>
            <Sparkles className="h-4 w-4" />
            Generate Test
          </Button>
        </Link>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={FileText} label="Total Tests" value={totalTests} />
        <StatCard icon={CheckCircle2} label="Tests Published to Forms" value={publishedTests} />
        <StatCard
          icon={Percent}
          label="Average Score"
          value={averageScore !== null ? `${averageScore}%` : "--"}
        />
        <StatCard icon={ListChecks} label="Questions Generated" value={questionsGenerated} />
      </div>

      {totalTests === 0 && (
        <EmptyState
          icon={Sparkles}
          title="No tests yet"
          description="Upload a syllabus to generate your first AI-drafted test."
          action={
            <Link href="/dashboard/generate">
              <Button>Generate Test</Button>
            </Link>
          }
        />
      )}
    </div>
  );
}
