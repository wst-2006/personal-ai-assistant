import { randomUUID } from "node:crypto";
import { connectVerifiedDatabase } from "@personal-ai/db/client";
import { loadDatabaseConfig } from "@personal-ai/db/config";
import {
  focusSessionOperations,
  focusSessionSegmentRuns,
  focusSessions,
  focusStructureSegments,
  focusStructures,
  focusTimerJobs,
  taskFeedback,
  taskLifecycleEvents,
  taskOutcomes,
  tasks,
  userProfiles
} from "@personal-ai/db/schema";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { FocusCommandConflictError, FocusService, FocusTaskNotScheduledError, FocusTransitionError } from "./focus-service.js";

const connection = await connectVerifiedDatabase(loadDatabaseConfig());
const service = new FocusService(connection.db);
const taskIds: string[] = [];

afterAll(async () => {
  for (const taskId of taskIds) {
    const sessions = await connection.db.select({ id: focusSessions.id }).from(focusSessions)
      .where(eq(focusSessions.taskId, taskId));
    const structures = await connection.db.select({ id: focusStructures.id }).from(focusStructures)
      .where(eq(focusStructures.taskId, taskId));
    await connection.db.delete(taskFeedback).where(eq(taskFeedback.taskId, taskId));
    await connection.db.delete(taskOutcomes).where(eq(taskOutcomes.taskId, taskId));
    await connection.db.delete(taskLifecycleEvents).where(eq(taskLifecycleEvents.taskId, taskId));
    for (const session of sessions) {
      await connection.db.delete(focusSessionOperations).where(eq(focusSessionOperations.focusSessionId, session.id));
      await connection.db.delete(focusTimerJobs).where(eq(focusTimerJobs.focusSessionId, session.id));
      await connection.db.delete(focusSessionSegmentRuns).where(eq(focusSessionSegmentRuns.focusSessionId, session.id));
      await connection.db.delete(focusSessions).where(eq(focusSessions.id, session.id));
    }
    for (const structure of structures) {
      await connection.db.delete(focusStructureSegments).where(eq(focusStructureSegments.focusStructureId, structure.id));
      await connection.db.delete(focusStructures).where(eq(focusStructures.id, structure.id));
    }
    await connection.db.delete(tasks).where(eq(tasks.id, taskId));
  }
  await connection.client.end();
});

