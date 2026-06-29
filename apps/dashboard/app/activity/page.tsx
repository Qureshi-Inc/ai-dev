"use client";

import { useState, useMemo } from "react";
import { useEvents } from "@/lib/hooks";
import { EventItem } from "@/components/EventItem";

type SeverityFilter = "all" | "info" | "warn" | "error";

export default function ActivityPage() {
  const { data: events = [], isLoading } = useEvents({ limit: 200 });
  const [search, setSearch] = useState("");
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>("all");
  const [sourceFilter, setSourceFilter] = useState<string>("all");

  // Compute available sources from event type prefix
  const sources = useMemo(() => {
    const set = new Set(
      events.map((e) => {
        const d = (e.data ?? {}) as Record<string, unknown>;
        return (d.source as string) || e.type.split(".")[0] || "system";
      })
    );
    return Array.from(set).sort();
  }, [events]);

  // Filter events
  const filtered = useMemo(() => {
    return events.filter((event) => {
      const d = (event.data ?? {}) as Record<string, unknown>;
      const severity = (d.severity as string) || "info";
      const source = (d.source as string) || event.type.split(".")[0] || "system";
      const message = (d.message as string) || event.type;

      if (severityFilter !== "all" && severity !== severityFilter) return false;
      if (sourceFilter !== "all" && source !== sourceFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        return (
          message.toLowerCase().includes(q) ||
          source.toLowerCase().includes(q) ||
          event.type.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [events, search, severityFilter, sourceFilter]);

  return (
    <div className="space-y-4 p-4 md:p-6">
      <h1 className="text-lg font-semibold text-zinc-100">Activity</h1>

      {/* Search */}
      <div className="relative">
        <svg
          className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
          />
        </svg>
        <input
          type="text"
          placeholder="Search events..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="min-h-[44px] w-full rounded-lg border border-zinc-800 bg-zinc-900 py-2 pl-10 pr-4 text-sm text-zinc-200 placeholder-zinc-500 focus:border-blue-600 focus:outline-none focus:ring-1 focus:ring-blue-600"
        />
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2">
        {/* Severity filter */}
        <div className="flex gap-1 rounded-lg bg-zinc-900 p-1">
          {(["all", "info", "warn", "error"] as SeverityFilter[]).map((sev) => (
            <button
              key={sev}
              onClick={() => setSeverityFilter(sev)}
              className={`min-h-[32px] rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                severityFilter === sev
                  ? "bg-zinc-800 text-zinc-100 shadow-sm"
                  : "text-zinc-400 hover:text-zinc-300"
              }`}
            >
              {sev === "all" ? "All" : sev.charAt(0).toUpperCase() + sev.slice(1)}
            </button>
          ))}
        </div>

        {/* Source filter */}
        {sources.length > 0 && (
          <select
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
            className="min-h-[32px] rounded-lg border border-zinc-800 bg-zinc-900 px-2 text-xs text-zinc-300 focus:border-blue-600 focus:outline-none"
          >
            <option value="all">All sources</option>
            {sources.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Event list */}
      <div className="space-y-1 rounded-lg border border-zinc-800 bg-zinc-900/30 p-2">
        {filtered.length === 0 && !isLoading ? (
          <p className="p-8 text-center text-sm text-zinc-500">
            {events.length === 0 ? "No events yet" : "No events match your filters"}
          </p>
        ) : (
          <>
            {filtered.map((event) => (
              <EventItem key={event.id} event={event} />
            ))}
          </>
        )}

        {isLoading && (
          <div className="flex items-center justify-center py-4">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-700 border-t-blue-500" />
          </div>
        )}
      </div>
    </div>
  );
}
