"use client";

import { useCallback, useRef, useState } from "react";
import { UploadCloud, FileText, X } from "lucide-react";
import { cn } from "@/lib/utils";

export function FileUpload({
  onFileSelected,
  file,
  onClear,
}: {
  onFileSelected: (file: File) => void;
  file: File | null;
  onClear: () => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = useCallback(
    (files: FileList | null) => {
      const selected = files?.[0];
      if (selected) onFileSelected(selected);
    },
    [onFileSelected]
  );

  if (file) {
    return (
      <div className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-900 px-4 py-3">
        <div className="flex items-center gap-3">
          <FileText className="h-5 w-5 text-indigo-400" />
          <div>
            <p className="text-sm font-medium text-slate-100">{file.name}</p>
            <p className="text-xs text-slate-500">{(file.size / 1024).toFixed(0)} KB</p>
          </div>
        </div>
        <button onClick={onClear} className="text-slate-500 hover:text-slate-200" aria-label="Remove file">
          <X className="h-4 w-4" />
        </button>
      </div>
    );
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        handleFiles(e.dataTransfer.files);
      }}
      onClick={() => inputRef.current?.click()}
      className={cn(
        "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-6 py-10 text-center transition-colors",
        dragOver ? "border-primary bg-primary/5" : "border-slate-800 hover:border-slate-700"
      )}
    >
      <UploadCloud className="h-8 w-8 text-slate-500" />
      <p className="text-sm text-slate-300">
        Drag and drop a syllabus PDF, or <span className="text-indigo-400">browse</span>
      </p>
      <p className="text-xs text-slate-500">PDF only, up to 15MB</p>
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf"
        className="hidden"
        onChange={(e) => handleFiles(e.target.files)}
      />
    </div>
  );
}
