"use client";

import { useState } from "react";
import { FileUp, Type } from "lucide-react";
import { FileUpload } from "./file-upload";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { cn } from "@/lib/utils";
import type { SyllabusIngestionSummary } from "@/types/syllabus";

type Mode = "upload" | "manual";

export function SyllabusStep({
  onIngested,
}: {
  onIngested: (result: SyllabusIngestionSummary) => void;
}) {
  const [mode, setMode] = useState<Mode>("upload");
  const [file, setFile] = useState<File | null>(null);
  const [manualText, setManualText] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleContinue() {
    setError(null);

    if (mode === "manual") {
      if (manualText.trim().length < 50) {
        setError("Paste at least a few sentences of syllabus content.");
        return;
      }
    } else if (!file) {
      setError("Choose a PDF file first, or switch to manual text entry.");
      return;
    }

    setStatus(mode === "manual" ? "Ingesting text..." : "Uploading PDF...");

    try {
      let requestOptions: RequestInit;
      if (mode === "manual") {
        requestOptions = {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: manualText.trim() }),
        };
      } else {
        const formData = new FormData();
        formData.append("file", file!);
        requestOptions = { method: "POST", body: formData };
        setStatus("Extracting and ingesting PDF...");
      }

      const res = await fetch("/api/syllabus", requestOptions);
      const json = await res.json().catch(() => null);

      if (!res.ok || !json?.success || !json.data) {
        throw new Error(json?.error || "Failed to ingest the syllabus.");
      }

      const result = json.data as SyllabusIngestionSummary;
      if (
        typeof result.syllabusId !== "string" ||
        !Array.isArray(result.outline?.units) ||
        typeof result.chunkCount !== "number"
      ) {
        throw new Error("The server returned an incomplete ingestion result.");
      }

      onIngested(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to ingest the syllabus.");
    } finally {
      setStatus(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-2">
        <TabButton active={mode === "upload"} onClick={() => setMode("upload")} icon={FileUp}>
          Upload PDF
        </TabButton>
        <TabButton active={mode === "manual"} onClick={() => setMode("manual")} icon={Type}>
          Paste Text
        </TabButton>
      </div>

      {mode === "upload" ? (
        <FileUpload file={file} onFileSelected={setFile} onClear={() => setFile(null)} />
      ) : (
        <Textarea
          rows={10}
          placeholder="Paste the syllabus content here..."
          value={manualText}
          onChange={(e) => setManualText(e.target.value)}
        />
      )}

      {error && <ErrorState message={error} />}

      <Button onClick={handleContinue} loading={Boolean(status)} className="self-start">
        {status || "Continue"}
      </Button>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon: Icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium",
        active ? "bg-primary/15 text-indigo-300" : "text-slate-400 hover:bg-slate-800"
      )}
    >
      <Icon className="h-4 w-4" />
      {children}
    </button>
  );
}
