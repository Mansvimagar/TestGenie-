"use client";

import { useState } from "react";
import { ExternalLink, FileSpreadsheet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { useToast } from "@/components/ui/toast";

export function CreateFormButton({
  testId,
  initialFormUrl,
}: {
  testId: string;
  initialFormUrl: string | null;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formUrl, setFormUrl] = useState(initialFormUrl);
  const { toast } = useToast();

  async function handleCreate() {
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/forms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ testId }),
      });
      const json = await res.json();

      if (!res.ok || !json.success) {
        throw new Error(json.error || "Unable to create Google Form.");
      }

      setFormUrl(json.data.formUrl);
      toast("Google Form created.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create Google Form.");
    } finally {
      setLoading(false);
    }
  }

  if (formUrl) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-sm text-emerald-400">Google Form Created</span>
        <a href={formUrl} target="_blank" rel="noreferrer">
          <Button variant="secondary">
            <ExternalLink className="h-4 w-4" />
            Open Google Form
          </Button>
        </a>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {error && <ErrorState message={error} />}
      <Button onClick={handleCreate} loading={loading} className="self-start">
        <FileSpreadsheet className="h-4 w-4" />
        Create Google Form
      </Button>
    </div>
  );
}
