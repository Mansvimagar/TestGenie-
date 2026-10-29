"use client";

import { useState } from "react";
import type { Difficulty } from "@/types/question";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import type { SyllabusOutline } from "@/types/syllabus";

export interface TestConfig {
  title: string;
  subject: string;
  questionCount: number;
  difficulty: Difficulty;
  unit: string | null;
  topic: string | null;
  allowPartial?: boolean;
}

export function ConfigStep({
  outline,
  onSubmit,
  loading,
  loadingLabel,
}: {
  outline: SyllabusOutline;
  onSubmit: (config: TestConfig) => void;
  loading: boolean;
  loadingLabel?: string;
}) {
  const [title, setTitle] = useState("");
  const [subject, setSubject] = useState("");
  const [questionCount, setQuestionCount] = useState(10);
  const [difficulty, setDifficulty] = useState<Difficulty>("medium");
  const [unit, setUnit] = useState<string | null>(null);
  const [topic, setTopic] = useState<string | null>(null);
  const [allowPartial, setAllowPartial] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedUnit = outline.units.find((entry) => entry.name === unit);
  const topicOptions = selectedUnit?.topics ??
    (!outline.structureConfident ? outline.units.flatMap((entry) => entry.topics) : []);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !subject.trim()) {
      setError("Title and subject are required.");
      return;
    }
    if (questionCount < 1 || questionCount > 50) {
      setError("Question count must be between 1 and 50.");
      return;
    }
    setError(null);
    onSubmit({
      title: title.trim(),
      subject: subject.trim(),
      questionCount,
      difficulty,
      unit,
      topic,
      allowPartial,
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      {error && <ErrorState message={error} />}

      <div>
        <label className="mb-1 block text-xs font-medium text-slate-400">Test Title</label>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Unit 1 Quiz" />
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium text-slate-400">Subject</label>
        <Input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="Data Structures"
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-400">Number of Questions</label>
          <Input
            type="number"
            min={1}
            max={50}
            value={questionCount}
            onChange={(e) => setQuestionCount(Number(e.target.value))}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-400">Difficulty</label>
          <Select value={difficulty} onChange={(e) => setDifficulty(e.target.value as Difficulty)}>
            <option value="easy">Easy</option>
            <option value="medium">Medium</option>
            <option value="hard">Hard</option>
            <option value="mixed">Mixed</option>
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-400">Syllabus Unit</label>
          <Select
            value={unit ?? ""}
            onChange={(e) => {
              setUnit(e.target.value || null);
              setTopic(null);
            }}
          >
            <option value="">Entire syllabus</option>
            {outline.structureConfident && outline.units.map((entry) => (
              <option key={entry.name} value={entry.name}>{entry.name}</option>
            ))}
          </Select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-400">Topic</label>
          <Select
            value={topic ?? ""}
            disabled={topicOptions.length === 0}
            onChange={(e) => setTopic(e.target.value || null)}
          >
            <option value="">All topics</option>
            {topicOptions.map((entry) => (
              <option key={`${entry.name}-${entry.subtopics.join("|")}`} value={entry.name}>
                {entry.name}
              </option>
            ))}
          </Select>
        </div>
      </div>
      {!outline.structureConfident && (
        <p className="text-xs text-amber-300">
          Unit headings were not confidently detected. Topic filters, when available, apply across the syllabus.
        </p>
      )}

      <div>
        <label className="mb-1 block text-xs font-medium text-slate-400">Question Type</label>
        <Input value="Multiple Choice" disabled className="opacity-60" />
      </div>

      <label className="flex items-center gap-2 text-xs text-slate-400">
        <input type="checkbox" checked={allowPartial} onChange={(e) => setAllowPartial(e.target.checked)} />
        Allow partial results if some questions cannot be generated
      </label>

      <Button type="submit" loading={loading} className="self-start">
        {loading ? loadingLabel || "Generating..." : "Generate Questions"}
      </Button>
    </form>
  );
}
