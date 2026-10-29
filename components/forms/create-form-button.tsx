"use client";

import { useRef, useState } from "react";
import { ExternalLink, FileSpreadsheet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { useToast } from "@/components/ui/toast";

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
  const inFlight = useRef(false);
  const { toast } = useToast();

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
          <a href={formUrl} target="_blank" rel="noreferrer">
            <Button variant="secondary">
              <ExternalLink className="h-4 w-4" />
              Open Google Form
            </Button>
          </a>
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
