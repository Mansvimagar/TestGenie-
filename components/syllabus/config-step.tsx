"use client";

import { useState } from "react";
import type { Difficulty } from "@/types/question";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";

export interface TestConfig {
  title: string;
  subject: string;
  questionCount: number;
  difficulty: Difficulty;
}

export function ConfigStep({
  onSubmit,
  loading,
  loadingLabel,
}: {
  onSubmit: (config: TestConfig) => void;
  loading: boolean;
  loadingLabel?: string;
}) {
  const [title, setTitle] = useState("");
  const [subject, setSubject] = useState("");
  const [questionCount, setQuestionCount] = useState(10);
  const [difficulty, setDifficulty] = useState<Difficulty>("medium");
  const [error, setError] = useState<string | null>(null);

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
    onSubmit({ title: title.trim(), subject: subject.trim(), questionCount, difficulty });
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

      <div>
        <label className="mb-1 block text-xs font-medium text-slate-400">Question Type</label>
        <Input value="Multiple Choice" disabled className="opacity-60" />
      </div>

      <Button type="submit" loading={loading} className="self-start">
        {loading ? loadingLabel || "Generating..." : "Generate Questions"}
      </Button>
    </form>
  );
}
