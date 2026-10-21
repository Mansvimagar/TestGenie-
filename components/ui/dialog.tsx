"use client";

import { useEffect, useRef } from "react";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

// Native <dialog> element -- no modal library needed for a single confirm box.
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Confirm",
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onCancel={onCancel}
      className="rounded-xl border border-slate-800 bg-slate-900 p-6 text-slate-100 backdrop:bg-black/60 w-full max-w-sm"
    >
      <h3 className="text-base font-semibold mb-2">{title}</h3>
      <p className="text-sm text-slate-400 mb-6">{description}</p>
      <div className="flex justify-end gap-2">
        <button
          onClick={onCancel}
          className="rounded-lg px-4 py-2 text-sm font-medium bg-slate-800 hover:bg-slate-700"
        >
          Cancel
        </button>
        <button
          onClick={onConfirm}
          className="rounded-lg px-4 py-2 text-sm font-medium bg-danger hover:bg-red-700 text-white"
        >
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
