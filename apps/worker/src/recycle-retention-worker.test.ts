import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { connectVerifiedDatabase } from "@personal-ai/db/client";
import { loadDatabaseConfig } from "@personal-ai/db/config";
import { tasks, userProfiles } from "@personal-ai/db/schema";
import { RecycleRetentionWorker } from "./recycle-retention-worker.js";

const connection = await connectVerifiedDatabase(loadDatabaseConfig());

afterAll(async () => { await connection.client.end(); });

describe("RecycleRetentionWorker", () => {
  it("permanently purges only tasks older than the persisted retention window", async () => {
    const expiredId = randomUUID();
    const recentId = randomUUID();
    const [profile] = await connection.db.select().from(userProfiles).where(eq(userProfiles.id, 1)).limit(1);
    try {
      await connection.db.update(userProfiles).set({ recycleRetentionDays: 3 }).where(eq(userProfiles.id, 1));
      await connection.db.insert(tasks).values([
        { id: expiredId, title: "已过期回收任务", recordKind: "formal", lifecycleStatus: "open", scheduleKind: "none", deletedAt: new Date("2000-03-01T00:00:00.000Z") },
        { id: recentId, title: "仍可恢复任务", recordKind: "formal", lifecycleStatus: "open", scheduleKind: "none", deletedAt: new Date("2000-03-04T00:00:01.000Z") }
      ]);
      await expect(new RecycleRetentionWorker(connection.db).processNext(new Date("2000-03-07T00:00:00.000Z"))).resolves.toMatchObject({ purgedCount: 1, retentionDays: 3 });
      expect((await connection.db.select().from(tasks).where(eq(tasks.id, expiredId))).length).toBe(0);
      expect((await connection.db.select().from(tasks).where(eq(tasks.id, recentId))).length).toBe(1);
    } finally {
      await connection.db.delete(tasks).where(eq(tasks.id, expiredId));
      await connection.db.delete(tasks).where(eq(tasks.id, recentId));
      if (profile) await connection.db.update(userProfiles).set({ recycleRetentionDays: profile.recycleRetentionDays }).where(eq(userProfiles.id, 1));
    }
  });
});
