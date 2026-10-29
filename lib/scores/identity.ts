export interface StudentIdentity {
  name: string;
  rollNo: string;
  className: string;
  division: string;
}

// Without a DB change the identity travels in scores.student_name as
// "Name | Roll X | Class Y | Div Z"; these helpers are the only writer/reader.
const clean = (value: string | undefined, max: number) =>
  (value ?? "").replace(/\|/g, "/").replace(/\s+/g, " ").trim().slice(0, max);

export function formatStudentIdentity(input: {
  name?: string;
  rollNo?: string;
  className?: string;
  division?: string;
}): string {
  const name = clean(input.name, 80);
  const rollNo = clean(input.rollNo, 30);
  const className = clean(input.className, 30);
  const division = clean(input.division, 30);
  if (!rollNo && !className && !division) return name;
  return `${name} | Roll ${rollNo} | Class ${className} | Div ${division}`;
}

export function parseStudentIdentity(studentName: string): StudentIdentity {
  const match = /^(.*?) \| Roll (.*?) \| Class (.*?) \| Div (.*)$/.exec(studentName);
  if (!match) return { name: studentName, rollNo: "", className: "", division: "" };
  return { name: match[1], rollNo: match[2], className: match[3], division: match[4] };
}
