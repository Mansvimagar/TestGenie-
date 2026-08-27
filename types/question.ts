export interface Question {
  id: string;
  topic: string;
  question: string;
  options: [string, string, string, string];
  correctAnswerIndex: 0 | 1 | 2 | 3;
}

export type Difficulty = "easy" | "medium" | "hard" | "mixed";
