import { parseStudentIdentity } from "./identity";

export interface ScoreLike {
  id: string;
  student_name: string;
  student_email: string;
  score: number;
  total_questions: number;
  percentage: number;
  submitted_at: string;
}

export interface ResultRow {
  id: string;
  name: string;
  email: string;
  rollNo: string;
  className: string;
  division: string;
  score: number;
  total: number;
  percentage: number;
  submittedAt: string;
}

/** Newest first; identity parsed from the stored "Name | Roll X | Class Y | Div Z" string. */
export function toResultRows(scores: ScoreLike[]): ResultRow[] {
  return scores
    .map((s) => {
      const who = parseStudentIdentity(s.student_name);
      return {
        id: s.id,
        name: who.name,
        email: s.student_email,
        rollNo: who.rollNo,
        className: who.className,
        division: who.division,
        score: Number(s.score),
        total: Number(s.total_questions),
        percentage: Number(s.percentage),
        submittedAt: s.submitted_at,
      };
    })
    .sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime());
}

export function summarizeResults(rows: Pick<ResultRow, "score" | "total" | "percentage">[]) {
  const count = rows.length;
  if (count === 0) return { count, averageScore: 0, averagePercentage: 0, total: 0 };
  const totals = new Set(rows.map((r) => r.total));
  return {
    count,
    averageScore: Math.round((rows.reduce((sum, r) => sum + r.score, 0) / count) * 10) / 10,
    averagePercentage: Math.round(rows.reduce((sum, r) => sum + r.percentage, 0) / count),
    // Only meaningful as "x / total" when every row shares one total.
    total: totals.size === 1 ? rows[0].total : 0,
  };
}

// Spreadsheet apps execute cells that start with these characters; prefix them.
function csvCell(value: string | number): string {
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function buildResultsCsv(rows: ResultRow[]): string {
  const header = ["Name", "Roll No", "Class", "Division", "Email", "Score", "Total", "Percentage", "Submitted at"];
  const lines = rows.map((r) =>
    [r.name, r.rollNo, r.className, r.division, r.email, r.score, r.total, r.percentage, r.submittedAt]
      .map(csvCell)
      .join(",")
  );
  return [header.join(","), ...lines].join("\r\n") + "\r\n";
}

export function csvFilename(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return `${slug || "test"}-results.csv`;
}
