import type { Difficulty } from "./question";

export type TestStatus = "draft" | "published";

export interface Test {
  id: string;
  user_id: string;
  title: string;
  subject: string;
  syllabus_text: string;
  difficulty: Difficulty;
  question_count: number;
  google_form_id: string | null;
  google_form_url: string | null;
  status: TestStatus;
  created_at: string;
  updated_at: string;
}
