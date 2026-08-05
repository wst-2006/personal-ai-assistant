import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { connectVerifiedDatabase } from "@personal-ai/db/client";
import { loadDatabaseConfig } from "@personal-ai/db/config";
import { desktopCommandRequests, tasks } from "@personal-ai/db/schema";
import { eq } from "drizzle-orm";

test("飞书打开任务命令只在 Windows 软件加载对应任务后完成", async ({ page }) => {
  const taskId = randomUUID();
  const commandId = randomUUID();
  const title = `E2E 飞书打开桌面任务 ${Date.now().toString(36)}`;
  const { client, db } = await connectVerifiedDatabase(loadDatabaseConfig());

  try {
    await db.insert(tasks).values({
      id: taskId,
      title,
      lifecycleStatus: "open",
      scheduleKind: "none",
      localDate: new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
      }).format(new Date()),
      timeZone: "Asia/Shanghai",
      version: 1,
      scheduleRevision: 1
    });
    await db.insert(desktopCommandRequests).values({
      id: commandId,
      kind: "open_task",
      taskId,
      scheduleRevision: 1,
      status: "pending",
      expiresAt: new Date(Date.now() + 10 * 60_000)
    });

    await page.addInitScript(() => {
      Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
    });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();

    await expect.poll(async () => {
      const [command] = await db.select().from(desktopCommandRequests).where(eq(desktopCommandRequests.id, commandId));
      return command ? { status: command.status, claimedBy: command.claimedBy } : null;
    }).toEqual({ status: "completed", claimedBy: expect.stringMatching(/^desktop-/) });

    await page.reload();
    await expect(page.getByRole("heading", { name: "把今天放回时间里。", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: title, exact: true })).toHaveCount(0);
  } finally {
    await db.delete(desktopCommandRequests).where(eq(desktopCommandRequests.id, commandId));
    await db.delete(tasks).where(eq(tasks.id, taskId));
    await client.end();
  }
});
