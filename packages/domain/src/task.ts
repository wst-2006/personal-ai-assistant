import { z } from "zod";

export const taskEntryTypeSchema = z.enum(["task", "idea", "question"]);
export const taskLifecycleSchema = z.enum(["open", "active", "awaiting_outcome", "closed", "cancelled"]);
export const taskScheduleKindSchema = z.enum(["none", "daypart", "exact"]);
export const taskDaypartSchema = z.enum(["morning", "afternoon", "evening"]);
export const taskOutcomeSchema = z.enum(["not_completed", "partial", "complete"]);
export const taskSatisfactionSchema = z.enum(["satisfied", "neutral", "dissatisfied"]);
export const taskDifficultySchema = z.enum(["low", "medium", "high"]);
export const taskEventSourceSchema = z.enum(["app", "ai", "feishu", "system"]);
export const conflictDecisionSchema = z.enum(["reject", "keep"]);

export const ianaTimeZoneSchema = z.string().trim().min(1).max(64).refine(isValidIanaTimeZone, {
  message: "timeZone must be a valid IANA time zone"
});

const taskFields = {
  title: z.string().trim().min(1).max(200),
  entryType: taskEntryTypeSchema.default("task"),
  scheduleKind: taskScheduleKindSchema.default("none"),
  localDate: z.string().date().nullable().optional(),
  daypart: taskDaypartSchema.nullable().optional(),
  startAt: z.string().datetime({ offset: true }).nullable().optional(),
  endAt: z.string().datetime({ offset: true }).nullable().optional(),
  timeZone: ianaTimeZoneSchema.default("Asia/Shanghai"),
  estimatedMinutes: z.number().int().positive().max(1440).nullable().optional(),
  difficulty: taskDifficultySchema.nullable().optional(),
  taskType: z.string().trim().max(80).nullable().optional(),
  requiresContinuousFocus: z.boolean().nullable().optional(),
  notes: z.string().trim().max(4000).nullable().optional()
};

export const taskInputSchema = z.object({
  ...taskFields,
  conflictDecision: conflictDecisionSchema.default("reject"),
  expectedConflictFingerprint: z.string().min(1).max(128).optional()
}).strict().superRefine((input, context) => {
  validateConflictDecision(input, context);
  validateTaskSchedule(input, context);
});

export const taskPatchSchema = z.object({
  expectedVersion: z.number().int().positive(),
  title: taskFields.title.optional(),
  entryType: taskEntryTypeSchema.optional(),
  scheduleKind: taskScheduleKindSchema.optional(),
  localDate: z.string().date().nullable().optional(),
  daypart: taskDaypartSchema.nullable().optional(),
  startAt: z.string().datetime({ offset: true }).nullable().optional(),
  endAt: z.string().datetime({ offset: true }).nullable().optional(),
  timeZone: ianaTimeZoneSchema.optional(),
  estimatedMinutes: taskFields.estimatedMinutes,
  difficulty: taskFields.difficulty,
  taskType: taskFields.taskType,
  requiresContinuousFocus: taskFields.requiresContinuousFocus,
  notes: taskFields.notes,
  conflictDecision: conflictDecisionSchema.default("reject"),
  expectedConflictFingerprint: z.string().min(1).max(128).optional()
}).strict().superRefine(validateConflictDecision);

export const taskVersionActionSchema = z.object({
  expectedVersion: z.number().int().positive(),
  reason: z.string().trim().max(1000).optional()
}).strict();

export const taskReopenSchema = taskVersionActionSchema.extend({
  conflictDecision: conflictDecisionSchema.default("reject"),
  expectedConflictFingerprint: z.string().min(1).max(128).optional()
}).superRefine(validateConflictDecision);

