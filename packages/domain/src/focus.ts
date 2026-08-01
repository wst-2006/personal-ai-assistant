import { z } from "zod";

export const focusSessionStateSchema = z.enum([
  "scheduled",
  "reminded",
  "preparing",
  "awaiting_start",
  "running",
  "ended",
  "evaluated",
  "stopped_no_response",
  "stopped_for_change"
]);

export const focusSatisfactionSchema = z.enum(["satisfied", "neutral", "dissatisfied"]);
export const focusOutcomeSchema = z.enum(["not_completed", "partial", "complete"]);
export const focusStructureSourceSchema = z.enum(["manual", "template", "ai"]);
export const focusStructureStateSchema = z.enum(["candidate", "active", "superseded", "invalidated", "cancelled"]);
export const focusStructureModeSchema = z.enum(["continuous", "segmented"]);
export const focusSegmentTypeSchema = z.enum(["focus", "break"]);

type FocusStructureInputShape = {
  taskId: string;
  taskVersion: number;
  taskScheduleRevision: number;
  source: z.infer<typeof focusStructureSourceSchema>;
  mode: z.infer<typeof focusStructureModeSchema>;
  totalStartAt: string;
  totalEndAt: string;
  breakMinutes: number;
  segments?: FocusSegment[];
};

export const focusSegmentSchema = z.object({
  segmentType: focusSegmentTypeSchema,
  durationMinutes: z.number().int().positive()
}).strict().superRefine((segment, context) => {
  if (segment.segmentType === "focus" && segment.durationMinutes < 30) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["durationMinutes"], message: "Focus segments must be at least 30 minutes" });
  }
  if (segment.segmentType === "break" && (segment.durationMinutes < 5 || segment.durationMinutes > 15)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["durationMinutes"], message: "Break segments must be between 5 and 15 minutes" });
  }
});

export const focusStructureInputSchema = z.object({
  taskId: z.string().uuid(),
  taskVersion: z.number().int().positive(),
  taskScheduleRevision: z.number().int().positive(),
  source: focusStructureSourceSchema,
  mode: focusStructureModeSchema,
  totalStartAt: z.string().datetime({ offset: true }),
  totalEndAt: z.string().datetime({ offset: true }),
  breakMinutes: z.number().int().min(0).max(15).default(5),
  segments: z.array(focusSegmentSchema).min(1).optional()
}).strict().superRefine(validateFocusStructureInput);

