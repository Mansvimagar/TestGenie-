import type { Difficulty } from "./question";

export type TestStatus = "draft" | "published";

export interface Test {
  id: string;
  user_id: string;
  title: string;
  subject: string;
  /** Legacy compatibility column; RAG drafts are linked through syllabus_id. */
  syllabus_text: string;
  difficulty: Difficulty;
  question_count: number;
  google_form_id: string | null;
  google_form_url: string | null;
  status: TestStatus;
  syllabus_id?: string | null;
  generation_config?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}