export const taskOutcomeInputSchema = z.object({
  expectedVersion: z.number().int().positive(),
  outcome: taskOutcomeSchema,
  progressPercent: z.number().int().min(0).max(100),
  source: taskEventSourceSchema.default("app"),
  focusSessionId: z.string().uuid().nullable().optional(),
  note: z.string().trim().max(4000).nullable().optional()
}).strict().superRefine((input, context) => {
  const valid = input.outcome === "not_completed"
    ? input.progressPercent === 0
    : input.outcome === "complete"
      ? input.progressPercent === 100
      : input.progressPercent >= 1 && input.progressPercent <= 99;
  if (!valid) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["progressPercent"],
      message: "progressPercent does not match outcome"
    });
  }
});

export const acceptTaskConflictsSchema = z.object({
  expectedVersion: z.number().int().positive(),
  expectedConflictFingerprint: z.string().min(1).max(128)
}).strict();

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
  schedulePrecision: z.enum(["exact", "morning", "afternoon", "evening"]).nullable(),
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

type ScheduleShape = {
  entryType: z.infer<typeof taskEntryTypeSchema>;
  scheduleKind: z.infer<typeof taskScheduleKindSchema>;
  localDate?: string | null;
  daypart?: z.infer<typeof taskDaypartSchema> | null;
  startAt?: string | null;
  endAt?: string | null;
  timeZone: string;
};

type ConflictShape = {
  conflictDecision?: z.infer<typeof conflictDecisionSchema>;
  expectedConflictFingerprint?: string;
};

export function isValidIanaTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function localDateAtTimeZone(value: string | Date, timeZone: string): string {
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function validateTaskSchedule(input: ScheduleShape, context: z.RefinementCtx): void {
  const hasStart = Boolean(input.startAt);
  const hasEnd = Boolean(input.endAt);

  if (input.scheduleKind === "exact") {
    if (input.entryType !== "task") {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["entryType"], message: "Only tasks can use exact scheduling" });
    }
    if (!hasStart || !hasEnd) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["startAt"], message: "Exact scheduling requires startAt and endAt" });
      return;
    }
    if (input.localDate != null) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["localDate"], message: "localDate is derived for exact scheduling" });
    }
    if (input.daypart != null) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["daypart"], message: "Exact scheduling cannot include daypart" });
    }
    const start = new Date(input.startAt!);
    const end = new Date(input.endAt!);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || !isValidIanaTimeZone(input.timeZone)) {
      return;
    }
    if (end.getTime() <= start.getTime()) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["endAt"], message: "endAt must be after startAt" });
      return;
    }
    if (localDateAtTimeZone(start, input.timeZone) !== localDateAtTimeZone(end, input.timeZone)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["endAt"], message: "Phase 1 exact tasks cannot cross midnight" });
    }
    return;
  }

  if (hasStart || hasEnd) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["startAt"], message: "Non-exact scheduling cannot include startAt or endAt" });
  }
  if (input.scheduleKind === "daypart") {
    if (!input.localDate) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["localDate"], message: "Daypart scheduling requires localDate" });
    }
    if (!input.daypart) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["daypart"], message: "Daypart scheduling requires daypart" });
    }
  } else if (input.daypart != null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["daypart"], message: "Schedule kind none cannot include daypart" });
  }
}

function validateConflictDecision(input: ConflictShape, context: z.RefinementCtx): void {
  if (input.conflictDecision === "keep" && !input.expectedConflictFingerprint) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["expectedConflictFingerprint"],
      message: "Keeping conflicts requires the previously returned fingerprint"
    });
  }
}

export type TaskInput = z.infer<typeof taskInputSchema>;
export type TaskPatch = z.infer<typeof taskPatchSchema>;
export type TaskLifecycle = z.infer<typeof taskLifecycleSchema>;
export type TaskScheduleKind = z.infer<typeof taskScheduleKindSchema>;
export type TaskOutcome = z.infer<typeof taskOutcomeSchema>;
export type TaskEventSource = z.infer<typeof taskEventSourceSchema>;
export type NaturalLanguageTaskCandidate = z.infer<typeof naturalLanguageTaskCandidateSchema>;
