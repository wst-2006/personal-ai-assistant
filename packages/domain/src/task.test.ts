import { describe, expect, it } from "vitest";
import { extractPlanInstruction, inferPlanInstructionDate, isTaskOutcomeCompleted, isWithinProductScheduleWindow, naturalLanguageTaskCandidateSchema, taskBackfillInputSchema, taskInputSchema, taskOutcomeInputSchema } from "./task.js";

describe("task outcome completion", () => {
  it("treats complete and partial as completed, but not not_completed", () => {
    expect(isTaskOutcomeCompleted("complete")).toBe(true);
    expect(isTaskOutcomeCompleted("partial")).toBe(true);
    expect(isTaskOutcomeCompleted("not_completed")).toBe(false);
    expect(isTaskOutcomeCompleted(null)).toBe(false);
  });
});

const exactTask = {
  title: "Deep work",
  scheduleKind: "exact" as const,
  startAt: "2026-07-27T09:00:00+08:00",
  endAt: "2026-07-27T10:00:00+08:00",
  timeZone: "Asia/Shanghai"
};

describe("plan instruction routing", () => {
  it("accepts a colon or a space after the plan marker without capturing ordinary task titles", () => {
    expect(extractPlanInstruction("计划：把所有任务往后延半小时")).toBe("把所有任务往后延半小时");
    expect(extractPlanInstruction("计划 把所有任务往后延半小时")).toBe("把所有任务往后延半小时");
    expect(extractPlanInstruction("计划")).toBe("");
    expect(extractPlanInstruction("计划经济学作业")).toBeNull();
  });

  it("infers bounded relative dates but leaves open-ended ranges for explicit confirmation", () => {
    expect(inferPlanInstructionDate("计划：把今天所有任务往后延半小时", "2026-08-19")).toBe("2026-08-19");
    expect(inferPlanInstructionDate("计划 明天的任务提前半小时", "2026-08-19")).toBe("2026-08-20");
    expect(inferPlanInstructionDate("计划：后天全部任务顺延半小时", "2026-08-19")).toBe("2026-08-21");
    expect(inferPlanInstructionDate("计划：从今天起所有任务顺延半小时", "2026-08-19")).toBeNull();
    expect(inferPlanInstructionDate("计划：调整 2026-08-23 的任务", "2026-08-19")).toBe("2026-08-23");
  });
});

describe("task scheduling validation", () => {
  it("derives exact dates on the server by rejecting client localDate", () => {
    const result = taskInputSchema.safeParse({ ...exactTask, localDate: "2026-07-27" });
    expect(result.success).toBe(false);
  });

  it("requires exact timestamps as a pair and in ascending order", () => {
    expect(taskInputSchema.safeParse({ ...exactTask, endAt: undefined }).success).toBe(false);
    expect(taskInputSchema.safeParse({ ...exactTask, endAt: exactTask.startAt }).success).toBe(false);
  });

  it("enforces 30-minute boundaries and a 30-minute minimum", () => {
    expect(taskInputSchema.safeParse({
      ...exactTask,
      startAt: "2026-07-27T09:15:00+08:00",
      endAt: "2026-07-27T10:15:00+08:00"
    }).success).toBe(false);
    expect(taskInputSchema.safeParse({
      ...exactTask,
      endAt: "2026-07-27T09:15:00+08:00"
    }).success).toBe(false);
    expect(taskInputSchema.safeParse({
      ...exactTask,
      startAt: "2026-07-27T09:00:30+08:00"
    }).success).toBe(false);
    expect(taskInputSchema.safeParse({
      ...exactTask,
      endAt: "2026-07-27T09:30:00+08:00"
    }).success).toBe(true);
  });

  it("rejects exact tasks that cross midnight in their IANA time zone", () => {
    const result = taskInputSchema.safeParse({
      ...exactTask,
      startAt: "2026-07-27T23:30:00+08:00",
      endAt: "2026-07-28T00:30:00+08:00"
    });
    expect(result.success).toBe(false);
  });

  it("defines the product scheduling window as 07:00 through 23:00", () => {
    expect(isWithinProductScheduleWindow("2026-07-27T07:00:00+08:00", "2026-07-27T23:00:00+08:00", "Asia/Shanghai")).toBe(true);
    expect(isWithinProductScheduleWindow("2026-07-27T06:30:00+08:00", "2026-07-27T07:30:00+08:00", "Asia/Shanghai")).toBe(false);
    expect(isWithinProductScheduleWindow("2026-07-27T22:30:00+08:00", "2026-07-27T23:30:00+08:00", "Asia/Shanghai")).toBe(false);
  });

  it("rejects task entry types because ideas and questions use the inbox API", () => {
    expect(taskInputSchema.safeParse({ ...exactTask, entryType: "idea" }).success).toBe(false);
    expect(taskInputSchema.safeParse({ ...exactTask, entryType: "question" }).success).toBe(false);
  });

  it("validates daypart and unscheduled shapes independently", () => {
    expect(taskInputSchema.safeParse({
      title: "Read",
      scheduleKind: "daypart",
      localDate: "2026-07-27",
      daypart: "morning"
    }).success).toBe(true);
    expect(taskInputSchema.safeParse({
      title: "Read",
      scheduleKind: "none",
      daypart: "morning"
    }).success).toBe(false);
  });

  it("requires a valid IANA time zone", () => {
    expect(taskInputSchema.safeParse({ ...exactTask, timeZone: "Shanghai-ish" }).success).toBe(false);
  });

  it("keeps same-day backfill limited to exact timeline intervals", () => {
    expect(taskBackfillInputSchema.safeParse(exactTask).success).toBe(true);
    expect(taskBackfillInputSchema.safeParse({
      title: "Backfill a rough period",
      scheduleKind: "daypart",
      localDate: "2026-07-27",
      daypart: "morning"
    }).success).toBe(false);
  });
});

