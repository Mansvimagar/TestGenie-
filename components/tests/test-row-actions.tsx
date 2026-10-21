"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Eye, ExternalLink, Trash2 } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";

export function TestRowActions({
  testId,
  googleFormUrl,
}: {
  testId: string;
  googleFormUrl: string | null;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const router = useRouter();
  const { toast } = useToast();

  async function handleDelete() {
    setDeleting(true);
    const res = await fetch(`/api/tests/${testId}`, { method: "DELETE" });
    setDeleting(false);
    setConfirmOpen(false);

    if (!res.ok) {
      toast("Failed to delete test.", "error");
      return;
    }
    toast("Test deleted.");
    router.refresh();
  }

  return (
    <div className="flex items-center gap-3">
      <Link href={`/dashboard/tests/${testId}`} className="text-slate-400 hover:text-slate-100" title="View">
        <Eye className="h-4 w-4" />
      </Link>
      {googleFormUrl && (
        <a
          href={googleFormUrl}
          target="_blank"
          rel="noreferrer"
          className="text-slate-400 hover:text-slate-100"
          title="Open Google Form"
        >
          <ExternalLink className="h-4 w-4" />
        </a>
      )}
      <button
        onClick={() => setConfirmOpen(true)}
        className="text-slate-400 hover:text-red-400"
        title="Delete"
      >
        <Trash2 className="h-4 w-4" />
      </button>

      <ConfirmDialog
        open={confirmOpen}
        title="Delete this test?"
        description="This permanently removes the test, its questions, and its scores from TestGenie. The Google Form itself is not deleted."
        confirmLabel={deleting ? "Deleting..." : "Delete"}
        onConfirm={handleDelete}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}
