// Runtime helpers for scheduler-status.functions.ts. Server-function modules
// get split at build time, so shared schemas/types live in a plain module.

import { z } from "zod";
import type { JobSummary, TickActivity } from "./scheduler-status";

export const SchedulerStatusInput = z
  .object({ days: z.number().int().min(1).max(30).default(7) })
  .default({ days: 7 });

export type SchedulerPortfolioStatus = {
  id: string;
  name: string;
  mode: string;
  paused: boolean;
  /** Asset classes configured on the portfolio ("universe"). */
  classes: string[];
  /** Resolved universe symbols the run would consider. */
  symbols: string[];
  activity: TickActivity;
};

export type SchedulerStatusPayload = {
  generatedAt: string;
  windowDays: number;
  jobs: JobSummary[];
  portfolios: SchedulerPortfolioStatus[];
};
