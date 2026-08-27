"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import type { ScoreWithTest } from "@/types/score";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Table, Thead, Th, Td } from "@/components/ui/table";
import { StatCard } from "@/components/dashboard/stat-card";
import { EmptyState } from "@/components/ui/empty-state";
import { BarChart3, TrendingUp, TrendingDown, Users } from "lucide-react";
import { formatDate } from "@/lib/utils";

type SortKey = "submitted_at" | "percentage" | "student_name";

export function ScoresTable({
  scores,
  initialTestFilter,
}: {
  scores: ScoreWithTest[];
  initialTestFilter?: string;
}) {
  const [search, setSearch] = useState("");
  const [testFilter, setTestFilter] = useState(initialTestFilter || "all");
  const [sortKey, setSortKey] = useState<SortKey>("submitted_at");

  const testOptions = useMemo(() => {
    const map = new Map<string, string>();
    scores.forEach((s) => map.set(s.test_id, s.test_title));
    return Array.from(map.entries());
  }, [scores]);

  const filtered = useMemo(() => {
    let result = scores;
    if (testFilter !== "all") result = result.filter((s) => s.test_id === testFilter);
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (s) =>
          s.student_name.toLowerCase().includes(q) || s.student_email.toLowerCase().includes(q)
      );
    }
    return [...result].sort((a, b) => {
      if (sortKey === "percentage") return b.percentage - a.percentage;
      if (sortKey === "student_name") return a.student_name.localeCompare(b.student_name);
      return new Date(b.submitted_at).getTime() - new Date(a.submitted_at).getTime();
    });
  }, [scores, search, testFilter, sortKey]);

  const totalSubmissions = scores.length;
  const average =
    totalSubmissions > 0
      ? Math.round(scores.reduce((sum, s) => sum + Number(s.percentage), 0) / totalSubmissions)
      : 0;
  const highest = totalSubmissions > 0 ? Math.max(...scores.map((s) => Number(s.percentage))) : 0;
  const lowest = totalSubmissions > 0 ? Math.min(...scores.map((s) => Number(s.percentage))) : 0;

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={Users} label="Total Submissions" value={totalSubmissions} />
        <StatCard icon={BarChart3} label="Average Score" value={`${average}%`} />
        <StatCard icon={TrendingUp} label="Highest Score" value={`${highest}%`} />
        <StatCard icon={TrendingDown} label="Lowest Score" value={`${lowest}%`} />
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
          <Input
            className="pl-9"
            placeholder="Search by student name or email"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Select value={testFilter} onChange={(e) => setTestFilter(e.target.value)} className="sm:w-56">
          <option value="all">All tests</option>
          {testOptions.map(([id, title]) => (
            <option key={id} value={id}>
              {title}
            </option>
          ))}
        </Select>
        <Select value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)} className="sm:w-48">
          <option value="submitted_at">Sort by date</option>
          <option value="percentage">Sort by score</option>
          <option value="student_name">Sort by name</option>
        </Select>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={BarChart3}
          title="No scores yet"
          description="Scores appear here once students submit responses on a published Google Form."
        />
      ) : (
        <Table>
          <Thead>
            <tr>
              <Th>Student</Th>
              <Th>Test</Th>
              <Th>Score</Th>
              <Th>Percentage</Th>
              <Th>Submitted</Th>
            </tr>
          </Thead>
          <tbody>
            {filtered.map((s) => (
              <tr key={s.id}>
                <Td>
                  <div className="font-medium text-slate-100">{s.student_name}</div>
                  <div className="text-xs text-slate-500">{s.student_email}</div>
                </Td>
                <Td>{s.test_title}</Td>
                <Td>
                  {s.score} / {s.total_questions}
                </Td>
                <Td>{Number(s.percentage).toFixed(0)}%</Td>
                <Td>{formatDate(s.submitted_at)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
