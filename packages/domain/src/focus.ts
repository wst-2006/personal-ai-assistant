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
export const focusDistributionSchema = z.enum(["equal", "increasing", "decreasing"]);

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
export type FocusDistribution = z.infer<typeof focusDistributionSchema>;

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
  if (!Number.isInteger(requestedBreak) || requestedBreak < 0 || requestedBreak > 15) {
    throw new Error("Break duration must be between 0 and 15 minutes");
  }
  if (totalMinutes > 30 && requestedBreak < 5) {
    throw new Error("Tasks longer than 30 minutes require a 5-15 minute final break");
  }

  const breakMinutes = totalMinutes <= 30 ? 0 : requestedBreak;
  const focusMinutes = totalMinutes - breakMinutes;
  if (focusMinutes < 30) throw new Error("The selected break leaves less than 30 minutes of focus");

  const segments: FocusSegment[] = [{ segmentType: "focus", durationMinutes: focusMinutes }];
  if (breakMinutes > 0) segments.push({ segmentType: "break", durationMinutes: breakMinutes });
  return { totalStartAt: start, totalEndAt: end, mode: "continuous", breakMinutes, segments, totalMinutes, effectiveFocusMinutes: focusMinutes };
}

/**
 * Builds a deterministic integer-minute template inside a fixed task window.
 * Equal templates place unavoidable remainder minutes at the beginning.
 * Increasing/decreasing templates reserve a one-minute staircase first, then
 * spread the remaining minutes evenly without changing the task boundaries.
 */
export function allocateTemplateFocusStructure(input: {
  totalStartAt: Date | string;
  totalEndAt: Date | string;
  focusCount: number;
  distribution: FocusDistribution;
  breakMinutes?: number;
}): FocusStructure {
  if (!Number.isInteger(input.focusCount) || input.focusCount < 1) {
    throw new Error("Focus count must be a positive integer");
  }
  if (input.focusCount === 1) {
    return allocateContinuousFocusStructure(input);
  }

  const start = toValidDate(input.totalStartAt, "totalStartAt");
  const end = toValidDate(input.totalEndAt, "totalEndAt");
  const totalMinutes = (end.getTime() - start.getTime()) / 60_000;
  if (!Number.isInteger(totalMinutes) || totalMinutes < 30 || totalMinutes % 30 !== 0) {
    throw new Error("Focus task duration must be a positive multiple of 30 minutes");
  }
  const breakMinutes = input.breakMinutes ?? 5;
  if (!Number.isInteger(breakMinutes) || breakMinutes < 5 || breakMinutes > 15) {
    throw new Error("Break duration must be between 5 and 15 minutes");
  }

  const focusMinutes = totalMinutes - input.focusCount * breakMinutes;
  const minimumFocusMinutes = input.focusCount * 30;
  if (focusMinutes < minimumFocusMinutes) {
    throw new Error("The task interval cannot contain the requested number of focus segments");
  }

  const durations = input.distribution === "equal"
    ? distributeEqual(focusMinutes, input.focusCount)
    : distributeStepped(focusMinutes, input.focusCount, input.distribution);
  const segments = durations.flatMap<FocusSegment>((durationMinutes) => [
    { segmentType: "focus", durationMinutes },
    { segmentType: "break", durationMinutes: breakMinutes }
  ]);
  return validateSegmentedFocusStructure({ totalStartAt: start, totalEndAt: end, segments });
}

export function adjustAdjacentFocusSegments(
  segments: FocusSegment[],
  boundaryIndex: number,
  requestedDeltaMinutes: number
): FocusSegment[] {
  if (!Number.isInteger(boundaryIndex) || boundaryIndex < 0 || boundaryIndex >= segments.length - 1) {
    throw new Error("Focus segment boundary is out of range");
  }
  if (!Number.isInteger(requestedDeltaMinutes)) throw new Error("Focus segment adjustment must use whole minutes");
  const left = segments[boundaryIndex]!;
  const right = segments[boundaryIndex + 1]!;
  const leftRange = segmentDurationRange(left.segmentType);
  const rightRange = segmentDurationRange(right.segmentType);
  const minimumDelta = Math.max(leftRange.minimum - left.durationMinutes, right.durationMinutes - rightRange.maximum);
  const maximumDelta = Math.min(leftRange.maximum - left.durationMinutes, right.durationMinutes - rightRange.minimum);
  const delta = Math.max(minimumDelta, Math.min(maximumDelta, requestedDeltaMinutes));
  return segments.map((segment, index) => index === boundaryIndex
    ? { ...segment, durationMinutes: segment.durationMinutes + delta }
    : index === boundaryIndex + 1
      ? { ...segment, durationMinutes: segment.durationMinutes - delta }
      : { ...segment });
}

/**
 * Validates a user-provided segmented plan. Every focus segment has a matching
 * break, including the final focus segment. No operation is allowed to extend
 * the task interval.
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
  if (segments[0]?.segmentType !== "focus" || !segments.some((segment) => segment.segmentType === "focus")) {
    throw new Error("A focus structure must start with a focus segment");
  }
  for (let index = 1; index < segments.length; index += 1) {
    if (segments[index]?.segmentType === segments[index - 1]?.segmentType) {
      throw new Error("Focus and break segments must alternate");
    }
  }
  if (segments.length > 1 && segments.at(-1)?.segmentType !== "break") {
    throw new Error("Every focus segment must be followed by a break segment");
  }
  if (segments.length > 1) {
    const focusCount = segments.filter((segment) => segment.segmentType === "focus").length;
    const breakCount = segments.filter((segment) => segment.segmentType === "break").length;
    if (focusCount !== breakCount) throw new Error("Every focus segment must have one corresponding break segment");
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
    if (input.breakMinutes > 15 || (totalMinutes > 30 && input.breakMinutes < 5)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["breakMinutes"], message: totalMinutes > 30
        ? "Tasks longer than 30 minutes require a 5-15 minute final break"
        : "Break duration must be between 0 and 15 minutes" });
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

function distributeEqual(total: number, count: number): number[] {
  const base = Math.floor(total / count);
  const remainder = total % count;
  return Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0));
}

function distributeStepped(total: number, count: number, direction: "increasing" | "decreasing"): number[] {
  const staircase = (count * (count - 1)) / 2;
  if (total < count * 30 + staircase) {
    throw new Error(`The task interval is too short for a strictly ${direction} structure`);
  }
  const shared = Math.floor((total - staircase) / count);
  const remainder = (total - staircase) % count;
  const increasing = Array.from({ length: count }, (_, index) => shared + index + (index >= count - remainder ? 1 : 0));
  return direction === "increasing" ? increasing : increasing.reverse();
}

function segmentDurationRange(segmentType: "focus" | "break") {
  return segmentType === "focus"
    ? { minimum: 30, maximum: Number.POSITIVE_INFINITY }
    : { minimum: 5, maximum: 15 };
}
