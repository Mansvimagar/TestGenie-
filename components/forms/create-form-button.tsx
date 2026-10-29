"use client";

import { useRef, useState } from "react";
import { Copy, ExternalLink, FileSpreadsheet, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { useToast } from "@/components/ui/toast";
import { copyToClipboard } from "@/lib/copy-to-clipboard";

export function CreateFormButton({
  testId,
  initialFormId,
  initialFormUrl,
}: {
  testId: string;
  initialFormId: string | null;
  initialFormUrl: string | null;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formUrl, setFormUrl] = useState(initialFormUrl);
  const [formId, setFormId] = useState(initialFormId);
  const [needsRecovery, setNeedsRecovery] = useState(false);
  const [manualCopy, setManualCopy] = useState(false);
  const inFlight = useRef(false);
  const { toast } = useToast();

  async function copyLink() {
    if (!formUrl) return;
    if (await copyToClipboard(formUrl)) {
      setManualCopy(false);
      toast("Student link copied.");
    } else {
      setManualCopy(true);
      toast("Could not copy automatically. Copy the link shown in the box.", "error");
    }
  }

  async function handleCreate(recover = false) {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/forms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ testId, ...(recover && formId ? { formId } : {}) }),
      });
      const json = await res.json().catch(() => null);

      if (json?.data?.formId) setFormId(json.data.formId);
      if (json?.data?.formUrl) setFormUrl(json.data.formUrl);
      if (json?.data?.recoveryRequired) setNeedsRecovery(true);

      if (!res.ok || !json?.success) {
        throw new Error(json?.error || "Unable to create Google Form.");
      }

      setFormUrl(json.data.formUrl);
      setFormId(json.data.formId);
      setNeedsRecovery(false);
      toast(json.data.reused ? "Google Form is ready." : "Google Form created.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create Google Form.");
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {error && <ErrorState message={error} />}
      {error?.includes("Google account not connected") && (
        <a
          className="self-start text-sm text-indigo-300 underline"
          href={`/api/google/connect?returnTo=${encodeURIComponent(`/dashboard/tests/${testId}`)}`}
        >
          Connect a Google account
        </a>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {formUrl && (
          <div className="flex w-full flex-col gap-2 rounded-lg border border-slate-800 p-3">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Student link</span>
            <a href={formUrl} target="_blank" rel="noreferrer" className="break-all text-sm text-indigo-300 underline">
              {formUrl}
            </a>
            {manualCopy && (
              <input
                readOnly
                autoFocus
                value={formUrl}
                onFocus={(event) => event.currentTarget.select()}
                aria-label="Student link"
                className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-sm text-slate-200"
              />
            )}
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => void copyLink()}>
                <Copy className="h-4 w-4" />
                Copy link
              </Button>
              <a href={formUrl} target="_blank" rel="noreferrer">
                <Button variant="secondary">
                  <ExternalLink className="h-4 w-4" />
                  Open
                </Button>
              </a>
              {formId && (
                <a href={`https://docs.google.com/forms/d/${encodeURIComponent(formId)}/edit`} target="_blank" rel="noreferrer">
                  <Button variant="secondary">
                    <Pencil className="h-4 w-4" />
                    Edit form (faculty)
                  </Button>
                </a>
              )}
            </div>
          </div>
        )}
        {needsRecovery ? (
          <Button onClick={() => void handleCreate(true)} loading={loading} className="self-start">
            <FileSpreadsheet className="h-4 w-4" />
            Recover existing form
          </Button>
        ) : !formUrl && !formId ? (
          <Button onClick={() => void handleCreate(false)} loading={loading} className="self-start">
            <FileSpreadsheet className="h-4 w-4" />
            Create Google Form
          </Button>
        ) : null}
      </div>
    </div>
  );
}
