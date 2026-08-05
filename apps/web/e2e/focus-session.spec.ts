import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { connectVerifiedDatabase } from "@personal-ai/db/client";
import { loadDatabaseConfig } from "@personal-ai/db/config";
import { focusSessionSegmentRuns, focusSessions, focusStructureSegments, focusStructures, focusTimerJobs, reminderJobs, tasks } from "@personal-ai/db/schema";
import { and, eq, inArray, like } from "drizzle-orm";
import { FocusTimerWorker } from "../../worker/src/focus-worker.js";
import { ReminderWorker } from "../../worker/src/worker-core.js";

const apiBase = process.env.PLAYWRIGHT_API_BASE_URL ?? "http://127.0.0.1:3100";

async function cleanup(request:APIRequestContext, id:string) {
  const current=await request.get(`${apiBase}/api/v1/focus-sessions/current`);
  if(current.ok()) {
    const session=(await current.json()).session as {id:string;taskId:string;state:string;version:number}|null;
    if(session?.taskId===id && ["scheduled","reminded","preparing"].includes(session.state)) {
      await request.post(`${apiBase}/api/v1/focus-sessions/${session.id}/other-arrangement`,{data:{expectedVersion:session.version,reason:"focus e2e cleanup"}});
    } else if(session?.taskId===id && session.state==="running") {
      const ended=await request.post(`${apiBase}/api/v1/focus-sessions/${session.id}/end`,{data:{expectedVersion:session.version,reason:"focus e2e cleanup"}});
      if(ended.ok()) {
        const value=(await ended.json()).session as {version:number};
        await request.post(`${apiBase}/api/v1/focus-sessions/${session.id}/evaluate`,{data:{expectedVersion:value.version,outcome:"not_completed",progressPercent:0,satisfaction:"neutral",note:"focus e2e cleanup"}});
      }
    } else if(session?.taskId===id && session.state==="ended") {
      await request.post(`${apiBase}/api/v1/focus-sessions/${session.id}/evaluate`,{data:{expectedVersion:session.version,outcome:"not_completed",progressPercent:0,satisfaction:"neutral",note:"focus e2e cleanup"}});
    }
  }
  const detail=await request.get(`${apiBase}/api/v1/tasks/${id}`);
  if(!detail.ok()) return;
  const task=(await detail.json()).task as {version:number};
  await request.delete(`${apiBase}/api/v1/tasks/${id}`,{data:{expectedVersion:task.version,reason:"focus e2e cleanup"}});
}

async function expirePreparation(id: string) {
  const { client, db } = await connectVerifiedDatabase(loadDatabaseConfig());
  try {
    await db.update(focusSessions).set({ preparingEndsAt: new Date(Date.now() - 1_000) }).where(eq(focusSessions.id, id));
    await db.update(focusTimerJobs).set({ dueAt: new Date(Date.now() - 1_000) }).where(and(
      eq(focusTimerJobs.focusSessionId, id),
      eq(focusTimerJobs.kind, "preparation_complete"),
      eq(focusTimerJobs.status, "pending")
    ));
  } finally {
    await client.end();
  }
}

async function runFocusWorker(now: Date, sessionId?: string, kind?: "preparation_start" | "preparation_complete" | "confirmation_timeout" | "segment_transition") {
  const { client, db } = await connectVerifiedDatabase(loadDatabaseConfig());
  try {
    const worker = new FocusTimerWorker(db);
    let result: Awaited<ReturnType<FocusTimerWorker["processNext"]>> = "idle";
    for (let attempt = 0; attempt < 20; attempt += 1) {
      result = await worker.processNext(now);
      if (!sessionId || !kind) return result;
      const [job] = await db.select({ status: focusTimerJobs.status }).from(focusTimerJobs).where(and(
        eq(focusTimerJobs.focusSessionId, sessionId),
        eq(focusTimerJobs.kind, kind)
      )).limit(1);
      if (!job || job.status !== "pending" || result === "idle") return result;
    }
    return result;
  } finally {
    await client.end();
  }
}

async function makeSegmentTransitionDue(sessionId: string, now: Date) {
  const { client, db } = await connectVerifiedDatabase(loadDatabaseConfig());
  try {
    await db.update(focusTimerJobs).set({ dueAt: now }).where(and(
      eq(focusTimerJobs.focusSessionId, sessionId),
      eq(focusTimerJobs.kind, "segment_transition"),
      eq(focusTimerJobs.status, "pending")
    ));
  } finally {
    await client.end();
  }
}

async function createStructureEditorTask() {
  const date = new Date(Date.now() + 86_400_000);
  const localDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  const id = randomUUID();
  const title = `E2E 结构编辑器 ${Date.now().toString(36)}`;
  const { client, db } = await connectVerifiedDatabase(loadDatabaseConfig());
  try {
    await db.insert(tasks).values({
      id,
      title,
      lifecycleStatus: "open",
      scheduleKind: "exact",
      localDate,
      startAt: new Date(`${localDate}T09:00:00+08:00`),
      endAt: new Date(`${localDate}T12:00:00+08:00`),
      timeZone: "Asia/Shanghai",
      version: 1,
      scheduleRevision: 1
    });
  } finally {
    await client.end();
  }
  return { id, title, localDate };
}

