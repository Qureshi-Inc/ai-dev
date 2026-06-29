import { z } from "zod";
import {
  ProjectSchema,
  ProjectTaskSchema,
  IssueJobSchema,
  ModelCallSchema,
  OmlxStatsSchema,
  DashboardEventSchema,
  HealthStatusSchema,
} from "./schemas";

export type Project = z.infer<typeof ProjectSchema>;
export type ProjectTask = z.infer<typeof ProjectTaskSchema>;
export type IssueJob = z.infer<typeof IssueJobSchema>;
export type ModelCall = z.infer<typeof ModelCallSchema>;
export type OmlxStats = z.infer<typeof OmlxStatsSchema>;
export type DashboardEvent = z.infer<typeof DashboardEventSchema>;
export type HealthStatus = z.infer<typeof HealthStatusSchema>;
