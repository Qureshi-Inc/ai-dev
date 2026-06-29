"use client";

import { cn } from "@/lib/utils";
import type { SSEMode } from "@/lib/sse";

interface LiveIndicatorProps {
  mode: SSEMode;
  connected: boolean;
  onModeChange: (mode: SSEMode) => void;
  className?: string;
}

const modeLabels: Record<SSEMode, string> = {
  auto: "Auto",
  on: "On",
  paused: "Paused",
};

export function LiveIndicator({ mode, connected, onModeChange, className }: LiveIndicatorProps) {
  const modes: SSEMode[] = ["auto", "on", "paused"];
  const currentIndex = modes.indexOf(mode);

  const cycle = () => {
    const next = modes[(currentIndex + 1) % modes.length];
    onModeChange(next);
  };

  return (
    <button
      onClick={cycle}
      className={cn(
        "inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
        "min-h-[44px] min-w-[44px]",
        connected
          ? "bg-green-600/10 text-green-400 hover:bg-green-600/20"
          : "bg-red-600/10 text-red-400 hover:bg-red-600/20",
        className
      )}
    >
      <span className="relative flex h-2 w-2">
        {connected && mode !== "paused" && (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
        )}
        <span
          className={cn(
            "relative inline-flex h-2 w-2 rounded-full",
            connected ? "bg-green-400" : "bg-red-400"
          )}
        />
      </span>
      <span>Live: {modeLabels[mode]}</span>
    </button>
  );
}
