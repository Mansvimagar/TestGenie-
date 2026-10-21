"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Pencil, RefreshCw, X } from "lucide-react";
import type { Test } from "@/types/test";
import type { Question } from "@/types/question";
import { QuestionEditor, validateQuestions } from "@/components/questions/question-editor";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ErrorState } from "@/components/ui/error-state";
import { ConfirmDialog } from "@/components/ui/dialog";
import { CreateFormButton } from "@/components/forms/create-form-button";
import { useToast } from "@/components/ui/toast";

export function TestDetailView({
  test,
  initialQuestions,
}: {
  test: Test;
  initialQuestions: Question[];
}) {
  const [editing, setEditing] = useState(false);
  const [questions, setQuestions] = useState(initialQuestions);
  const [saving, setSaving] = useState(false);
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null);
  const [publishConfirmationOpen, setPublishConfirmationOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const { toast } = useToast();

  async function handleSave() {
    const errors = validateQuestions(questions);
    if (errors.length > 0) {
      setError(errors[0]);
      return;
    }
    setError(null);
    setSaving(true);

    const res = await fetch(`/api/tests/${test.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: test.title,
        subject: test.subject,
        difficulty: test.difficulty,
        questions,
      }),
    });

    const json = await res.json();
    setSaving(false);

    if (!res.ok || !json.success) {
      setError(json.error || "Failed to save changes.");
      return;
    }

    toast("Test updated.");
    setEditing(false);
    router.refresh();
  }

  async function handleRegenerate(questionId: string) {
    setError(null);
    setRegeneratingId(questionId);
    try {
      const response = await fetch(`/api/tests/${test.id}/questions/${questionId}/regenerate`, {
        method: "POST",
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.success) {
        throw new Error(result?.error || "Unable to regenerate this question.");
      }
      toast("Question regenerated. Review the replacement before publishing.");
      router.refresh();
    } catch (regenError) {
      setError(regenError instanceof Error ? regenError.message : "Unable to regenerate this question.");
    } finally {
      setRegeneratingId(null);
    }
  }

  async function handlePublish() {
    setPublishing(true);
    setError(null);
    try {
      const response = await fetch(`/api/tests/${test.id}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ facultyReviewConfirmed: true }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.success) {
        throw new Error(result?.error || "Unable to publish this test.");
      }
      setPublishConfirmationOpen(false);
      toast("Assessment published. You can now create its Google Form.");
      router.refresh();
    } catch (publishError) {
      setError(publishError instanceof Error ? publishError.message : "Unable to publish this test.");
    } finally {
      setPublishing(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {test.status === "published" ? (
          <CreateFormButton testId={test.id} initialFormUrl={test.google_form_url} />
        ) : (
          <Badge variant="muted">Draft — faculty review required</Badge>
        )}
        {test.status === "draft" && !editing && (
          <Button onClick={() => setPublishConfirmationOpen(true)} loading={publishing}>
            <Check className="h-4 w-4" />
            Publish Assessment
          </Button>
        )}
        {!editing ? (
          <Button variant="secondary" onClick={() => setEditing(true)} disabled={test.status !== "draft"}>
            <Pencil className="h-4 w-4" />
            Edit Test
          </Button>
        ) : (
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => {
              setEditing(false);
              setQuestions(initialQuestions);
              setError(null);
            }}>
              <X className="h-4 w-4" />
              Cancel
            </Button>
            <Button onClick={handleSave} loading={saving}>
              Save Changes
            </Button>
          </div>
        )}
      </div>

      {error && <ErrorState message={error} />}

      <ConfirmDialog
        open={publishConfirmationOpen}
        title="Publish this assessment?"
        description="Confirm that you have reviewed every question, answer, explanation, and any listed quality or evidence warnings. Publishing locks this assessment for editing."
        confirmLabel={publishing ? "Publishing..." : "I reviewed it — publish"}
        onConfirm={() => void handlePublish()}
        onCancel={() => setPublishConfirmationOpen(false)}
      />

      {editing ? (
        <QuestionEditor questions={questions} onChange={setQuestions} />
      ) : (
        <div className="flex flex-col gap-3">
          {questions.map((q, i) => (
            <div key={q.id} className="rounded-xl border border-slate-800 bg-slate-900 p-5">
              <p className="text-xs font-medium text-indigo-400">{q.topic}</p>
              <div className="flex items-start justify-between gap-3">
                <p className="mt-1 text-sm font-medium text-slate-100">
                  {i + 1}. {q.question}
                </p>
                {test.status === "draft" && test.syllabus_id && (
                  <Button
                    variant="ghost"
                    className="shrink-0 px-2 py-1 text-xs"
                    loading={regeneratingId === q.id}
                    disabled={regeneratingId !== null}
                    onClick={() => void handleRegenerate(q.id)}
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    Regenerate
                  </Button>
                )}
              </div>
              {q.explanation ? (
                <p className="mt-2 text-sm text-slate-300"><span className="font-medium">Explanation:</span> {q.explanation}</p>
              ) : (
                <p className="mt-2 text-xs text-amber-300">No explanation is stored for this older question yet.</p>
              )}
              {q.qualityIssues && q.qualityIssues.length > 0 && (
                <ul className="mt-2 list-disc pl-5 text-xs text-amber-300">
                  {q.qualityIssues.map((issue, issueIndex) => <li key={issueIndex}>{issue}</li>)}
                </ul>
              )}
              {q.supportAssessment && (
                <p className="mt-2 text-xs text-amber-300">
                  Faculty verification required. Automated support check: {q.supportAssessment}. {q.supportReviewNote}
                </p>
              )}
              {q.sourceEvidence && q.sourceEvidence.length > 0 && (
                <details className="mt-3 text-xs text-slate-300">
                  <summary className="cursor-pointer">Candidate source evidence (not independently verified)</summary>
                  {q.sourceEvidence.map((source) => (
                    <div key={source.chunkId} className="mt-2 border-l-2 border-indigo-500 pl-2">
                      <p className="text-indigo-300">{[source.unit, source.topic, source.pageStart ? `page ${source.pageStart}` : null].filter(Boolean).join(" · ")}</p>
                      <p className="mt-1 whitespace-pre-wrap">{source.content}</p>
                    </div>
                  ))}
                </details>
              )}
              <ul className="mt-3 flex flex-col gap-1.5">
                {q.options.map((o, oi) => (
                  <li
                    key={oi}
                    className={
                      oi === q.correctAnswerIndex
                        ? "text-sm text-emerald-400"
                        : "text-sm text-slate-400"
                    }
                  >
                    {oi === q.correctAnswerIndex ? "✓ " : "○ "}
                    {o}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
