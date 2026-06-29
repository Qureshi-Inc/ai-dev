"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

interface ConfirmSheetProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  confirmVariant?: "default" | "destructive";
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmSheet({
  open,
  title,
  description,
  confirmLabel = "Confirm",
  confirmVariant = "default",
  onConfirm,
  onCancel,
}: ConfirmSheetProps) {
  const sheetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm"
        onClick={onCancel}
      />
      {/* Sheet */}
      <div
        ref={sheetRef}
        className={cn(
          "fixed inset-x-0 bottom-0 z-50 rounded-t-2xl border-t border-zinc-800 bg-zinc-900 p-6 shadow-xl",
          "animate-in slide-in-from-bottom duration-300"
        )}
      >
        <div className="mx-auto mb-4 h-1 w-12 rounded-full bg-zinc-700" />
        <h3 className="text-lg font-semibold text-zinc-100">{title}</h3>
        <p className="mt-2 text-sm text-zinc-400">{description}</p>
        <div className="mt-6 flex gap-3">
          <Button
            variant="outline"
            className="min-h-[44px] flex-1"
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button
            variant={confirmVariant}
            className="min-h-[44px] flex-1"
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </>
  );
}