async function createLateStartTask() {
  const localDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date(Date.now() + 86_400_000));
  const taskId = randomUUID();
  const structureId = randomUUID();
  const title = `E2E 晚开始 ${Date.now().toString(36)}`;
  const startAt = new Date(`${localDate}T09:00:00+08:00`);
  const endAt = new Date(`${localDate}T11:00:00+08:00`);
  const { client, db } = await connectVerifiedDatabase(loadDatabaseConfig());
  try {
    await db.insert(tasks).values({
      id: taskId,
      title,
      lifecycleStatus: "open",
      scheduleKind: "exact",
      localDate,
      startAt,
      endAt,
      timeZone: "Asia/Shanghai",
      version: 1,
      scheduleRevision: 1
    });
    await db.insert(focusStructures).values({
      id: structureId,
      taskId,
      taskScheduleRevision: 1,
      state: "active",
      source: "manual",
      version: 1,
      totalStartAt: startAt,
      totalEndAt: endAt,
      confirmedAt: new Date()
    });
    await db.insert(focusStructureSegments).values([
      { id: randomUUID(), focusStructureId: structureId, position: 0, segmentType: "focus", durationMinutes: 55 },
      { id: randomUUID(), focusStructureId: structureId, position: 1, segmentType: "break", durationMinutes: 5 },
      { id: randomUUID(), focusStructureId: structureId, position: 2, segmentType: "focus", durationMinutes: 55 },
      { id: randomUUID(), focusStructureId: structureId, position: 3, segmentType: "break", durationMinutes: 5 }
    ]);
  } finally {
    await client.end();
  }
  return { taskId, title, startAt, endAt };
}

async function cleanupStructureEditorTask(id: string) {
  const { client, db } = await connectVerifiedDatabase(loadDatabaseConfig());
  try {
    const structures = await db.select({ id: focusStructures.id }).from(focusStructures).where(eq(focusStructures.taskId, id));
    for (const structure of structures) {
      await db.delete(focusStructureSegments).where(eq(focusStructureSegments.focusStructureId, structure.id));
    }
    await db.delete(focusStructures).where(eq(focusStructures.taskId, id));
    await db.delete(tasks).where(eq(tasks.id, id));
  } finally {
    await client.end();
  }
}

async function openTaskStructureEditor(page: Page, title: string, localDate: string) {
  await page.getByLabel("时间轴日期").fill(localDate);
  await page.waitForLoadState("networkidle");
  const task = page.locator(`[data-task-id]`).filter({ hasText: title });
  await expect(task).toBeVisible();
  await task.getByRole("button", { name: `打开 ${title} 的任务操作` }).click();
  await task.getByRole("button", { name: "开始专注", exact: true }).click();
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
  await expect(page.getByLabel("专注结构编辑器")).toBeVisible();
}

test("真实专注会话可准备、结束、评估并在刷新后保持",async({page,request})=>{
  test.setTimeout(120_000);
  const date=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
  const title=`E2E 专注会话 ${Date.now().toString(36)}`; let taskId="";
  try {
    const created=await request.post(`${apiBase}/api/v1/tasks`,{data:{title,scheduleKind:"none",localDate:date,timeZone:"Asia/Shanghai"}});
    expect(created.status()).toBe(201);
    const task=(await created.json()).task as {id:string;version:number}; taskId=task.id;
    const started=await request.post(`${apiBase}/api/v1/focus-sessions`,{data:{taskId,expectedTaskVersion:task.version,mode:"prepare"}});
    expect(started.status()).toBe(201);
    const sessionId = ((await started.json()) as { session: { id: string } }).session.id;
    await expirePreparation(sessionId);

    await page.goto("/");
    const focusNav=page.locator(".app-rail").getByRole("button",{name:"专注"}); await expect(focusNav).toHaveCount(1); await focusNav.click();
    await expect(page.getByRole("heading",{name:title})).toBeVisible();
    await expect(page.getByRole("button",{name:"结束并记录"})).toBeVisible();
    await page.reload();
    const restoredFocusNav=page.locator(".app-rail").getByRole("button",{name:"专注"}); await expect(restoredFocusNav).toHaveCount(1); await restoredFocusNav.click();
    await expect(page.getByRole("button",{name:"结束并记录"})).toBeVisible();
    const ended=page.waitForResponse(response=>response.url().endsWith("/end")&&response.request().method()==="POST"&&response.status()===200);
    await page.getByRole("button",{name:"结束并记录"}).click(); await ended;
    await expect(page.getByRole("heading",{name:"完成情况与体验，都值得被记录。"})).toBeVisible();
    await page.getByRole("button",{name:"部分完成"}).click();
    await page.getByLabel("专注过程备注").fill("E2E 持久化验证");
    const evaluated=page.waitForResponse(response=>response.url().endsWith("/evaluate")&&response.request().method()==="POST"&&response.status()===200);
    await page.getByRole("button",{name:"保存本次专注"}).click(); await evaluated;
    await page.reload();
    const detail=await request.get(`${apiBase}/api/v1/tasks/${taskId}`);
    const body=await detail.json() as {task:{lifecycleStatus:string;currentOutcome:string};outcomes:Array<{focusSessionId:string|null;outcome:string}>};
    expect(body.task).toMatchObject({lifecycleStatus:"closed",currentOutcome:"partial"});
    expect(body.outcomes.some(outcome=>outcome.outcome==="partial"&&outcome.focusSessionId!==null)).toBe(true);
    const current=await request.get(`${apiBase}/api/v1/focus-sessions/current`);
    expect((await current.json()).session).toBeNull();
  } finally { if(taskId) await cleanup(request,taskId); }
});

