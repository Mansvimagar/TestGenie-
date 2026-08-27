"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Pencil, X } from "lucide-react";
import type { Test } from "@/types/test";
import type { Question } from "@/types/question";
import { QuestionEditor, validateQuestions } from "@/components/questions/question-editor";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
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
        syllabusText: test.syllabus_text,
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

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <CreateFormButton testId={test.id} initialFormUrl={test.google_form_url} />
        {!editing ? (
          <Button variant="secondary" onClick={() => setEditing(true)}>
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

      {editing ? (
        <QuestionEditor questions={questions} onChange={setQuestions} />
      ) : (
        <div className="flex flex-col gap-3">
          {questions.map((q, i) => (
            <div key={q.id} className="rounded-xl border border-slate-800 bg-slate-900 p-5">
              <p className="text-xs font-medium text-indigo-400">{q.topic}</p>
              <p className="mt-1 text-sm font-medium text-slate-100">
                {i + 1}. {q.question}
              </p>
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