export const createFocusSessionSchema = z.object({
  taskId: z.string().uuid(),
  expectedTaskVersion: z.number().int().positive(),
  mode: z.enum(["remind", "prepare"]).default("prepare")
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
export type FocusStructureSource = z.infer<typeof focusStructureSourceSchema>;
export type FocusStructureState = z.infer<typeof focusStructureStateSchema>;
export type FocusStructureMode = z.infer<typeof focusStructureModeSchema>;
export type FocusSegment = z.infer<typeof focusSegmentSchema>;

export type FocusStructureInput = z.infer<typeof focusStructureInputSchema>;

export type FocusStructure = {
  totalStartAt: Date;
  totalEndAt: Date;
  mode: FocusStructureMode;
  breakMinutes: number;
  segments: FocusSegment[];
  totalMinutes: number;
  effectiveFocusMinutes: number;
};

export function calculateEffectiveFocusSeconds(input: {
  structureStartAt: Date | string;
  actualStartAt: Date | string;
  fixedEndAt: Date | string;
  now?: Date | string;
  segments: FocusSegment[];
}): number {
  const structureStart = toValidDate(input.structureStartAt, "structureStartAt");
  const actualStart = toValidDate(input.actualStartAt, "actualStartAt");
  const fixedEnd = toValidDate(input.fixedEndAt, "fixedEndAt");
  const now = toValidDate(input.now ?? new Date(), "now");
  const rangeStart = Math.max(actualStart.getTime(), structureStart.getTime());
  const rangeEnd = Math.min(now.getTime(), fixedEnd.getTime());
  if (rangeEnd <= rangeStart) return 0;

  let cursor = structureStart.getTime();
  let effectiveSeconds = 0;
  for (const segment of input.segments) {
    const segmentStart = cursor;
    const segmentEnd = cursor + segment.durationMinutes * 60_000;
    if (segment.segmentType === "focus") {
      const overlapStart = Math.max(rangeStart, segmentStart);
      const overlapEnd = Math.min(rangeEnd, segmentEnd);
      if (overlapEnd > overlapStart) effectiveSeconds += Math.floor((overlapEnd - overlapStart) / 1000);
    }
    cursor = segmentEnd;
  }
  return effectiveSeconds;
}

/**
 * Allocates a continuous focus block without changing its fixed end time.
 * A task shorter than one hour is uninterrupted. Longer blocks reserve only
 * the final rest interval, so the effective focus time is always derived from
 * the fixed task interval and the selected rest duration.
 */
export function allocateContinuousFocusStructure(input: {
  totalStartAt: Date | string;
  totalEndAt: Date | string;
  breakMinutes?: number;
}): FocusStructure {
  const start = toValidDate(input.totalStartAt, "totalStartAt");
  const end = toValidDate(input.totalEndAt, "totalEndAt");
  const totalMinutes = (end.getTime() - start.getTime()) / 60_000;
  if (!Number.isInteger(totalMinutes) || totalMinutes < 30 || totalMinutes % 30 !== 0) {
    throw new Error("Focus task duration must be a positive multiple of 30 minutes");
  }

  const requestedBreak = input.breakMinutes ?? 5;
  if (!Number.isInteger(requestedBreak) || requestedBreak < 5 || requestedBreak > 15) {
    throw new Error("Break duration must be between 5 and 15 minutes");
  }

  const breakMinutes = totalMinutes <= 30 ? 0 : requestedBreak;
  const focusMinutes = totalMinutes - breakMinutes;
  if (focusMinutes < 30) throw new Error("The selected break leaves less than 30 minutes of focus");

  const segments: FocusSegment[] = [{ segmentType: "focus", durationMinutes: focusMinutes }];
  if (breakMinutes > 0) segments.push({ segmentType: "break", durationMinutes: breakMinutes });
  return { totalStartAt: start, totalEndAt: end, mode: "continuous", breakMinutes, segments, totalMinutes, effectiveFocusMinutes: focusMinutes };
}

/**
 * Validates a user-provided segmented plan. The final segment must end at the
 * task's fixed end; no operation is allowed to extend the task interval.
 */
export function validateSegmentedFocusStructure(input: {
  totalStartAt: Date | string;
  totalEndAt: Date | string;
  segments: FocusSegment[];
}): FocusStructure {
  const start = toValidDate(input.totalStartAt, "totalStartAt");
  const end = toValidDate(input.totalEndAt, "totalEndAt");
  const totalMinutes = (end.getTime() - start.getTime()) / 60_000;
  if (!Number.isInteger(totalMinutes) || totalMinutes < 30 || totalMinutes % 30 !== 0) {
    throw new Error("Focus task duration must be a positive multiple of 30 minutes");
  }
  const parsed = z.array(focusSegmentSchema).min(1).safeParse(input.segments);
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Invalid focus segments");
  const segments = parsed.data;
  const minutes = segments.reduce((sum, segment) => sum + segment.durationMinutes, 0);
  if (minutes !== totalMinutes) throw new Error("Focus segments must exactly fill the fixed task interval");
  if (segments[0]?.segmentType !== "focus" || segments.at(-1)?.segmentType !== "focus") {
    throw new Error("A focus structure must start and end with focus");
  }
  for (let index = 1; index < segments.length; index += 1) {
    if (segments[index]?.segmentType === segments[index - 1]?.segmentType) {
      throw new Error("Focus and break segments must alternate");
    }
  }
  const breakMinutes = segments.filter((segment) => segment.segmentType === "break")
    .reduce((sum, segment) => sum + segment.durationMinutes, 0);
  return {
    totalStartAt: start,
    totalEndAt: end,
    mode: "segmented",
    breakMinutes,
    segments,
    totalMinutes,
    effectiveFocusMinutes: totalMinutes - breakMinutes
  };
}

function validateFocusStructureInput(input: FocusStructureInputShape, context: z.RefinementCtx): void {
  const start = new Date(input.totalStartAt);
  const end = new Date(input.totalEndAt);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["totalEndAt"], message: "totalEndAt must be after totalStartAt" });
    return;
  }
  const totalMinutes = (end.getTime() - start.getTime()) / 60_000;
  if (!Number.isInteger(totalMinutes) || totalMinutes < 30 || totalMinutes % 30 !== 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["totalEndAt"], message: "Focus task duration must be a positive multiple of 30 minutes" });
  }
  if (input.mode === "continuous") {
    if (input.segments !== undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ["segments"], message: "Continuous structures are allocated by the server" });
    if (input.breakMinutes < 5 || input.breakMinutes > 15) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["breakMinutes"], message: "Break duration must be between 5 and 15 minutes" });
    }
  } else if (!input.segments) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["segments"], message: "Segmented structures require segments" });
  }
}

function toValidDate(value: Date | string, field: string): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${field} must be a valid date`);
  return date;
}
