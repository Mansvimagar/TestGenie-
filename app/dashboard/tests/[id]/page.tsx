import { notFound } from "next/navigation";
import Link from "next/link";
import { BarChart3 } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";
import { ResponsesTable } from "@/components/scores/responses-table";
import { TestDetailView } from "@/components/tests/test-detail-view";
import type { Question } from "@/types/question";

export default async function TestDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  const { data: test } = await supabase.from("tests").select("*").eq("id", id).maybeSingle();
  if (!test || !user || test.user_id !== user.id) notFound();

  const { data: questionRows } = await supabase
    .from("questions")
    .select("*")
    .eq("test_id", id)
    .order("position", { ascending: true });

  const sourceIds = [...new Set((questionRows ?? []).flatMap((q) =>
    stringIds(q.source_chunk_ids)
  ))];
  const { data: evidenceRows } = test.syllabus_id && sourceIds.length > 0
    ? await supabase
        .from("syllabus_chunks")
        .select("id, unit, topic, content, page_start, page_end")
        .eq("syllabus_id", test.syllabus_id)
        .in("id", sourceIds)
    : { data: [] };
  const evidenceById = new Map((evidenceRows ?? []).map((chunk) => [chunk.id, chunk]));

  const questions: Question[] = (questionRows ?? []).map((q) => {
    const metadata = q.validation_metadata && typeof q.validation_metadata === "object"
      ? q.validation_metadata as Record<string, unknown>
      : {};
    const ids = stringIds(q.source_chunk_ids);
    return {
    id: q.id,
    topic: q.topic,
    question: q.question,
    options: q.options,
    correctAnswerIndex: q.correct_answer_index,
    explanation: q.explanation ?? undefined,
    sourceChunkIds: q.source_chunk_ids,
    groundingStatus: q.grounding_status,
    validationStatus: q.validation_status,
    qualityIssues: Array.isArray(metadata.qualityIssues)
      ? metadata.qualityIssues.filter((issue): issue is string => typeof issue === "string")
      : [],
    supportAssessment: metadata.supportAssessment === "supported"
      || metadata.supportAssessment === "unsupported"
      || metadata.supportAssessment === "uncertain"
      ? metadata.supportAssessment
      : undefined,
    supportReviewNote: typeof metadata.supportReviewNote === "string" ? metadata.supportReviewNote : undefined,
    validationMetadata: metadata,
    sourceEvidence: ids.flatMap((chunkId) => {
      const chunk = evidenceById.get(chunkId);
      return chunk ? [{
        chunkId,
        unit: chunk.unit,
        topic: chunk.topic,
        pageStart: chunk.page_start,
        pageEnd: chunk.page_end,
        content: chunk.content,
      }] : [];
    }),
  };
  });

  const config = test.generation_config as Record<string, unknown> | null;
  const scope = [config?.unit, config?.topic].filter(
    (value): value is string => typeof value === "string" && value.length > 0
  );

  const { data: scoreRows } = await supabase
    .from("scores")
    .select("id, student_name, student_email, score, total_questions, percentage, submitted_at")
    .eq("test_id", id)
    .order("submitted_at", { ascending: false });
  const scoreCount = scoreRows?.length ?? 0;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold text-slate-100">{test.title}</h1>
          <Badge className="capitalize">{test.difficulty}</Badge>
          <Badge variant={test.status === "published" ? "success" : "muted"} className="capitalize">
            {test.status}
          </Badge>
        </div>
        <p className="mt-1 text-sm text-slate-400">
          {test.subject} &middot; {questions.length} questions &middot; created {formatDate(test.created_at)}
        </p>
        {scope.length > 0 && (
          <p className="mt-1 text-xs text-slate-500">Scope: {scope.join(" / ")}</p>
        )}
        <Link
          href={`/dashboard/scores?testId=${test.id}`}
          className="mt-2 inline-flex items-center gap-1.5 text-sm text-indigo-400 hover:underline"
        >
          <BarChart3 className="h-3.5 w-3.5" />
          View {scoreCount} score{scoreCount === 1 ? "" : "s"} for this test
        </Link>
      </div>

      <TestDetailView test={test} initialQuestions={questions} />

      {test.status === "published" && <ResponsesTable scores={scoreRows ?? []} />}
    </div>
  );
}

function stringIds(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((id: unknown): id is string => typeof id === "string")
    : [];
}
