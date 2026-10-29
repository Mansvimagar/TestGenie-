"use client";

import { useEffect, useRef, useState } from "react";
import { UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { useToast } from "@/components/ui/toast";

type State = "loading" | "present" | "missing_no_responses" | "missing_has_responses" | "partial" | "unknown";

/** Offers "Add student details fields" only for an old Form with no identity items and no responses. */
export function AddIdentityFieldsButton({ testId }: { testId: string }) {
  const [state, setState] = useState<State>("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const { toast } = useToast();

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/forms/identity-fields?testId=${encodeURIComponent(testId)}`)
      .then((res) => res.json().catch(() => null))
      .then((json) => {
        if (!cancelled) setState(json?.success ? (json.data.state as State) : "unknown");
      })
      .catch(() => {
        if (!cancelled) setState("unknown");
      });
    return () => {
      cancelled = true;
    };
  }, [testId]);

  async function handleAdd() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/forms/identity-fields", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ testId }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) throw new Error(json?.error || "Unable to add student details fields.");
      setState("present");
      toast("Student details fields added to the Google Form.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to add student details fields.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  if (state === "missing_has_responses") {
    return (
      <p className="text-sm text-amber-300">
        This Google Form has no student details fields and already has responses, so they cannot be added safely.
        Create a new test to collect Full Name, Roll No, Class and Division.
      </p>
    );
  }
  if (state !== "missing_no_responses") return error ? <ErrorState message={error} /> : null;

  return (
    <div className="flex flex-col gap-2">
      {error && <ErrorState message={error} />}
      <Button variant="secondary" onClick={() => void handleAdd()} loading={busy} className="self-start">
        <UserPlus className="h-4 w-4" />
        Add student details fields
      </Button>
    </div>
  );
}
