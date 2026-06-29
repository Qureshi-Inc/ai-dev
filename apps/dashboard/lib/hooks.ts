"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

export function useOverview() {
  return useQuery({
    queryKey: ["overview"],
    queryFn: () => api.getOverview(),
    refetchInterval: 10000,
  });
}

export function useProjects() {
  return useQuery({
    queryKey: ["projects"],
    queryFn: () => api.getProjects(),
    refetchInterval: 10000,
  });
}

export function useProject(id: string) {
  return useQuery({
    queryKey: ["project", id],
    queryFn: () => api.getProject(id),
    refetchInterval: 10000,
  });
}

export function useTask(id: string) {
  return useQuery({
    queryKey: ["task", id],
    queryFn: () => api.getTask(id),
    refetchInterval: 10000,
  });
}

export function useHealth() {
  return useQuery({
    queryKey: ["health"],
    queryFn: () => api.getHealth(),
    refetchInterval: 15000,
  });
}

export function useOmlx() {
  return useQuery({
    queryKey: ["omlx"],
    queryFn: () => api.getOmlx(),
    refetchInterval: 10000,
  });
}

export function useEvents(params?: { since?: string; limit?: number }) {
  return useQuery({
    queryKey: ["events", params],
    queryFn: () => api.getEvents(params),
    refetchInterval: 10000,
  });
}

export function formatDuration(ms: number): string {
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "< 1m";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}

export function useElapsedTime(startTime: string | null | undefined): string {
  if (!startTime) return "—";
  const ms = Date.now() - new Date(startTime).getTime();
  return formatDuration(ms);
}