test("专注页提供稳定的本地方法提示与鼓励且在 390px 下不打断计时", async ({ page, request }) => {
  test.setTimeout(120_000);
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const title = `阅读论文 E2E 提示 ${Date.now().toString(36)}`;
  let taskId = "";
  let aiCalls = 0;
  page.on("request", (outgoing) => {
    if (outgoing.url().includes("/api/v1/ai/")) aiCalls += 1;
  });
  try {
    const created = await request.post(`${apiBase}/api/v1/tasks`, { data: { title, scheduleKind: "none", localDate: date, timeZone: "Asia/Shanghai" } });
    expect(created.status()).toBe(201);
    const task = (await created.json()).task as { id: string; version: number };
    taskId = task.id;
    const started = await request.post(`${apiBase}/api/v1/focus-sessions`, { data: { taskId, expectedTaskVersion: task.version, mode: "prepare" } });
    expect(started.status()).toBe(201);

    await page.goto("/");
    await page.locator(".app-rail").getByRole("button", { name: "专注", exact: true }).click();
    const guidance = page.getByLabel("本次专注提示");
    await expect(guidance).toBeVisible();
    await expect(guidance.getByText("方法提示 · 阅读理解", { exact: true })).toBeVisible();
    await expect(guidance.getByText("先确定这一段要回答的问题，再开始读；遇到分支先做标记，结束后再决定是否展开。", { exact: true })).toBeVisible();
    await expect(guidance.getByText("一句鼓励", { exact: true })).toBeVisible();
    const encouragement = await guidance.locator("article").nth(1).locator("p").textContent();
    expect(encouragement).toBeTruthy();

    await page.reload();
    await page.locator(".app-rail").getByRole("button", { name: "专注", exact: true }).click();
    await expect(page.getByLabel("本次专注提示").locator("article").nth(1).locator("p")).toHaveText(encouragement!);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await page.locator(".mobile-nav").getByRole("button", { name: "专注", exact: true }).click();
    await expect(page.getByLabel("本次专注提示")).toBeVisible();
    await expect(page.getByRole("button", { name: "跳过准备，立即开始", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    expect(aiCalls).toBe(0);
  } finally {
    if (taskId) await cleanup(request, taskId);
  }
});

test("1 分钟准备可手动跳过并立即进入固定结束时间计时", async ({ page, request }) => {
  test.setTimeout(120_000);
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const title = `E2E 跳过准备 ${Date.now().toString(36)}`;
  let taskId = "";
  try {
    const created = await request.post(`${apiBase}/api/v1/tasks`, { data: { title, scheduleKind: "none", localDate: date, timeZone: "Asia/Shanghai" } });
    expect(created.status()).toBe(201);
    const task = (await created.json()).task as { id: string; version: number };
    taskId = task.id;
    const started = await request.post(`${apiBase}/api/v1/focus-sessions`, { data: { taskId, expectedTaskVersion: task.version, mode: "prepare" } });
    expect(started.status()).toBe(201);

    await page.goto("/");
    await page.locator(".app-rail").getByRole("button", { name: "专注", exact: true }).click();
    await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    const skipped = page.waitForResponse((response) => response.url().endsWith("/skip-preparation") && response.status() === 200);
    await page.getByRole("button", { name: "跳过准备，立即开始", exact: true }).click();
    await skipped;
    await expect(page.getByRole("button", { name: "结束并记录", exact: true })).toBeVisible();
    await page.reload();
    await page.locator(".app-rail").getByRole("button", { name: "专注", exact: true }).click();
    await expect(page.getByRole("button", { name: "结束并记录", exact: true })).toBeVisible();
  } finally {
    if (taskId) await cleanup(request, taskId);
  }
});

test("390px 移动端可恢复真实专注会话并结束计时", async ({ page, request }) => {
  test.setTimeout(120_000);
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const title = `E2E 移动专注 ${Date.now().toString(36)}`;
  let taskId = "";
  try {
    const created = await request.post(`${apiBase}/api/v1/tasks`, { data: { title, scheduleKind: "none", localDate: date, timeZone: "Asia/Shanghai" } });
    expect(created.status()).toBe(201);
    const task = (await created.json()).task as { id: string; version: number };
    taskId = task.id;
    const started = await request.post(`${apiBase}/api/v1/focus-sessions`, { data: { taskId, expectedTaskVersion: task.version, mode: "prepare" } });
    expect(started.status()).toBe(201);
    const sessionId = ((await started.json()) as { session: { id: string } }).session.id;
    await expirePreparation(sessionId);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await page.locator(".mobile-nav").getByRole("button", { name: "专注", exact: true }).click();
    await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "结束并记录", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

    await page.reload();
    await page.locator(".mobile-nav").getByRole("button", { name: "专注", exact: true }).click();
    await expect(page.getByRole("button", { name: "结束并记录", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  } finally {
    if (taskId) await cleanup(request, taskId);
  }
});

test("另有安排会打开只读协商，不会自动修改任务或日程", async ({ page, request }) => {
  test.setTimeout(120_000);
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const title = `E2E 另有安排 ${Date.now().toString(36)}`;
  let taskId = "";
  let taskWrites = 0;
  let receivedPayload: { taskId: string; message: string } | null = null;
  page.on("request", (outgoing) => {
    if ((outgoing.method() === "PATCH" || outgoing.method() === "DELETE") && outgoing.url().includes("/api/v1/tasks/")) taskWrites += 1;
  });
  await page.route("**/api/v1/ai/plan-change-advisories", async (route) => {
    receivedPayload = route.request().postDataJSON() as { taskId: string; message: string };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ advisory: {
        taskId,
        taskVersion: 1,
        taskScheduleRevision: 1,
        summary: "下午仍有空间，但请由你决定是否移动当前任务。",
        feasibility: "risky",
        affectedTasks: [{ id: taskId, title, startAt: null, endAt: null }],
        options: [
          { title: "保持原计划", detail: "先处理临时安排，稍后回到原任务。" },
          { title: "回到时间轴再调整", detail: "仅在你明确保存后才会改变排期。" }
        ],
        warnings: ["当前建议没有修改任何任务。"]
      } })
    });
  });
  try {
    const created = await request.post(`${apiBase}/api/v1/tasks`, { data: { title, scheduleKind: "none", localDate: date, timeZone: "Asia/Shanghai" } });
    expect(created.status()).toBe(201);
    const task = (await created.json()).task as { id: string; version: number };
    taskId = task.id;
    const reminder = await request.post(`${apiBase}/api/v1/focus-sessions`, { data: { taskId, expectedTaskVersion: task.version, mode: "remind" } });
    expect(reminder.status()).toBe(201);

    await page.goto("/");
    await page.locator(".app-rail").getByRole("button", { name: "专注", exact: true }).click();
    await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    const stopped = page.waitForResponse((response) => response.url().endsWith("/respond") && response.request().method() === "POST" && response.status() === 200);
    await page.getByRole("button", { name: "另有安排", exact: true }).click();
    await stopped;

    await expect(page.getByRole("heading", { name: "先看影响，再由你决定。", exact: true })).toBeVisible();
    await page.getByLabel("变更说明").fill("临时要处理一件事，下午才有时间。");
    const consulted = page.waitForResponse((response) => response.url().endsWith("/plan-change-advisories") && response.request().method() === "POST" && response.status() === 200);
    await page.getByRole("button", { name: "查看协商建议", exact: true }).click();
    await consulted;
    await expect(page.getByText("下午仍有空间，但请由你决定是否移动当前任务。", { exact: true })).toBeVisible();
    await expect(page.getByText("保持原计划", { exact: true })).toBeVisible();
    expect(receivedPayload).toEqual({ taskId, message: "临时要处理一件事，下午才有时间。" });
    expect(taskWrites).toBe(0);

    const detail = await request.get(`${apiBase}/api/v1/tasks/${taskId}`);
    expect(detail.status()).toBe(200);
    expect((await detail.json()).task).toMatchObject({ id: taskId, lifecycleStatus: "open", version: task.version, scheduleRevision: 1 });
    const current = await request.get(`${apiBase}/api/v1/focus-sessions/current`);
    expect((await current.json()).session).toBeNull();

    await page.getByRole("button", { name: /回到时间轴，自己决定调整/ }).click();
    await expect(page.getByRole("heading", { name: "把今天放回时间里。", exact: true })).toBeVisible();
    await page.reload();
    const afterRefresh = await request.get(`${apiBase}/api/v1/tasks/${taskId}`);
    expect((await afterRefresh.json()).task).toMatchObject({ lifecycleStatus: "open", version: task.version, scheduleRevision: 1 });
  } finally {
    if (taskId) await cleanup(request, taskId);
  }
});

test("390px 下另有安排协商可用且不发生横向溢出", async ({ page, request }) => {
  test.setTimeout(120_000);
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const title = `E2E 移动协商 ${Date.now().toString(36)}`;
  let taskId = "";
  await page.route("**/api/v1/ai/plan-change-advisories", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ advisory: {
        taskId,
        taskVersion: 1,
        taskScheduleRevision: 1,
        summary: "请先决定是否回到时间轴修改。",
        feasibility: "needs_clarification",
        affectedTasks: [],
        options: [{ title: "暂时保留", detail: "任务仍在原安排中。" }],
        warnings: ["这只是建议。"]
      } })
    });
  });
  try {
    const created = await request.post(`${apiBase}/api/v1/tasks`, { data: { title, scheduleKind: "none", localDate: date, timeZone: "Asia/Shanghai" } });
    expect(created.status()).toBe(201);
    const task = (await created.json()).task as { id: string; version: number };
    taskId = task.id;
    const reminder = await request.post(`${apiBase}/api/v1/focus-sessions`, { data: { taskId, expectedTaskVersion: task.version, mode: "remind" } });
    expect(reminder.status()).toBe(201);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await page.locator(".mobile-nav").getByRole("button", { name: "专注", exact: true }).click();
    await page.getByRole("button", { name: "另有安排", exact: true }).click();
    await expect(page.getByLabel("变更说明")).toBeVisible();
    await page.getByLabel("变更说明").fill("临时调整一下。");
    await page.getByRole("button", { name: "查看协商建议", exact: true }).click();
    await expect(page.getByText("暂时保留", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  } finally {
    if (taskId) await cleanup(request, taskId);
  }
});

