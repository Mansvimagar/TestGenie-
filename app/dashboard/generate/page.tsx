"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { SyllabusStep } from "@/components/syllabus/syllabus-step";
import { ConfigStep, type TestConfig } from "@/components/syllabus/config-step";
import { QuestionEditor, validateQuestions } from "@/components/questions/question-editor";
import type { Question } from "@/types/question";
import type { SyllabusIngestionSummary } from "@/types/syllabus";
import type { GenerationConfig } from "@/types/generation";

type Step = "syllabus" | "config" | "review";

const STEP_LABELS: Record<Step, string> = {
  syllabus: "1. Syllabus",
  config: "2. Configure",
  review: "3. Review Questions",
};

export default function GeneratePage() {
  const [step, setStep] = useState<Step>("syllabus");
  const [ingestionResult, setIngestionResult] = useState<SyllabusIngestionSummary | null>(null);
  const [config, setConfig] = useState<TestConfig | null>(null);
  const [generationConfig, setGenerationConfig] = useState<GenerationConfig | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [generatingLabel, setGeneratingLabel] = useState("Retrieving syllabus context...");
  const [error, setError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const saveDraftInFlight = useRef(false);
  const router = useRouter();

  async function handleConfigSubmit(nextConfig: TestConfig) {
    if (!ingestionResult) {
      setError("Ingest a syllabus before generating questions.");
      return;
    }
    setError(null);
    setGenerating(true);
    setGeneratingLabel("Retrieving syllabus context...");
    setConfig(nextConfig);
    const nextGenerationConfig: GenerationConfig = {
      syllabusId: ingestionResult.syllabusId,
      title: nextConfig.title,
      subject: nextConfig.subject,
      questionCount: nextConfig.questionCount,
      difficulty: nextConfig.difficulty,
      unit: nextConfig.unit,
      topic: nextConfig.topic,
      questionType: "mcq",
    };
    setGenerationConfig(nextGenerationConfig);
    const labelTimer = setTimeout(() => setGeneratingLabel("Generating questions..."), 1200);

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          syllabusId: nextGenerationConfig.syllabusId,
          testTitle: nextConfig.title,
          subject: nextConfig.subject,
          questionCount: nextConfig.questionCount,
          difficulty: nextConfig.difficulty,
          unit: nextConfig.unit,
          topic: nextConfig.topic,
          questionType: "mcq",
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

  async function handleSaveDraft() {
    if (saveDraftInFlight.current) return;
    if (!generationConfig) {
      setError("Generation settings are unavailable. Return to configuration and try again.");
      return;
    }
    const validationErrors = validateQuestions(questions, true);
    if (validationErrors.length > 0) {
      setError(validationErrors[0]);
      return;
    }

    setError(null);
    setSaveMessage(null);
    saveDraftInFlight.current = true;
    setSaving(true);
    let saved = false;
    try {
      const response = await fetch("/api/tests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          syllabusId: generationConfig.syllabusId,
          generationConfig,
          questions: questions.map(({ topic, question, options, correctAnswerIndex, explanation }) => ({
            topic,
            question,
            options,
            correctAnswerIndex,
            explanation,
          })),
        }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.success || typeof result.data?.test?.id !== "string") {
        throw new Error(result?.error || "Unable to save draft. Please try again.");
      }

      saved = true;
      setSaveMessage("Draft saved. Opening the saved assessment...");
      router.push(`/dashboard/tests/${result.data.test.id}`);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to save draft. Please try again.");
    } finally {
      setSaving(false);
      if (!saved) saveDraftInFlight.current = false;
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-100">Generate Test</h1>
        <p className="text-sm text-slate-400">
          Upload a syllabus or paste its text to prepare questions from retrieved syllabus content.
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
          <SyllabusStep onIngested={(summary) => {
            setIngestionResult(summary);
            setStep("config");
            setError(null);
          }} />
        </Card>
      )}

      {step === "config" && (
        <Card>
          {error && <div className="mb-4"><ErrorState message={error} /></div>}
          {ingestionResult && (
            <ConfigStep
              outline={ingestionResult.outline}
              onSubmit={handleConfigSubmit}
              loading={generating}
              loadingLabel={generatingLabel}
            />
          )}
        </Card>
      )}

      {step === "review" && (
        <div className="flex flex-col gap-4">
          {error && <ErrorState message={error} />}
          {saveMessage && <p role="status" className="text-sm text-emerald-400">{saveMessage}</p>}
          <QuestionEditor questions={questions} onChange={setQuestions} />
          <div className="flex justify-end">
            <Button onClick={handleSaveDraft} loading={saving} disabled={!questions.length}>
              Save Draft
            </Button>
          </div>
          <p className="text-xs text-slate-500">
            Saving creates a private draft. Questions still require faculty review before publication.
            {config && generationConfig ? ` Configuration retained for “${config.title}”.` : ""}
          </p>
        </div>
      )}
    </div>
  );
}
