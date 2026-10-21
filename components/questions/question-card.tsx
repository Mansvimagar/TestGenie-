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

      <div className="mb-3">
        <label className="mb-1 block text-xs font-medium text-slate-400">Why is the correct answer correct?</label>
        <Textarea
          rows={2}
          value={question.explanation ?? ""}
          onChange={(e) => onChange({ ...question, explanation: e.target.value })}
          placeholder="Explanation (legacy questions may not have one yet)"
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

      {(question.groundingStatus === "needs_review" || (question.qualityIssues?.length ?? 0) > 0) && (
        <div className="mt-4 rounded-lg border border-amber-700/50 bg-amber-950/20 p-3 text-xs text-amber-200" role="status">
          <p className="font-medium">Faculty review required</p>
          {question.supportAssessment && (
            <p className="mt-1">Automated support check: {question.supportAssessment}. {question.supportReviewNote}</p>
          )}
          {question.qualityIssues && question.qualityIssues.length > 0 && (
            <ul className="mt-1 list-disc pl-4">
              {question.qualityIssues.map((issue, issueIndex) => <li key={issueIndex}>{issue}</li>)}
            </ul>
          )}
        </div>
      )}
      {question.sourceEvidence && question.sourceEvidence.length > 0 && (
        <details className="mt-3 rounded-lg border border-slate-700 p-3 text-xs text-slate-300">
          <summary className="cursor-pointer font-medium">Candidate source evidence (not independently verified)</summary>
          <div className="mt-2 flex flex-col gap-2">
            {question.sourceEvidence.map((source) => (
              <div key={source.chunkId} className="border-l-2 border-indigo-500 pl-2">
                <p className="text-indigo-300">
                  {[source.unit, source.topic, source.pageStart ? `page ${source.pageStart}` : null].filter(Boolean).join(" · ") || "Syllabus passage"}
                </p>
                <p className="mt-1 whitespace-pre-wrap">{source.content}</p>
              </div>
            ))}
          </div>
        </details>
      )}
    </Card>
  );
}