test("5 分钟未响应由本地 Worker 关闭任务并追加系统未完成结果", async ({ page, request }) => {
  test.setTimeout(120_000);
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const title = `E2E 无响应提醒 ${Date.now().toString(36)}`;
  let taskId = "";
  try {
    const created = await request.post(`${apiBase}/api/v1/tasks`, { data: { title, scheduleKind: "none", localDate: date, timeZone: "Asia/Shanghai" } });
    expect(created.status()).toBe(201);
    const task = (await created.json()).task as { id: string; version: number };
    taskId = task.id;
    const started = await request.post(`${apiBase}/api/v1/focus-sessions`, { data: { taskId, expectedTaskVersion: task.version, mode: "remind" } });
    expect(started.status()).toBe(201);
    const session = (await started.json()).session as { id: string };
    const { client, db } = await connectVerifiedDatabase(loadDatabaseConfig());
    try {
      await db.update(focusTimerJobs).set({ dueAt: new Date(Date.now() - 1_000) }).where(and(
        eq(focusTimerJobs.focusSessionId, session.id),
        eq(focusTimerJobs.kind, "confirmation_timeout"),
        eq(focusTimerJobs.status, "pending")
      ));
    } finally { await client.end(); }
    await runFocusWorker(new Date(), session.id, "confirmation_timeout");

    const detail = await request.get(`${apiBase}/api/v1/tasks/${taskId}`);
    expect(detail.status()).toBe(200);
    const body = await detail.json() as { task: { lifecycleStatus: string; currentOutcome: string; scheduleRevision: number }; outcomes: Array<{ focusSessionId: string | null; outcome: string; source: string }> };
    expect(body.task).toMatchObject({ lifecycleStatus: "closed", currentOutcome: "not_completed", scheduleRevision: 2 });
    expect(body.outcomes.some((outcome) => outcome.focusSessionId === session.id && outcome.outcome === "not_completed" && outcome.source === "system")).toBe(true);

    const current = await request.get(`${apiBase}/api/v1/focus-sessions/current`);
    expect(current.status()).toBe(200);
    expect((await current.json()).session).toBeNull();
    await page.goto("/");
    await page.locator(".app-rail").getByRole("button", { name: "专注" }).click();
    await expect(page.getByRole("heading", { name: title, exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "结束并记录", exact: true })).toHaveCount(0);
  } finally { if (taskId) await cleanup(request, taskId); }
});

