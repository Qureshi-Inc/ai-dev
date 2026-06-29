"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { BottomNav } from "@/components/BottomNav";
import { Sidebar } from "@/components/Sidebar";

function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Sidebar />
      <div className="md:pl-60">
        <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b border-zinc-800 bg-zinc-950/95 px-4 backdrop-blur-sm md:px-6">
          <h1 className="text-sm font-semibold text-zinc-100 md:hidden">ai-dev</h1>
          <div className="hidden md:block" />
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <span className="relative flex h-2 w-2">
              <span className="relative inline-flex h-2 w-2 rounded-full bg-green-400" />
            </span>
            <span>Live</span>
          </div>
        </header>
        <main className="min-h-[calc(100vh-3.5rem)] pb-20 md:pb-6">
          {children}
        </main>
      </div>
      <BottomNav />
    </>
  );
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 5_000,
            refetchInterval: 10_000,
            retry: 1,
          },
        },
      })
  );

  return (
    <QueryClientProvider client={queryClient}>
      <AppShell>{children}</AppShell>
    </QueryClientProvider>
  );
}
