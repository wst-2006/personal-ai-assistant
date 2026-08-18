import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { connectVerifiedDatabase } from "@personal-ai/db/client";
import { loadDatabaseConfig } from "@personal-ai/db/config";
import { tasks, unscheduledTaskDayEndRuns, userProfiles } from "@personal-ai/db/schema";
import { eq, inArray } from "drizzle-orm";
import { localDateInTimeZone, UnscheduledTaskWorker } from "./unscheduled-task-worker.js";

const connection = await connectVerifiedDatabase(loadDatabaseConfig());

afterAll(async () => { await connection.client.end(); });

describe("UnscheduledTaskWorker", () => {
  it("uses the Shanghai calendar date instead of the host machine date", () => {
    expect(localDateInTimeZone(new Date("2026-08-10T16:30:00.000Z"))).toBe("2026-08-11");
  });

  it("carries only open formal unscheduled tasks and records one idempotent run", async () => {
    const localDate = "1900-01-11";
    const nextDate = "1900-01-12";
    const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const [eligibleId, backfillId, daypartId, closedId] = ids;
    const [profile] = await connection.db.select().from(userProfiles).where(eq(userProfiles.id, 1)).limit(1);

    try {
      await connection.db.update(userProfiles).set({ unscheduledTaskPolicy: "carry_forward" }).where(eq(userProfiles.id, 1));
      await connection.db.insert(tasks).values([
        { id: eligibleId!, title: "顺移正式任务", recordKind: "formal", lifecycleStatus: "open", scheduleKind: "none", localDate },
        { id: backfillId!, title: "补录不顺移", recordKind: "backfill", lifecycleStatus: "awaiting_outcome", scheduleKind: "none", localDate },
        { id: daypartId!, title: "时段任务不顺移", recordKind: "formal", lifecycleStatus: "open", scheduleKind: "daypart", localDate, daypart: "morning" },
        { id: closedId!, title: "已结束任务不顺移", recordKind: "formal", lifecycleStatus: "closed", scheduleKind: "none", localDate, currentOutcome: "complete" }
      ]);

      const worker = new UnscheduledTaskWorker(connection.db);
      await expect(worker.processNext(new Date("1900-01-12T00:05:00+08:00"))).resolves.toMatchObject({
        localDate,
        policy: "carry_forward",
        carriedCount: 1,
        deletedCount: 0
      });
      await expect(worker.processNext(new Date("1900-01-12T00:06:00+08:00"))).resolves.toBe("idle");

      const rows = await connection.db.select().from(tasks).where(inArray(tasks.id, ids));
      expect(rows.find((task) => task.id === eligibleId)).toMatchObject({ localDate: nextDate, version: 2, scheduleRevision: 2, deletedAt: null });
      expect(rows.find((task) => task.id === backfillId)).toMatchObject({ localDate, deletedAt: null });
      expect(rows.find((task) => task.id === daypartId)).toMatchObject({ localDate, deletedAt: null });
      expect(rows.find((task) => task.id === closedId)).toMatchObject({ localDate, deletedAt: null });
    } finally {
      await connection.db.delete(unscheduledTaskDayEndRuns).where(eq(unscheduledTaskDayEndRuns.localDate, localDate));
      await connection.db.delete(tasks).where(inArray(tasks.id, ids));
      if (profile) await connection.db.update(userProfiles).set({ unscheduledTaskPolicy: profile.unscheduledTaskPolicy }).where(eq(userProfiles.id, 1));
    }
  });

  it("soft-deletes eligible tasks when the user selects automatic day-end deletion", async () => {
    const localDate = "1900-02-21";
    const taskId = randomUUID();
    const [profile] = await connection.db.select().from(userProfiles).where(eq(userProfiles.id, 1)).limit(1);

    try {
      await connection.db.update(userProfiles).set({ unscheduledTaskPolicy: "delete_at_day_end" }).where(eq(userProfiles.id, 1));
      await connection.db.insert(tasks).values({ id: taskId, title: "日终删除任务", recordKind: "formal", lifecycleStatus: "open", scheduleKind: "none", localDate });

      const result = await new UnscheduledTaskWorker(connection.db).processNext(new Date("1900-02-22T00:05:00+08:00"));
      expect(result).toMatchObject({ localDate, policy: "delete_at_day_end", carriedCount: 0, deletedCount: 1 });
      const [task] = await connection.db.select().from(tasks).where(eq(tasks.id, taskId));
      expect(task).toMatchObject({ version: 2, scheduleRevision: 2 });
      expect(task?.deletedAt).toBeInstanceOf(Date);
    } finally {
      await connection.db.delete(unscheduledTaskDayEndRuns).where(eq(unscheduledTaskDayEndRuns.localDate, localDate));
      await connection.db.delete(tasks).where(eq(tasks.id, taskId));
      if (profile) await connection.db.update(userProfiles).set({ unscheduledTaskPolicy: profile.unscheduledTaskPolicy }).where(eq(userProfiles.id, 1));
    }
  });
});