test("软件未打开时任务开始 5 分钟无响应仍由 Reminder Worker 持久化", async ({ request }) => {
  test.setTimeout(120_000);
  const taskId = randomUUID();
  const jobId = randomUUID();
  const title = `E2E 离线无响应 ${Date.now().toString(36)}`;
  const startAt = new Date("2026-08-06T09:00:00+08:00");
  const endAt = new Date("2026-08-06T10:00:00+08:00");
  const followUpAt = new Date(startAt.getTime() + 5 * 60_000);
  const connection = await connectVerifiedDatabase(loadDatabaseConfig());
  try {
    const leftovers = await connection.db.select({ id: tasks.id }).from(tasks)
      .where(like(tasks.title, "E2E 离线无响应 %"));
    const leftoverIds = leftovers.map((item) => item.id).filter((id) => id !== taskId);
    if (leftoverIds.length > 0) {
      await connection.db.delete(reminderJobs).where(inArray(reminderJobs.taskId, leftoverIds));
      await connection.db.update(tasks).set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(inArray(tasks.id, leftoverIds));
    }
    await connection.db.insert(tasks).values({
      id: taskId,
      title,
      lifecycleStatus: "open",
      scheduleKind: "exact",
      localDate: "2026-08-06",
      startAt,
      endAt,
      timeZone: "Asia/Shanghai",
      version: 1,
      scheduleRevision: 1
    });
    await connection.db.insert(reminderJobs).values({
      id: jobId,
      taskId,
      channel: "feishu",
      kind: "task_follow_up",
      scheduleRevision: 1,
      status: "pending",
      scheduledAt: startAt,
      availableAt: new Date("2000-01-01T00:00:00.000Z"),
      attempts: 0,
      payload: {
        taskId,
        title,
        startAt: startAt.toISOString(),
        endAt: endAt.toISOString(),
        timeZone: "Asia/Shanghai",
        scheduleRevision: 1
      }
    });
    const provider = { deliver: async () => { throw new Error("follow-up must not send another card"); } };
    const worker = new ReminderWorker(connection.db);
    await expect(worker.processNext(provider, followUpAt)).resolves.toBe("sent");
  } finally {
    await connection.client.end();
  }

  try {
    const detail = await request.get(`${apiBase}/api/v1/tasks/${taskId}`);
    expect(detail.status()).toBe(200);
    const body = await detail.json() as {
      task: { lifecycleStatus: string; currentOutcome: string; scheduleRevision: number };
      outcomes: Array<{ focusSessionId: string | null; outcome: string; source: string }>;
    };
    expect(body.task).toMatchObject({ lifecycleStatus: "closed", currentOutcome: "not_completed", scheduleRevision: 2 });
    expect(body.outcomes.some((outcome) => outcome.focusSessionId && outcome.outcome === "not_completed" && outcome.source === "system")).toBe(true);
    const verification = await connectVerifiedDatabase(loadDatabaseConfig());
    try {
      const [session] = await verification.db.select().from(focusSessions).where(eq(focusSessions.taskId, taskId));
      expect(session).toMatchObject({ state: "stopped_no_response", rawActiveSeconds: 0, effectiveFocusSeconds: 0 });
    } finally {
      await verification.client.end();
    }
  } finally {
    await cleanup(request, taskId);
  }
});