describe("AI candidate validation", () => {
  const candidate = {
    title: "Read the paper",
    entryType: "task" as const,
    date: "2026-07-27",
    startAt: "2026-07-27T09:00:00+08:00",
    endAt: "2026-07-27T10:00:00+08:00",
    schedulePrecision: "exact" as const,
    notes: null,
    missingFields: ["notes"] as const
  };

  it("uses task timing only and 30-minute exact boundaries", () => {
    expect(naturalLanguageTaskCandidateSchema.safeParse(candidate).success).toBe(true);
    expect(naturalLanguageTaskCandidateSchema.safeParse({ ...candidate, endAt: "2026-07-27T09:45:00+08:00" }).success).toBe(false);
    expect(naturalLanguageTaskCandidateSchema.safeParse({ ...candidate, estimatedMinutes: 45 }).success).toBe(false);
    expect(naturalLanguageTaskCandidateSchema.safeParse({ ...candidate, plannedEffortMinutes: 45 }).success).toBe(false);
  });

  it("allows an exact candidate to wait for a declared missing duration", () => {
    expect(naturalLanguageTaskCandidateSchema.safeParse({
      ...candidate,
      endAt: null,
      missingFields: ["endAt"]
    }).success).toBe(true);
    expect(naturalLanguageTaskCandidateSchema.safeParse({
      ...candidate,
      endAt: null,
      missingFields: []
    }).success).toBe(false);
  });

  it("keeps ideas and questions free of task-only fields", () => {
    const idea = { ...candidate, entryType: "idea", date: null, startAt: null, endAt: null, schedulePrecision: null, missingFields: [] };
    expect(naturalLanguageTaskCandidateSchema.safeParse(idea).success).toBe(true);
    expect(naturalLanguageTaskCandidateSchema.safeParse({ ...idea, plannedEffortMinutes: 30 }).success).toBe(false);
  });
});

describe("task outcome validation", () => {
  it.each([
    ["not_completed", 0, true],
    ["not_completed", 1, false],
    ["partial", 1, true],
    ["partial", 99, true],
    ["partial", 100, false],
    ["complete", 100, true],
    ["complete", 99, false]
  ] as const)("validates %s at %i%%", (outcome, progressPercent, valid) => {
    const result = taskOutcomeInputSchema.safeParse({
      expectedVersion: 1,
      outcome,
      progressPercent,
      satisfaction: "neutral"
    });
    expect(result.success).toBe(valid);
  });

  it("requires subjective satisfaction for a manual app outcome but keeps system recovery independent", () => {
    expect(taskOutcomeInputSchema.safeParse({
      expectedVersion: 1,
      outcome: "complete",
      progressPercent: 100,
      source: "app"
    }).success).toBe(false);
    expect(taskOutcomeInputSchema.safeParse({
      expectedVersion: 1,
      outcome: "not_completed",
      progressPercent: 0,
      source: "system"
    }).success).toBe(true);
  });
});
