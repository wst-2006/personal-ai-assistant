import { randomUUID } from "node:crypto";
import { connectVerifiedDatabase } from "@personal-ai/db/client";
import { loadDatabaseConfig } from "@personal-ai/db/config";
import { focusStructureSegments, focusStructures, tasks } from "@personal-ai/db/schema";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { FocusStructureService, FocusStructureTaskConflictError, InvalidFocusStructureError } from "./focus-structure-service.js";

const connection = await connectVerifiedDatabase(loadDatabaseConfig());
const service = new FocusStructureService(connection.db);
const cleanupIds: string[] = [];

afterAll(async () => {
  for (const taskId of cleanupIds) {
    const structures = await connection.db.select({ id: focusStructures.id }).from(focusStructures).where(eq(focusStructures.taskId, taskId));
    for (const structure of structures) {
      await connection.db.delete(focusStructureSegments).where(eq(focusStructureSegments.focusStructureId, structure.id));
      await connection.db.delete(focusStructures).where(eq(focusStructures.id, structure.id));
    }
    await connection.db.delete(tasks).where(eq(tasks.id, taskId));
  }
  await connection.client.end();
});

describe("focus structure persistence", () => {
  it("rejects focus structures for factual backfill records", async () => {
    const taskId = randomUUID();
    cleanupIds.push(taskId);
    const [task] = await connection.db.insert(tasks).values({
      id: taskId,
      title: "Backfill structure guard test",
      recordKind: "backfill",
      lifecycleStatus: "awaiting_outcome",
      scheduleKind: "exact",
      localDate: "2099-07-27",
      startAt: new Date("2099-07-27T01:00:00.000Z"),
      endAt: new Date("2099-07-27T02:00:00.000Z"),
      timeZone: "Asia/Shanghai",
      version: 1,
      scheduleRevision: 1
    }).returning();
    if (!task) throw new Error("test backfill was not created");

    await expect(service.createCandidate({
      taskId,
      taskVersion: task.version,
      taskScheduleRevision: task.scheduleRevision,
      source: "manual",
      mode: "continuous",
      totalStartAt: task.startAt!.toISOString(),
      totalEndAt: task.endAt!.toISOString(),
      breakMinutes: 5
    })).rejects.toBeInstanceOf(InvalidFocusStructureError);
    expect(await service.list(taskId)).toHaveLength(0);
  });

  it("stores a continuous candidate and confirms one active structure", async () => {
    const taskId = randomUUID();
    cleanupIds.push(taskId);
    const [task] = await connection.db.insert(tasks).values({
      id: taskId,
      title: "Structure integration test",
      lifecycleStatus: "open",
      scheduleKind: "exact",
      localDate: "2099-07-27",
      startAt: new Date("2099-07-27T01:00:00.000Z"),
      endAt: new Date("2099-07-27T02:00:00.000Z"),
      timeZone: "Asia/Shanghai",
      version: 1,
      scheduleRevision: 1
    }).returning();
    if (!task) throw new Error("test task was not created");

    const candidate = await service.createCandidate({
      taskId,
      taskVersion: task.version,
      taskScheduleRevision: task.scheduleRevision,
      source: "manual",
      mode: "continuous",
      totalStartAt: task.startAt!.toISOString(),
      totalEndAt: task.endAt!.toISOString(),
      breakMinutes: 5
    });
    expect(candidate.structure.state).toBe("candidate");
    expect(candidate.segments.map((segment) => [segment.segmentType, segment.durationMinutes])).toEqual([
      ["focus", 55], ["break", 5]
    ]);

    const replacement = await service.createCandidate({
      taskId,
      taskVersion: task.version,
      taskScheduleRevision: task.scheduleRevision,
      source: "manual",
      mode: "continuous",
      totalStartAt: task.startAt!.toISOString(),
      totalEndAt: task.endAt!.toISOString(),
      breakMinutes: 5
    });
    expect((await service.list(taskId)).find((item) => item.structure.id === candidate.structure.id)?.structure.state)
      .toBe("cancelled");

    const active = await service.confirm(replacement.structure.id, replacement.structure.version, task.version, task.scheduleRevision);
    expect(active.structure.state).toBe("active");
    expect(active.structure.version).toBe(2);
    expect((await service.list(taskId)).filter((item) => item.structure.state === "candidate")).toHaveLength(0);
  });

  it("rejects a candidate when the task schedule revision changed", async () => {
    const taskId = randomUUID();
    cleanupIds.push(taskId);
    const [task] = await connection.db.insert(tasks).values({
      id: taskId,
      title: "Stale structure test",
      lifecycleStatus: "open",
      scheduleKind: "exact",
      localDate: "2099-07-27",
      startAt: new Date("2099-07-27T03:00:00.000Z"),
      endAt: new Date("2099-07-27T04:00:00.000Z"),
      timeZone: "Asia/Shanghai",
      version: 1,
      scheduleRevision: 1
    }).returning();
    if (!task) throw new Error("test task was not created");
    await connection.db.update(tasks).set({ version: 2, scheduleRevision: 2 }).where(and(eq(tasks.id, taskId), eq(tasks.version, 1)));
    await expect(service.createCandidate({
      taskId,
      taskVersion: task.version,
      taskScheduleRevision: task.scheduleRevision,
      source: "template",
      mode: "continuous",
      totalStartAt: task.startAt!.toISOString(),
      totalEndAt: task.endAt!.toISOString(),
      breakMinutes: 5
    })).rejects.toBeInstanceOf(FocusStructureTaskConflictError);
  });

  it("persists a segmented candidate across reads and explicitly cancels it", async () => {
    const taskId = randomUUID();
    cleanupIds.push(taskId);
    const [task] = await connection.db.insert(tasks).values({
      id: taskId,
      title: "Candidate recovery test",
      lifecycleStatus: "open",
      scheduleKind: "exact",
      localDate: "2099-07-27",
      startAt: new Date("2099-07-27T05:00:00.000Z"),
      endAt: new Date("2099-07-27T06:30:00.000Z"),
      timeZone: "Asia/Shanghai",
      version: 1,
      scheduleRevision: 1
    }).returning();
    if (!task) throw new Error("test task was not created");

    const candidate = await service.createCandidate({
      taskId,
      taskVersion: task.version,
      taskScheduleRevision: task.scheduleRevision,
      source: "template",
      mode: "segmented",
      totalStartAt: task.startAt!.toISOString(),
      totalEndAt: task.endAt!.toISOString(),
      breakMinutes: 5,
      segments: [
        { segmentType: "focus", durationMinutes: 40 },
        { segmentType: "break", durationMinutes: 5 },
        { segmentType: "focus", durationMinutes: 40 },
        { segmentType: "break", durationMinutes: 5 }
      ]
    });
    const recovered = (await service.list(taskId)).find((item) => item.structure.id === candidate.structure.id);
    expect(recovered?.structure.state).toBe("candidate");
    expect(recovered?.segments).toHaveLength(4);

    const cancelled = await service.cancel(candidate.structure.id, candidate.structure.version);
    expect(cancelled.structure.state).toBe("cancelled");
    expect(cancelled.structure.version).toBe(2);
  });

  it("persists a validated AI plan only as an unconfirmed candidate", async () => {
    const taskId = randomUUID();
    cleanupIds.push(taskId);
    const [task] = await connection.db.insert(tasks).values({
      id: taskId,
      title: "AI focus candidate test",
      lifecycleStatus: "open",
      scheduleKind: "exact",
      localDate: "2099-07-27",
      startAt: new Date("2099-07-27T07:00:00.000Z"),
      endAt: new Date("2099-07-27T08:30:00.000Z"),
      timeZone: "Asia/Shanghai",
      version: 1,
      scheduleRevision: 1
    }).returning();
    if (!task) throw new Error("test task was not created");

    const candidate = await service.createAiCandidate({
      taskId,
      taskVersion: task.version,
      taskScheduleRevision: task.scheduleRevision,
      instructions: "前短后长"
    }, { plan: async () => [
      { segmentType: "focus", durationMinutes: 35 },
      { segmentType: "break", durationMinutes: 5 },
      { segmentType: "focus", durationMinutes: 45 },
      { segmentType: "break", durationMinutes: 5 }
    ] });
    expect(candidate.structure).toMatchObject({ state: "candidate", source: "ai" });
    expect((await service.list(taskId)).filter((item) => item.structure.state === "active")).toHaveLength(0);
  });
});