test("真实结构执行会持久化段运行并自动切换到休息段", async ({ page, request }) => {
  test.setTimeout(120_000);
  const now = new Date();
  const halfHour = 30 * 60 * 1_000;
  const localDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
  const title = `E2E 分段结构 ${Date.now().toString(36)}`;
  let taskId = "";
  try {
    let startAt = new Date((Math.floor(now.getTime() / halfHour) + 1) * halfHour);
    let created = null as Awaited<ReturnType<typeof request.post>> | null;
    while (localDate.format(startAt) === localDate.format(now)) {
      const endAt = new Date(startAt.getTime() + 60 * 60_000);
      if (localDate.format(endAt) !== localDate.format(startAt)) break;
      const attempt = await request.post(`${apiBase}/api/v1/tasks`, { data: {
        title,
        scheduleKind: "exact",
        timeZone: "Asia/Shanghai",
        startAt: startAt.toISOString(),
        endAt: endAt.toISOString(),
        notes: "结构执行验收"
      } });
      if (attempt.status() === 201) {
        created = attempt;
        break;
      }
      const error = await attempt.json() as { error?: string };
      expect(error.error).toBe("task_time_conflict");
      startAt = new Date(startAt.getTime() + halfHour);
    }
    test.skip(!created, "当天没有可用的、不会跨午夜且不影响现有计划的 60 分钟精确任务窗口");
    expect(created).not.toBeNull();
    const task = (await created.json()).task as { id: string; version: number; scheduleRevision: number; startAt: string; endAt: string };
    taskId = task.id;

    const candidateResponse = await request.post(`${apiBase}/api/v1/focus-structures/candidates`, { data: {
      taskId,
      taskVersion: task.version,
      taskScheduleRevision: task.scheduleRevision,
      source: "manual",
      mode: "continuous",
      totalStartAt: task.startAt,
      totalEndAt: task.endAt,
      breakMinutes: 5
    } });
    expect(candidateResponse.status()).toBe(201);
    const candidate = (await candidateResponse.json()).focusStructure as { id: string; version: number };
    const confirmed = await request.post(`${apiBase}/api/v1/focus-structures/${candidate.id}/confirm`, { data: {
      expectedVersion: candidate.version,
      expectedTaskVersion: task.version,
      expectedTaskScheduleRevision: task.scheduleRevision
    } });
    expect(confirmed.status()).toBe(200);

    const started = await request.post(`${apiBase}/api/v1/focus-sessions`, { data: {
      taskId,
      expectedTaskVersion: task.version,
      mode: "prepare"
    } });
    expect(started.status()).toBe(201);
    const session = (await started.json()).session as { id: string; state: string };
    expect(session.state).toBe("scheduled");
    expect(await runFocusWorker(new Date(task.startAt), session.id, "preparation_start")).toBe("completed");
    await expirePreparation(session.id);
    expect(await runFocusWorker(new Date(new Date(task.startAt).getTime() + 60_000), session.id, "preparation_complete")).toBe("completed");

    const { client, db } = await connectVerifiedDatabase(loadDatabaseConfig());
    try {
      const current = (await db.select().from(focusSessions).where(eq(focusSessions.id, session.id)))[0];
      expect(current?.state).toBe("running");
      expect(current?.currentSegmentPosition).toBe(0);
      const initialRuns = await db.select().from(focusSessionSegmentRuns)
        .where(eq(focusSessionSegmentRuns.focusSessionId, session.id));
      expect(initialRuns).toHaveLength(2);
      expect(initialRuns.find((run) => run.position === 0)?.startedAt).not.toBeNull();
    } finally {
      await client.end();
    }

    await makeSegmentTransitionDue(session.id, new Date());
    expect(await runFocusWorker(new Date(), session.id, "segment_transition")).toBe("completed");

    const afterTransition = await request.get(`${apiBase}/api/v1/focus-sessions/current`);
    expect(afterTransition.status()).toBe(200);
    expect(((await afterTransition.json()).session as { currentSegmentPosition: number }).currentSegmentPosition).toBe(1);

    await page.goto("/");
    await page.locator(".app-rail").getByRole("button", { name: "专注", exact: true }).click();
    await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    await expect(page.getByText("第 2 段 · 休息 · 最后一次休息", { exact: true })).toBeVisible();
    await expect(page.getByLabel("本次专注提示")).toHaveCount(0);
    await page.reload();
    await page.locator(".app-rail").getByRole("button", { name: "专注", exact: true }).click();
    await expect(page.getByText("第 2 段 · 休息 · 最后一次休息", { exact: true })).toBeVisible();
    const skipped = page.waitForResponse((response) => response.url().endsWith("/skip-final-break") && response.status() === 200);
    await page.getByRole("button", { name: "跳过休息并记录", exact: true }).click();
    await skipped;
    await expect(page.getByRole("heading", { name: "完成情况与体验，都值得被记录。", exact: true })).toBeVisible();
  } finally {
    if (taskId) await cleanup(request, taskId);
  }
});

