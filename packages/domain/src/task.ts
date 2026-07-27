import { z } from "zod";

export const taskEntryTypeSchema = z.enum(["task", "idea", "question"]);
export const taskLifecycleSchema = z.enum([
  "draft",
  "awaiting_confirmation",
  "scheduled",
  "unscheduled",
  "active",
  "awaiting_outcome",
  "closed",
  "cancelled"
]);
export const taskOutcomeSchema = z.enum(["not_completed", "partial", "complete"]);
export const taskSatisfactionSchema = z.enum(["satisfied", "neutral", "dissatisfied"]);
export const taskDifficultySchema = z.enum(["low", "medium", "high"]);
export const schedulePrecisionSchema = z.enum(["exact", "morning", "afternoon", "evening"]);

export const taskInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  entryType: taskEntryTypeSchema.default("task"),
  date: z.string().date().optional(),
  startAt: z.string().datetime({ offset: true }).optional(),
  endAt: z.string().datetime({ offset: true }).optional(),
  estimatedMinutes: z.number().int().positive().max(1440).optional(),
  difficulty: taskDifficultySchema.optional(),
  taskType: z.string().trim().max(80).optional(),
  requiresContinuousFocus: z.boolean().optional(),
  schedulePrecision: schedulePrecisionSchema.optional(),
  notes: z.string().trim().max(4000).optional()
});

export const naturalLanguageTaskCandidateSchema = z.object({
  title: z.string().trim().min(1).max(200),
  entryType: taskEntryTypeSchema,
  date: z.string().date().nullable(),
  startAt: z.string().datetime({ offset: true }).nullable(),
  endAt: z.string().datetime({ offset: true }).nullable(),
  estimatedMinutes: z.number().int().positive().max(1440).nullable(),
  difficulty: taskDifficultySchema.nullable(),
  taskType: z.string().trim().max(80).nullable(),
  requiresContinuousFocus: z.boolean().nullable(),
  schedulePrecision: schedulePrecisionSchema.nullable(),
  notes: z.string().trim().max(4000).nullable(),
  missingFields: z.array(z.enum([
    "title",
    "date",
    "startAt",
    "endAt",
    "estimatedMinutes",
    "difficulty",
    "taskType",
    "requiresContinuousFocus",
    "schedulePrecision",
    "notes"
  ]))
});

export type TaskInput = z.infer<typeof taskInputSchema>;
export type TaskLifecycle = z.infer<typeof taskLifecycleSchema>;
export type TaskOutcome = z.infer<typeof taskOutcomeSchema>;
export type NaturalLanguageTaskCandidate = z.infer<typeof naturalLanguageTaskCandidateSchema>;
