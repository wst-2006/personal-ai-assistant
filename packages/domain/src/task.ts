import { z } from "zod";

export const taskEntryTypeSchema = z.enum(["task", "idea", "question"]);
export const taskLifecycleSchema = z.enum(["open", "active", "awaiting_outcome", "closed", "cancelled"]);
export const taskScheduleKindSchema = z.enum(["none", "daypart", "exact"]);
export const taskDaypartSchema = z.enum(["morning", "afternoon", "evening"]);
export const taskOutcomeSchema = z.enum(["not_completed", "partial", "complete"]);
export const taskSatisfactionSchema = z.enum(["satisfied", "neutral", "dissatisfied"]);
export const taskEventSourceSchema = z.enum(["app", "ai", "feishu", "system"]);
export const conflictDecisionSchema = z.enum(["reject", "keep"]);

export const ianaTimeZoneSchema = z.string().trim().min(1).max(64).refine(isValidIanaTimeZone, {
  message: "timeZone must be a valid IANA time zone"
});

const taskFields = {
  title: z.string().trim().min(1).max(200),
  scheduleKind: taskScheduleKindSchema.default("none"),
  localDate: z.string().date().nullable().optional(),
  daypart: taskDaypartSchema.nullable().optional(),
  startAt: z.string().datetime({ offset: true }).nullable().optional(),
  endAt: z.string().datetime({ offset: true }).nullable().optional(),
  timeZone: ianaTimeZoneSchema.default("Asia/Shanghai"),
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
  expectedScheduleRevision: z.number().int().positive().optional(),
  title: taskFields.title.optional(),
  scheduleKind: taskScheduleKindSchema.optional(),
  localDate: z.string().date().nullable().optional(),
  daypart: taskDaypartSchema.nullable().optional(),
  startAt: z.string().datetime({ offset: true }).nullable().optional(),
  endAt: z.string().datetime({ offset: true }).nullable().optional(),
  timeZone: ianaTimeZoneSchema.optional(),
  notes: taskFields.notes,
  conflictDecision: conflictDecisionSchema.default("reject"),
  expectedConflictFingerprint: z.string().min(1).max(128).optional()
}).strict().superRefine((input, context) => {
  validateConflictDecision(input, context);
  if (hasSchedulePatchField(input) && !input.expectedScheduleRevision) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["expectedScheduleRevision"],
      message: "Schedule changes require expectedScheduleRevision"
    });
  }
});

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
  schedulePrecision: z.enum(["exact", "morning", "afternoon", "evening"]).nullable(),
  notes: z.string().trim().max(4000).nullable(),
  missingFields: z.array(z.enum([
    "title",
    "date",
    "startAt",
    "endAt",
    "schedulePrecision",
    "notes"
  ]))
}).strict().superRefine((candidate, context) => {
  if (candidate.entryType !== "task") {
    for (const field of ["date", "startAt", "endAt", "schedulePrecision"] as const) {
      if (candidate[field] !== null) context.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: "Ideas and questions cannot contain task fields" });
    }
    return;
  }
  if (candidate.schedulePrecision !== "exact") return;
  if (!candidate.startAt || !candidate.endAt) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["startAt"], message: "Exact candidates require startAt and endAt" });
    return;
  }
  const start = new Date(candidate.startAt);
  const end = new Date(candidate.endAt);
  if (!isHalfHourBoundary(start, "Asia/Shanghai")
    || !isHalfHourBoundary(end, "Asia/Shanghai")
    || end.getTime() - start.getTime() < 30 * 60 * 1000) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["startAt"], message: "Exact candidates must use the 30-minute timeline contract" });
  }
});

type ScheduleShape = {
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

function isHalfHourBoundary(value: Date, timeZone: string): boolean {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? -1);
  const second = Number(parts.find((part) => part.type === "second")?.value ?? -1);
  return minute % 30 === 0 && second === 0 && value.getUTCMilliseconds() === 0;
}

export function validateTaskSchedule(input: ScheduleShape, context: z.RefinementCtx): void {
  const hasStart = Boolean(input.startAt);
  const hasEnd = Boolean(input.endAt);

  if (input.scheduleKind === "exact") {
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
    if (!isHalfHourBoundary(start, input.timeZone) || !isHalfHourBoundary(end, input.timeZone)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["startAt"], message: "Exact task boundaries must use 30-minute intervals" });
      return;
    }
    if (end.getTime() - start.getTime() < 30 * 60 * 1000) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["endAt"], message: "Exact tasks must be at least 30 minutes" });
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

function hasSchedulePatchField(input: Record<string, unknown>): boolean {
  return ["scheduleKind", "localDate", "daypart", "startAt", "endAt", "timeZone"]
    .some((field) => input[field] !== undefined);
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
