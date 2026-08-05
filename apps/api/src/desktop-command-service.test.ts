import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { connectVerifiedDatabase } from "@personal-ai/db/client";
import { loadDatabaseConfig } from "@personal-ai/db/config";
import { desktopCommandRequests, tasks } from "@personal-ai/db/schema";
import { DesktopCommandService } from "./desktop-command-service.js";

const connection = await connectVerifiedDatabase(loadDatabaseConfig());
const service = new DesktopCommandService(connection.db);
const taskIds: string[] = [];

afterAll(async () => {
  for (const taskId of taskIds) {
    await connection.db.delete(desktopCommandRequests).where(eq(desktopCommandRequests.taskId, taskId));
    await connection.db.delete(tasks).where(eq(tasks.id, taskId));
  }
  await connection.client.end();
});

async function createTask() {
  const id = randomUUID();
  taskIds.push(id);
  await connection.db.insert(tasks).values({
    id,
    title: `Desktop command ${id}`,
    lifecycleStatus: "open",
    scheduleKind: "none",
    timeZone: "Asia/Shanghai",
    version: 1,
    scheduleRevision: 1
  });
  return id;
}

describe("desktop command persistence", () => {
  it("keeps an open-task request durable until the same desktop client completes it", async () => {
    const taskId = await createTask();
    const created = await service.requestOpenTask(taskId, 1);

    const claimed = await service.claimNext("desktop-client-a");
    expect(claimed).toMatchObject({ id: created.id, taskId, kind: "open_task", status: "claimed", claimedBy: "desktop-client-a" });
    await expect(service.claimNext("desktop-client-a")).resolves.toMatchObject({ id: created.id });
    await expect(service.claimNext("desktop-client-b")).resolves.toBeNull();

    await expect(service.complete(created.id, "desktop-client-a")).resolves.toBe(true);
    await expect(service.complete(created.id, "desktop-client-a")).resolves.toBe(true);
    await expect(service.claimNext("desktop-client-a")).resolves.toBeNull();
  });

  it("expires a request whose task schedule revision has changed", async () => {
    const taskId = await createTask();
    const created = await service.requestOpenTask(taskId, 1);
    await connection.db.update(tasks).set({ scheduleRevision: 2 }).where(eq(tasks.id, taskId));

    await expect(service.claimNext("desktop-client-stale")).resolves.toBeNull();
    const [stored] = await connection.db.select().from(desktopCommandRequests).where(eq(desktopCommandRequests.id, created.id));
    expect(stored?.status).toBe("expired");
  });
});