test("晚开始按原结构当前位置继续并把过去段落记为跳过", async ({ page, request }) => {
  test.setTimeout(120_000);
  const task = await createLateStartTask();
  try {
    const started = await request.post(`${apiBase}/api/v1/focus-sessions`, { data: {
      taskId: task.taskId,
      expectedTaskVersion: 1,
      mode: "prepare"
    } });
    expect(started.status()).toBe(201);
    const session = (await started.json()).session as { id: string; state: string };
    expect(session.state).toBe("scheduled");

    const lateStart = new Date(task.startAt.getTime() + 80 * 60_000);
    expect(await runFocusWorker(new Date(lateStart.getTime() - 60_000), session.id, "preparation_start")).toBe("completed");
    expect(await runFocusWorker(lateStart, session.id, "preparation_complete")).toBe("completed");

    const { client, db } = await connectVerifiedDatabase(loadDatabaseConfig());
    try {
      const [running] = await db.select().from(focusSessions).where(eq(focusSessions.id, session.id));
      expect(running).toMatchObject({
        state: "running",
        currentSegmentPosition: 2,
        currentSegmentElapsedSeconds: 20 * 60
      });
      expect(running?.currentSegmentStartedAt?.toISOString()).toBe(new Date(task.startAt.getTime() + 60 * 60_000).toISOString());
      const runs = await db.select().from(focusSessionSegmentRuns).where(eq(focusSessionSegmentRuns.focusSessionId, session.id));
      expect(runs.find((run) => run.position === 0)).toMatchObject({ elapsedSeconds: 0, startedAt: null, completedAt: null });
      expect(runs.find((run) => run.position === 0)?.skippedAt).not.toBeNull();
      expect(runs.find((run) => run.position === 1)?.skippedAt).not.toBeNull();
      expect(runs.find((run) => run.position === 2)?.startedAt?.toISOString()).toBe(lateStart.toISOString());
    } finally {
      await client.end();
    }

    await page.goto("/");
    await page.locator(".app-rail").getByRole("button", { name: "专注", exact: true }).click();
    await expect(page.getByRole("heading", { name: task.title, exact: true })).toBeVisible();
    await expect(page.getByText("第 3 段 · 专注", { exact: true })).toBeVisible();
    await page.reload();
    await page.locator(".app-rail").getByRole("button", { name: "专注", exact: true }).click();
    await expect(page.getByText("第 3 段 · 专注", { exact: true })).toBeVisible();

    const boundary = new Date(task.startAt.getTime() + 115 * 60_000);
    await makeSegmentTransitionDue(session.id, boundary);
    expect(await runFocusWorker(boundary, session.id, "segment_transition")).toBe("completed");
    const verification = await connectVerifiedDatabase(loadDatabaseConfig());
    try {
      const runs = await verification.db.select().from(focusSessionSegmentRuns)
        .where(eq(focusSessionSegmentRuns.focusSessionId, session.id));
      expect(runs.find((run) => run.position === 2)?.elapsedSeconds).toBe(35 * 60);
    } finally {
      await verification.client.end();
    }
  } finally {
    await cleanup(request, task.taskId);
  }
});

