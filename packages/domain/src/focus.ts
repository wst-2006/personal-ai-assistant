import { z } from "zod";

export const focusSessionStateSchema = z.enum([
  "scheduled",
  "reminded",
  "preparing",
  "awaiting_start",
  "running",
  "paused",
  "ended",
  "evaluated",
  "stopped_no_response",
  "stopped_for_change"
]);

export type FocusSessionState = z.infer<typeof focusSessionStateSchema>;
