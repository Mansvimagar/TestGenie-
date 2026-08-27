import Link from "next/link";
import { FileText, Sparkles } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { Table, Thead, Th, Td } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { TestRowActions } from "@/components/tests/test-row-actions";
import { formatDate } from "@/lib/utils";

export default async function TestsPage() {
  const supabase = await createClient();
  const { data: tests } = await supabase
    .from("tests")
    .select("*")
    .order("created_at", { ascending: false });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-100">My Tests</h1>
          <p className="text-sm text-slate-400">Every test you have generated.</p>
        </div>
        <Link href="/dashboard/generate">
          <Button>
            <Sparkles className="h-4 w-4" />
            Generate Test
          </Button>
        </Link>
      </div>

      {!tests || tests.length === 0 ? (
        <EmptyState
          icon={FileText}
          title="No tests yet"
          description="Generate your first test from a syllabus to see it here."
          action={
            <Link href="/dashboard/generate">
              <Button>Generate Test</Button>
            </Link>
          }
        />
      ) : (
        <Table>
          <Thead>
            <tr>
              <Th>Title</Th>
              <Th>Subject</Th>
              <Th>Questions</Th>
              <Th>Difficulty</Th>
              <Th>Created</Th>
              <Th>Google Form</Th>
              <Th>Actions</Th>
            </tr>
          </Thead>
          <tbody>
            {tests.map((t) => (
              <tr key={t.id}>
                <Td>
                  <Link href={`/dashboard/tests/${t.id}`} className="font-medium text-slate-100 hover:underline">
                    {t.title}
                  </Link>
                </Td>
                <Td>{t.subject}</Td>
                <Td>{t.question_count}</Td>
                <Td className="capitalize">{t.difficulty}</Td>
                <Td>{formatDate(t.created_at)}</Td>
                <Td>
                  {t.google_form_url ? (
                    <Badge variant="success">Created</Badge>
                  ) : (
                    <Badge variant="muted">Not created</Badge>
                  )}
                </Td>
                <Td>
                  <TestRowActions testId={t.id} googleFormUrl={t.google_form_url} />
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
