"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { useToast } from "@/components/ui/toast";

export function SyncScoresButton({ testId }: { testId: string }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reconnect, setReconnect] = useState(false);
  const inFlight = useRef(false);
  const router = useRouter();
  const { toast } = useToast();

  async function handleSync() {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    setError(null);
    setReconnect(false);
    try {
      const res = await fetch("/api/scores/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ testId }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) {
        setReconnect(Boolean(json?.data?.reconnectRequired));
        throw new Error(json?.error || "Unable to sync scores.");
      }
      const { synced, skipped } = json.data as { synced: number; skipped: number };
      toast(`Synced ${synced} response${synced === 1 ? "" : "s"}${skipped ? ` (${skipped} skipped: not graded)` : ""}.`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to sync scores.");
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {error && <ErrorState message={error} />}
      {reconnect && (
        <a
          className="self-start text-sm text-indigo-300 underline"
          href={`/api/google/connect?returnTo=${encodeURIComponent(`/dashboard/tests/${testId}`)}`}
        >
          Reconnect Google
        </a>
      )}
      <Button variant="secondary" onClick={() => void handleSync()} loading={loading} className="self-start">
        <RefreshCw className="h-4 w-4" />
        Sync scores
      </Button>
    </div>
  );
}
