import { Inbox } from "lucide-react";
import { Table, Thead, Th, Td } from "@/components/ui/table";
import { EmptyState } from "@/components/ui/empty-state";
import { toResultRows, type ScoreLike } from "@/lib/scores/results";

export function ResponsesTable({ scores }: { scores: ScoreLike[] }) {
  const rows = toResultRows(scores);
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold text-slate-100">Responses ({rows.length})</h2>
      {rows.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="No responses yet"
          description="After students submit the Google Form, click Sync scores to load their responses here."
        />
      ) : (
        <Table>
          <Thead>
            <tr>
              <Th>Name</Th>
              <Th>Roll No</Th>
              <Th>Class</Th>
              <Th>Division</Th>
              <Th>Score / Total</Th>
              <Th>Submitted at</Th>
            </tr>
          </Thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <Td>{r.name}</Td>
                <Td>{r.rollNo || "-"}</Td>
                <Td>{r.className || "-"}</Td>
                <Td>{r.division || "-"}</Td>
                <Td>{r.score} / {r.total}</Td>
                <Td>{new Date(r.submittedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </section>
  );
}
