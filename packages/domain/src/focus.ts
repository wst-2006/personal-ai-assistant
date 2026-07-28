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

export const focusSatisfactionSchema = z.enum(["satisfied", "neutral", "dissatisfied"]);
export const focusOutcomeSchema = z.enum(["not_completed", "partial", "complete"]);

export const createFocusSessionSchema = z.object({
  taskId: z.string().uuid(),
  expectedTaskVersion: z.number().int().positive(),
  mode: z.enum(["remind", "prepare", "restart"]).default("prepare")
}).strict();

export const focusSessionVersionSchema = z.object({
  expectedVersion: z.number().int().positive()
}).strict();

export const respondToFocusReminderSchema = focusSessionVersionSchema.extend({
  decision: z.enum(["start", "other_arrangement"])
}).strict();

export const stopFocusSessionSchema = focusSessionVersionSchema.extend({
  reason: z.string().trim().min(1).max(1000).optional()
}).strict();

export const evaluateFocusSessionSchema = focusSessionVersionSchema.extend({
  outcome: focusOutcomeSchema,
  progressPercent: z.number().int().min(0).max(100),
  satisfaction: focusSatisfactionSchema,
  note: z.string().trim().max(4000).nullable().optional()
}).strict().superRefine((input, context) => {
  const valid = input.outcome === "not_completed"
    ? input.progressPercent === 0
    : input.outcome === "complete"
      ? input.progressPercent === 100
      : input.progressPercent >= 1 && input.progressPercent <= 99;
  if (!valid) context.addIssue({ code: z.ZodIssueCode.custom, path: ["progressPercent"], message: "progressPercent does not match outcome" });
});

export type FocusSessionState = z.infer<typeof focusSessionStateSchema>;
export type FocusSatisfaction = z.infer<typeof focusSatisfactionSchema>;
