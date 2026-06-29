"use client";

import { cn } from "@/lib/utils";

interface OfflineBannerProps {
  visible: boolean;
  className?: string;
}

export function OfflineBanner({ visible, className }: OfflineBannerProps) {
  if (!visible) return null;

  return (
    <div
      className={cn(
        "fixed left-0 right-0 top-0 z-50 flex items-center justify-center gap-2 bg-red-600/90 px-4 py-2 text-sm font-medium text-white backdrop-blur-sm",
        className
      )}
    >
      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M18.364 5.636a9 9 0 11-12.728 0M12 9v4m0 4h.01"
        />
      </svg>
      <span>Connection lost. Reconnecting...</span>
    </div>
  );
}
