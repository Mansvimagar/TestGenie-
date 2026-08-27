export interface Score {
  id: string;
  test_id: string;
  student_name: string;
  student_email: string;
  score: number;
  total_questions: number;
  percentage: number;
  submitted_at: string;
}

export interface ScoreWithTest extends Score {
  test_title: string;
}
