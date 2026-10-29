import type { forms_v1 } from "googleapis";
import { IDENTITY_FIELD_TITLES } from "./form-structure";
import { formatStudentIdentity } from "@/lib/scores/identity";

export class ResponseMappingError extends Error {}

export interface MappedScoreRow {
  google_response_id: string;
  student_name: string;
  student_email: string;
  score: number;
  total_questions: number;
  percentage: number;
  submitted_at: string;
}

export interface MappedResponses {
  rows: MappedScoreRow[];
  skipped: number;
}

/**
 * Converts Forms API responses into score rows. Graded vs identity items and the
 * identity answers are located by question ID taken from the form definition, not
 * by position or by the response's own text.
 */
export function mapFormResponses(
  form: forms_v1.Schema$Form,
  responses: forms_v1.Schema$FormResponse[],
  questionCount: number
): MappedResponses {
  const gradedIds: string[] = [];
  const identityIds = new Map<string, string>();
  for (const item of form.items ?? []) {
    const question = item.questionItem?.question;
    if (!question?.questionId) continue;
    if (question.grading?.pointValue !== undefined && question.grading?.pointValue !== null) {
      gradedIds.push(question.questionId);
    } else if (
      question.textQuestion &&
      (IDENTITY_FIELD_TITLES as readonly string[]).includes(item.title ?? "")
    ) {
      identityIds.set(item.title as string, question.questionId);
    }
  }
  if (gradedIds.length !== questionCount) {
    throw new ResponseMappingError(
      "The Google Form's graded question count does not match this published test."
    );
  }

  const textAnswer = (response: forms_v1.Schema$FormResponse, title: string) => {
    const id = identityIds.get(title);
    return id ? response.answers?.[id]?.textAnswers?.answers?.[0]?.value ?? "" : "";
  };

  const rows: MappedScoreRow[] = [];
  let skipped = 0;
  for (const response of responses) {
    const score = scoreOf(response, gradedIds);
    const submittedAt = response.lastSubmittedTime ?? response.createTime;
    if (!response.responseId || score === null || score < 0 || score > questionCount || !Number.isInteger(score)) {
      skipped += 1;
      continue;
    }
    const email = response.respondentEmail ?? "";
    rows.push({
      google_response_id: response.responseId,
      student_name: formatStudentIdentity({
        name: textAnswer(response, "Full Name") || email || "Google Forms respondent",
        rollNo: textAnswer(response, "Roll No"),
        className: textAnswer(response, "Class"),
        division: textAnswer(response, "Division"),
      }),
      student_email: email,
      score,
      total_questions: questionCount,
      percentage: Math.round((score / questionCount) * 10_000) / 100,
      submitted_at: submittedAt ?? new Date().toISOString(),
    });
  }
  return { rows, skipped };
}

function scoreOf(response: forms_v1.Schema$FormResponse, gradedIds: string[]): number | null {
  if (typeof response.totalScore === "number") return response.totalScore;
  let total = 0;
  for (const id of gradedIds) {
    const grade = response.answers?.[id]?.grade;
    if (!grade || typeof grade.score !== "number") return null;
    total += grade.score;
  }
  return total;
}
