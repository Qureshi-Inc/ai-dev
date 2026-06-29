"use client";

import { cn } from "@/lib/utils";

interface HealthDotProps {
  status: "healthy" | "degraded" | "down" | "unknown";
  label?: string;
  className?: string;
}

const dotColors: Record<string, string> = {
  healthy: "bg-green-500",
  degraded: "bg-yellow-500",
  down: "bg-red-500",
  unknown: "bg-zinc-500",
};

export function HealthDot({ status, label, className }: HealthDotProps) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <span
        className={cn(
          "h-2.5 w-2.5 rounded-full",
          dotColors[status] || dotColors.unknown
        )}
      />
      {label && <span className="text-xs text-zinc-400">{label}</span>}
    </span>
  );
}