describe("focus command idempotency", () => {
  it("rejects an unscheduled task before creating any focus session", async () => {
    const taskId = randomUUID();
    taskIds.push(taskId);
    const [task] = await connection.db.insert(tasks).values({
      id: taskId,
      title: "Unscheduled task must stay outside focus",
      lifecycleStatus: "open",
      scheduleKind: "none",
      localDate: "2099-08-10",
      timeZone: "Asia/Shanghai",
      version: 1,
      scheduleRevision: 1
    }).returning();
    if (!task) throw new Error("test unscheduled task was not created");

    await expect(service.create(task.id, task.version, "prepare", randomUUID())).rejects.toBeInstanceOf(FocusTaskNotScheduledError);
    expect(await connection.db.select().from(focusSessions).where(eq(focusSessions.taskId, task.id))).toHaveLength(0);
  });

  it("rejects a factual backfill before creating any focus session", async () => {
    const taskId = randomUUID();
    taskIds.push(taskId);
    const [task] = await connection.db.insert(tasks).values({
      id: taskId,
      title: "Factual backfill must not start focus",
      recordKind: "backfill",
      lifecycleStatus: "awaiting_outcome",
      scheduleKind: "exact",
      localDate: "2099-08-10",
      startAt: new Date("2099-08-10T01:00:00.000Z"),
      endAt: new Date("2099-08-10T02:00:00.000Z"),
      timeZone: "Asia/Shanghai",
      version: 1,
      scheduleRevision: 1
    }).returning();
    if (!task) throw new Error("test backfill was not created");

    await expect(service.create(task.id, task.version, "prepare", randomUUID())).rejects.toBeInstanceOf(FocusTransitionError);
    expect(await connection.db.select().from(focusSessions).where(eq(focusSessions.taskId, task.id))).toHaveLength(0);
  });

  it("replays one create command without creating a second session or operation", async () => {
    const taskId = randomUUID();
    const commandId = randomUUID();
    taskIds.push(taskId);
    const [task] = await connection.db.insert(tasks).values({
      id: taskId,
      title: "Focus idempotency integration test",
      lifecycleStatus: "open",
      scheduleKind: "exact",
      localDate: "2099-08-10",
      startAt: new Date("2099-08-10T01:00:00.000Z"),
      endAt: new Date("2099-08-10T02:00:00.000Z"),
      timeZone: "Asia/Shanghai",
      version: 1,
      scheduleRevision: 1
    }).returning();
    if (!task) throw new Error("test task was not created");

    const first = await service.create(task.id, task.version, "remind", commandId);
    const replay = await service.create(task.id, task.version, "remind", commandId);

    expect(replay.id).toBe(first.id);
    expect(await connection.db.select().from(focusSessions).where(eq(focusSessions.taskId, task.id))).toHaveLength(1);
    expect(await connection.db.select().from(focusSessionOperations).where(eq(focusSessionOperations.commandId, commandId))).toHaveLength(1);
    await expect(service.respondToReminder(first.id, first.version, "start", commandId))
      .rejects.toBeInstanceOf(FocusCommandConflictError);
  });

  it("keeps actual focus time when an ended session is evaluated as not completed", async () => {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    taskIds.push(taskId);
    await connection.db.insert(tasks).values({
      id: taskId,
      title: "Outcome must not erase elapsed focus",
      lifecycleStatus: "awaiting_outcome",
      scheduleKind: "none",
      localDate: "2099-08-10",
      timeZone: "Asia/Shanghai",
      version: 1,
      scheduleRevision: 1
    });
    await connection.db.insert(focusSessions).values({
      id: sessionId,
      taskId,
      state: "ended",
      rawActiveSeconds: 1800,
      effectiveFocusSeconds: 0,
      endedAt: new Date("2099-08-10T02:00:00.000Z"),
      version: 1
    });

    const evaluated = await service.evaluate(sessionId, 1, "not_completed", 0, "neutral");

    expect(evaluated.state).toBe("evaluated");
    expect(evaluated.effectiveFocusSeconds).toBe(1800);
  });

  it("moves an active task to awaiting outcome when the final rest is skipped", async () => {
    const taskId = randomUUID();
    const structureId = randomUUID();
    const sessionId = randomUUID();
    const now = new Date();
    const plannedStartAt = new Date("2099-08-10T01:00:00.000Z");
    const plannedEndAt = new Date("2099-08-10T02:00:00.000Z");
    const startedAt = new Date(now.getTime() - 55.5 * 60_000);
    const breakStartedAt = new Date(now.getTime() - 30_000);
    taskIds.push(taskId);

    await connection.db.insert(tasks).values({
      id: taskId,
      title: "Skipping final rest must end execution",
      lifecycleStatus: "active",
      scheduleKind: "exact",
      localDate: "2099-08-10",
      startAt: plannedStartAt,
      endAt: plannedEndAt,
      timeZone: "Asia/Shanghai",
      version: 1,
      scheduleRevision: 1
    });
    await connection.db.insert(focusStructures).values({
      id: structureId,
      taskId,
      taskScheduleRevision: 1,
      state: "active",
      source: "manual",
      mode: "segmented",
      version: 1,
      totalStartAt: plannedStartAt,
      totalEndAt: plannedEndAt,
      confirmedAt: plannedStartAt
    });
    await connection.db.insert(focusStructureSegments).values([
      { id: randomUUID(), focusStructureId: structureId, position: 0, segmentType: "focus", durationMinutes: 55 },
      { id: randomUUID(), focusStructureId: structureId, position: 1, segmentType: "break", durationMinutes: 5 }
    ]);
    await connection.db.insert(focusSessions).values({
      id: sessionId,
      taskId,
      focusStructureId: structureId,
      focusStructureVersion: 1,
      focusStructureScheduleRevision: 1,
      state: "running",
      plannedStartAt,
      plannedEndAt,
      startedAt,
      activeSinceAt: breakStartedAt,
      currentSegmentPosition: 1,
      currentSegmentStartedAt: breakStartedAt,
      rawActiveSeconds: 3300,
      effectiveFocusSeconds: 0,
      version: 1
    });
    await connection.db.insert(focusSessionSegmentRuns).values([
      {
        id: randomUUID(),
        focusSessionId: sessionId,
        position: 0,
        segmentType: "focus",
        plannedDurationSeconds: 3300,
        elapsedSeconds: 3300,
        startedAt,
        completedAt: breakStartedAt
      },
      {
        id: randomUUID(),
        focusSessionId: sessionId,
        position: 1,
        segmentType: "break",
        plannedDurationSeconds: 300,
        elapsedSeconds: 0,
        startedAt: breakStartedAt
      }
    ]);

    const ended = await service.skipFinalBreak(sessionId, 1, randomUUID());
    const [task] = await connection.db.select().from(tasks).where(eq(tasks.id, taskId));
    const outcomes = await connection.db.select().from(taskOutcomes).where(eq(taskOutcomes.taskId, taskId));

    expect(ended).toMatchObject({ state: "ended", effectiveFocusSeconds: 3300, stoppedReason: "用户跳过最后休息" });
    expect(task?.lifecycleStatus).toBe("awaiting_outcome");
    expect(outcomes).toHaveLength(0);
  });

  it("completes objectively without writing subjective feedback when evaluation is disabled", async () => {
    const taskId = randomUUID();
    const structureId = randomUUID();
    const sessionId = randomUUID();
    const now = new Date();
    const plannedStartAt = new Date("2099-08-10T01:00:00.000Z");
    const plannedEndAt = new Date("2099-08-10T02:00:00.000Z");
    const startedAt = new Date(now.getTime() - 55.5 * 60_000);
    const breakStartedAt = new Date(now.getTime() - 30_000);
    taskIds.push(taskId);
    const [profile] = await connection.db.select().from(userProfiles).where(eq(userProfiles.id, 1)).limit(1);
    if (!profile) throw new Error("primary user profile is missing");

    try {
      await connection.db.update(userProfiles).set({
        desktopFocusEnabled: true,
        focusEvaluationEnabled: false,
        version: profile.version + 1,
      }).where(eq(userProfiles.id, profile.id));
      await connection.db.insert(tasks).values({
        id: taskId,
        title: "Evaluation-disabled focus completion",
        lifecycleStatus: "active",
        scheduleKind: "exact",
        localDate: "2099-08-10",
        startAt: plannedStartAt,
        endAt: plannedEndAt,
        timeZone: "Asia/Shanghai",
        version: 1,
        scheduleRevision: 1
      });
      await connection.db.insert(focusStructures).values({
        id: structureId,
        taskId,
        taskScheduleRevision: 1,
        state: "active",
        source: "manual",
        mode: "segmented",
        version: 1,
        totalStartAt: plannedStartAt,
        totalEndAt: plannedEndAt,
        confirmedAt: plannedStartAt
      });
      await connection.db.insert(focusStructureSegments).values([
        { id: randomUUID(), focusStructureId: structureId, position: 0, segmentType: "focus", durationMinutes: 55 },
        { id: randomUUID(), focusStructureId: structureId, position: 1, segmentType: "break", durationMinutes: 5 }
      ]);
      await connection.db.insert(focusSessions).values({
        id: sessionId,
        taskId,
        focusStructureId: structureId,
        focusStructureVersion: 1,
        focusStructureScheduleRevision: 1,
        state: "running",
        plannedStartAt,
        plannedEndAt,
        startedAt,
        activeSinceAt: breakStartedAt,
        currentSegmentPosition: 1,
        currentSegmentStartedAt: breakStartedAt,
        rawActiveSeconds: 3300,
        effectiveFocusSeconds: 0,
        version: 1
      });
      await connection.db.insert(focusSessionSegmentRuns).values([
        {
          id: randomUUID(),
          focusSessionId: sessionId,
          position: 0,
          segmentType: "focus",
          plannedDurationSeconds: 3300,
          elapsedSeconds: 3300,
          startedAt,
          completedAt: breakStartedAt
        },
        {
          id: randomUUID(),
          focusSessionId: sessionId,
          position: 1,
          segmentType: "break",
          plannedDurationSeconds: 300,
          elapsedSeconds: 0,
          startedAt: breakStartedAt
        }
      ]);

      const evaluated = await service.skipFinalBreak(sessionId, 1, randomUUID());
      const [task] = await connection.db.select().from(tasks).where(eq(tasks.id, taskId));
      const outcomes = await connection.db.select().from(taskOutcomes).where(eq(taskOutcomes.taskId, taskId));
      const feedback = await connection.db.select().from(taskFeedback).where(eq(taskFeedback.taskId, taskId));

      expect(evaluated).toMatchObject({ state: "evaluated", effectiveFocusSeconds: 3300 });
      expect(task).toMatchObject({ lifecycleStatus: "closed", currentOutcome: "complete" });
      expect(outcomes).toEqual([expect.objectContaining({
        focusSessionId: sessionId,
        outcome: "complete",
        progressPercent: 100,
        source: "system",
      })]);
      expect(feedback).toHaveLength(0);
    } finally {
      await connection.db.update(userProfiles).set({
        desktopFocusEnabled: profile.desktopFocusEnabled,
        focusEvaluationEnabled: profile.focusEvaluationEnabled,
        version: profile.version + 2,
      }).where(eq(userProfiles.id, profile.id));
    }
  });

  it("keeps the latest-ended evaluation in front of a background running task", async () => {
    const olderTaskId = randomUUID();
    const runningTaskId = randomUUID();
    const latestTaskId = randomUUID();
    taskIds.push(olderTaskId, runningTaskId, latestTaskId);
    await connection.db.insert(tasks).values([
      {
        id: olderTaskId,
        title: "Older pending evaluation",
        lifecycleStatus: "awaiting_outcome",
        scheduleKind: "none",
        localDate: "2099-08-10",
        timeZone: "Asia/Shanghai",
        version: 1,
        scheduleRevision: 1
      },
      {
        id: runningTaskId,
        title: "Background running task",
        lifecycleStatus: "active",
        scheduleKind: "exact",
        localDate: "2099-08-10",
        startAt: new Date("2099-08-10T01:00:00.000Z"),
        endAt: new Date("2099-08-10T02:00:00.000Z"),
        timeZone: "Asia/Shanghai",
        version: 1,
        scheduleRevision: 1
      },
      {
        id: latestTaskId,
        title: "Latest pending evaluation",
        lifecycleStatus: "awaiting_outcome",
        scheduleKind: "none",
        localDate: "2099-08-10",
        timeZone: "Asia/Shanghai",
        version: 1,
        scheduleRevision: 1
      }
    ]);
    await connection.db.insert(focusSessions).values([
      {
        id: randomUUID(),
        taskId: olderTaskId,
        state: "ended",
        endedAt: new Date("2099-08-10T01:00:00.000Z"),
        rawActiveSeconds: 1500,
        effectiveFocusSeconds: 1500,
        version: 1,
        updatedAt: new Date("2099-08-10T01:00:00.000Z")
      },
      {
        id: randomUUID(),
        taskId: runningTaskId,
        state: "running",
        plannedStartAt: new Date("2099-08-10T01:00:00.000Z"),
        plannedEndAt: new Date("2099-08-10T02:00:00.000Z"),
        startedAt: new Date("2099-08-10T01:00:00.000Z"),
        activeSinceAt: new Date("2099-08-10T01:00:00.000Z"),
        rawActiveSeconds: 0,
        effectiveFocusSeconds: 0,
        version: 1,
        updatedAt: new Date("2099-08-10T01:30:00.000Z")
      },
      {
        id: randomUUID(),
        taskId: latestTaskId,
        state: "ended",
        endedAt: new Date("2099-08-10T01:20:00.000Z"),
        rawActiveSeconds: 1200,
        effectiveFocusSeconds: 1200,
        version: 1,
        updatedAt: new Date("2099-08-10T01:20:00.000Z")
      }
    ]);

    const current = await service.current();
    expect(current?.taskId).toBe(latestTaskId);
    expect(current?.state).toBe("ended");
  });
});
