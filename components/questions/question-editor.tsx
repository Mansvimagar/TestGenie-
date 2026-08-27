"use client";

import { Plus } from "lucide-react";
import type { Question } from "@/types/question";
import { QuestionCard } from "./question-card";
import { Button } from "@/components/ui/button";

export function validateQuestions(questions: Question[]): string[] {
  const errors: string[] = [];
  if (questions.length === 0) errors.push("Add at least one question.");

  questions.forEach((q, i) => {
    if (!q.question.trim()) errors.push(`Question ${i + 1}: question text cannot be empty.`);
    if (q.options.length !== 4) errors.push(`Question ${i + 1}: must have exactly 4 options.`);
    if (q.options.some((o) => !o.trim())) errors.push(`Question ${i + 1}: options cannot be empty.`);
    if (q.correctAnswerIndex < 0 || q.correctAnswerIndex > 3)
      errors.push(`Question ${i + 1}: select a correct answer.`);
  });

  return errors;
}

export function QuestionEditor({
  questions,
  onChange,
}: {
  questions: Question[];
  onChange: (next: Question[]) => void;
}) {
  function updateQuestion(index: number, next: Question) {
    const copy = [...questions];
    copy[index] = next;
    onChange(copy);
  }

  function deleteQuestion(index: number) {
    onChange(questions.filter((_, i) => i !== index));
  }

  function addQuestion() {
    onChange([
      ...questions,
      {
        id: crypto.randomUUID(),
        topic: "",
        question: "",
        options: ["", "", "", ""],
        correctAnswerIndex: 0,
      },
    ]);
  }

  return (
    <div className="flex flex-col gap-4">
      {questions.map((q, i) => (
        <QuestionCard
          key={q.id}
          question={q}
          index={i}
          onChange={(next) => updateQuestion(i, next)}
          onDelete={() => deleteQuestion(i)}
        />
      ))}
      <Button variant="secondary" onClick={addQuestion} className="self-start">
        <Plus className="h-4 w-4" />
        Add Question
      </Button>
    </div>
  );
}
