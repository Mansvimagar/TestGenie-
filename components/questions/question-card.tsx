"use client";

import { Trash2 } from "lucide-react";
import type { Question } from "@/types/question";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";

export function QuestionCard({
  question,
  index,
  onChange,
  onDelete,
}: {
  question: Question;
  index: number;
  onChange: (next: Question) => void;
  onDelete: () => void;
}) {
  function updateOption(optionIndex: number, value: string) {
    const options = [...question.options] as Question["options"];
    options[optionIndex] = value;
    onChange({ ...question, options });
  }

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <span className="text-sm font-semibold text-slate-200">Question {index + 1}</span>
        <button
          onClick={onDelete}
          className="text-slate-500 hover:text-red-400"
          aria-label="Delete question"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>

      <div className="mb-3">
        <label className="mb-1 block text-xs font-medium text-slate-400">Topic</label>
        <Input
          value={question.topic}
          onChange={(e) => onChange({ ...question, topic: e.target.value })}
        />
      </div>

      <div className="mb-3">
        <label className="mb-1 block text-xs font-medium text-slate-400">Question</label>
        <Textarea
          rows={2}
          value={question.question}
          onChange={(e) => onChange({ ...question, question: e.target.value })}
        />
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium text-slate-400">
          Options (select the correct answer)
        </label>
        <div className="flex flex-col gap-2">
          {question.options.map((option, i) => (
            <label key={i} className="flex items-center gap-2">
              <input
                type="radio"
                name={`correct-${question.id}`}
                checked={question.correctAnswerIndex === i}
                onChange={() => onChange({ ...question, correctAnswerIndex: i as 0 | 1 | 2 | 3 })}
                className="h-4 w-4 accent-indigo-600"
              />
              <Input value={option} onChange={(e) => updateOption(i, e.target.value)} />
            </label>
          ))}
        </div>
      </div>
    </Card>
  );
}