test("手动专注结构可保存候选、刷新恢复、确认并在移动端精确编辑", async ({ page }) => {
  test.setTimeout(120_000);
  const task = await createStructureEditorTask();
  try {
    await page.goto("/");
    await openTaskStructureEditor(page, task.title, task.localDate);

    await page.getByRole("button", { name: "4 段", exact: true }).click();
    await page.getByRole("button", { name: "逐渐延长", exact: true }).click();
    await expect(page.locator(".structure-timeline > div")).toHaveCount(8);
    await expect(page.getByText("刚好填满任务时间", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "精确编辑", exact: true }).click();
    const firstFocus = page.getByLabel("第 1 段专注分钟");
    const firstBreak = page.getByLabel("第 1 段休息分钟");
    const focusBeforeDrag = Number(await firstFocus.inputValue());
    const breakBeforeDrag = Number(await firstBreak.inputValue());
    const firstBoundary = page.getByRole("button", { name: "调整第 1 与第 2 段边界", exact: true });
    const boundaryBox = await firstBoundary.boundingBox();
    expect(boundaryBox).not.toBeNull();
    await page.mouse.move(boundaryBox!.x + boundaryBox!.width / 2, boundaryBox!.y + boundaryBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(boundaryBox!.x - 20, boundaryBox!.y + boundaryBox!.height / 2, { steps: 4 });
    await page.mouse.up();
    expect(Number(await firstFocus.inputValue())).toBeLessThan(focusBeforeDrag);
    expect(Number(await firstBreak.inputValue())).toBeGreaterThan(breakBeforeDrag);
    await expect(page.getByText("刚好填满任务时间", { exact: true })).toBeVisible();

    const saved = page.waitForResponse((response) => response.url().endsWith("/api/v1/focus-structures/candidates") && response.request().method() === "POST" && response.status() === 201);
    await page.getByRole("button", { name: "保存为候选", exact: true }).click();
    await saved;
    await expect(page.getByText("候选方案，等待确认", { exact: true })).toBeVisible();

    await page.reload();
    await openTaskStructureEditor(page, task.title, task.localDate);
    await expect(page.getByText("候选方案，等待确认", { exact: true })).toBeVisible();
    await expect(page.locator(".structure-timeline > div")).toHaveCount(8);

    const confirmed = page.waitForResponse((response) => response.url().includes("/api/v1/focus-structures/") && response.url().endsWith("/confirm") && response.status() === 200);
    await page.getByRole("button", { name: "确认并使用", exact: true }).click();
    await confirmed;
    await expect(page.getByText("已确认方案", { exact: true })).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await openTaskStructureEditor(page, task.title, task.localDate);
    await expect(page.getByText("已确认方案", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "精确编辑", exact: true }).click();
    await expect(page.getByLabel("第 1 段专注分钟")).toBeVisible();
    await page.getByLabel("第 1 段专注分钟").fill("30");
    await expect(page.getByText("各段总和必须刚好填满任务时间。", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  } finally {
    await cleanupStructureEditorTask(task.id);
  }
});

test("AI 专注安排只生成待确认候选且不会自动启用", async ({ page, request }) => {
  test.setTimeout(120_000);
  const task = await createStructureEditorTask();
  const candidateId = randomUUID();
  let confirmRequests = 0;
  let receivedPayload: {
    taskId: string;
    taskVersion: number;
    taskScheduleRevision: number;
    instructions: string | null;
  } | null = null;
  page.on("request", (outgoing) => {
    if (outgoing.method() === "POST" && outgoing.url().endsWith("/confirm")) confirmRequests += 1;
  });
  await page.route("**/api/v1/focus-structures/ai-candidates", async (route) => {
    receivedPayload = route.request().postDataJSON() as {
      taskId: string;
      taskVersion: number;
      taskScheduleRevision: number;
      instructions: string | null;
    };
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        focusStructure: {
          id: candidateId,
          taskId: task.id,
          taskScheduleRevision: 1,
          state: "candidate",
          source: "ai",
          version: 1,
          totalStartAt: new Date(`${task.localDate}T09:00:00+08:00`).toISOString(),
          totalEndAt: new Date(`${task.localDate}T12:00:00+08:00`).toISOString(),
          confirmedAt: null,
          supersededAt: null,
          invalidatedAt: null,
          invalidationReason: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          segments: [
            { id: randomUUID(), focusStructureId: candidateId, position: 0, segmentType: "focus", durationMinutes: 50 },
            { id: randomUUID(), focusStructureId: candidateId, position: 1, segmentType: "break", durationMinutes: 5 },
            { id: randomUUID(), focusStructureId: candidateId, position: 2, segmentType: "focus", durationMinutes: 55 },
            { id: randomUUID(), focusStructureId: candidateId, position: 3, segmentType: "break", durationMinutes: 5 },
            { id: randomUUID(), focusStructureId: candidateId, position: 4, segmentType: "focus", durationMinutes: 60 },
            { id: randomUUID(), focusStructureId: candidateId, position: 5, segmentType: "break", durationMinutes: 5 }
          ]
        }
      })
    });
  });

  try {
    await page.goto("/");
    await openTaskStructureEditor(page, task.title, task.localDate);
    const instructions = page.getByLabel("AI 专注结构临时要求");
    await instructions.fill("拆成 3 段，前短后长");
    await expect(instructions).toHaveValue("拆成 3 段，前短后长");
    await instructions.press("Tab");
    await page.getByRole("button", { name: "生成 AI 候选", exact: true }).click();

    await expect(page.getByText("AI 候选，等待你确认", { exact: true })).toBeVisible();
    await expect(page.locator(".structure-timeline > div")).toHaveCount(6);
    await expect(page.getByRole("button", { name: "确认并使用", exact: true })).toBeVisible();
    expect(confirmRequests).toBe(0);
    expect(receivedPayload).toEqual({
      taskId: task.id,
      taskVersion: 1,
      taskScheduleRevision: 1,
      instructions: "拆成 3 段，前短后长"
    });

    const stored = await request.get(`${apiBase}/api/v1/tasks/${task.id}/focus-structures`);
    expect(stored.status()).toBe(200);
    expect(((await stored.json()) as { focusStructures: unknown[] }).focusStructures).toHaveLength(0);
  } finally {
    await cleanupStructureEditorTask(task.id);
  }
});
