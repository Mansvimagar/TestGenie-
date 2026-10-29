"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Copy, Eye, ExternalLink, Trash2 } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { copyToClipboard } from "@/lib/copy-to-clipboard";

export function TestRowActions({
  testId,
  googleFormUrl,
}: {
  testId: string;
  googleFormUrl: string | null;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [manualLink, setManualLink] = useState<string | null>(null);
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
    <div className="flex flex-wrap items-center gap-3">
      <Link href={`/dashboard/tests/${testId}`} className="text-slate-400 hover:text-slate-100" title="View">
        <Eye className="h-4 w-4" />
      </Link>
      {googleFormUrl && (
        <button
          onClick={async () => {
            const copied = await copyToClipboard(googleFormUrl);
            setManualLink(copied ? null : googleFormUrl);
            if (copied) toast("Student link copied.");
            else toast("Could not copy automatically. Copy the link shown below.", "error");
          }}
          className="flex items-center gap-1 text-sm text-slate-400 hover:text-slate-100"
          title="Copy student link"
        >
          <Copy className="h-4 w-4" /> Copy link
        </button>
      )}
      {googleFormUrl && (
        <a
          href={googleFormUrl}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1 text-sm text-slate-400 hover:text-slate-100"
          title="Open student Google Form"
        >
          <ExternalLink className="h-4 w-4" /> Open
        </a>
      )}
      <button
        onClick={() => setConfirmOpen(true)}
        className="text-slate-400 hover:text-red-400"
        title="Delete"
      >
        <Trash2 className="h-4 w-4" />
      </button>

      {manualLink && (
        <input
          readOnly
          autoFocus
          value={manualLink}
          onFocus={(event) => event.currentTarget.select()}
          aria-label="Student link"
          className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200"
        />
      )}

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
