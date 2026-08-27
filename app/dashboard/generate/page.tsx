"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { SyllabusStep } from "@/components/syllabus/syllabus-step";
import { ConfigStep, type TestConfig } from "@/components/syllabus/config-step";
import { QuestionEditor, validateQuestions } from "@/components/questions/question-editor";
import { useToast } from "@/components/ui/toast";
import type { Question } from "@/types/question";

type Step = "syllabus" | "config" | "review";

const STEP_LABELS: Record<Step, string> = {
  syllabus: "1. Syllabus",
  config: "2. Configure",
  review: "3. Review & Publish",
};

export default function GeneratePage() {
  const [step, setStep] = useState<Step>("syllabus");
  const [syllabusText, setSyllabusText] = useState("");
  const [config, setConfig] = useState<TestConfig | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [generating, setGenerating] = useState(false);
  const [generatingLabel, setGeneratingLabel] = useState("Analyzing syllabus...");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const { toast } = useToast();

  async function handleConfigSubmit(nextConfig: TestConfig) {
    setError(null);
    setGenerating(true);
    setGeneratingLabel("Analyzing syllabus...");
    setConfig(nextConfig);
    const labelTimer = setTimeout(() => setGeneratingLabel("Generating questions..."), 1200);

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          syllabusText,
          testTitle: nextConfig.title,
          subject: nextConfig.subject,
          questionCount: nextConfig.questionCount,
          difficulty: nextConfig.difficulty,
        }),
      });
      const json = await res.json();

      if (!res.ok || !json.success) {
        throw new Error(json.error || "AI generation failed. Please try again.");
      }

      setQuestions(json.data.questions);
      setStep("review");
    } catch (err) {
      setError(err instanceof Error ? err.message : "AI generation failed. Please try again.");
    } finally {
      clearTimeout(labelTimer);
      setGenerating(false);
    }
  }

  async function handleSaveTest() {
    if (!config) return;
    const validationErrors = validateQuestions(questions);
    if (validationErrors.length > 0) {
      setError(validationErrors[0]);
      return;
    }

    setError(null);
    setSaving(true);

    try {
      const res = await fetch("/api/tests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: config.title,
          subject: config.subject,
          syllabusText,
          difficulty: config.difficulty,
          questions,
        }),
      });
      const json = await res.json();

      if (!res.ok || !json.success) {
        throw new Error(json.error || "Failed to save the test.");
      }

      toast("Test saved.");
      router.push(`/dashboard/tests/${json.data.test.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save the test.");
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-100">Generate Test</h1>
        <p className="text-sm text-slate-400">
          Upload a syllabus, configure the test, then review the AI-drafted questions.
        </p>
      </div>

      <div className="flex gap-4 text-xs text-slate-500">
        {(Object.keys(STEP_LABELS) as Step[]).map((s) => (
          <span key={s} className={s === step ? "text-indigo-400 font-medium" : ""}>
            {STEP_LABELS[s]}
          </span>
        ))}
      </div>

      {step === "syllabus" && (
        <Card>
          <SyllabusStep
            onExtracted={(text) => {
              setSyllabusText(text);
              setStep("config");
            }}
          />
        </Card>
      )}

      {step === "config" && (
        <Card>
          {error && <div className="mb-4"><ErrorState message={error} /></div>}
          <ConfigStep onSubmit={handleConfigSubmit} loading={generating} loadingLabel={generatingLabel} />
        </Card>
      )}

      {step === "review" && (
        <div className="flex flex-col gap-4">
          {error && <ErrorState message={error} />}
          <QuestionEditor questions={questions} onChange={setQuestions} />
          <div className="flex justify-end">
            <Button onClick={handleSaveTest} loading={saving}>
              Save Test
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
