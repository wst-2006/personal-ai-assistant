import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { connectVerifiedDatabase } from "@personal-ai/db/client";
import { loadDatabaseConfig } from "@personal-ai/db/config";
import { focusSessionSegmentRuns, focusSessions, focusStructureSegments, focusStructures, focusTimerJobs, tasks } from "@personal-ai/db/schema";
import { and, eq } from "drizzle-orm";
import { FocusTimerWorker } from "../../worker/src/focus-worker.js";

const apiBase = "http://127.0.0.1:3000";

async function cleanup(request:APIRequestContext, id:string) {
  const current=await request.get(`${apiBase}/api/v1/focus-sessions/current`);
  if(current.ok()) {
    const session=(await current.json()).session as {id:string;taskId:string;state:string;version:number}|null;
    if(session?.taskId===id && session.state==="running") {
      const ended=await request.post(`${apiBase}/api/v1/focus-sessions/${session.id}/end`,{data:{expectedVersion:session.version,reason:"focus e2e cleanup"}});
      if(ended.ok()) {
        const value=(await ended.json()).session as {version:number};
        await request.post(`${apiBase}/api/v1/focus-sessions/${session.id}/evaluate`,{data:{expectedVersion:value.version,outcome:"not_completed",progressPercent:0,satisfaction:"neutral",note:"focus e2e cleanup"}});
      }
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

async function runFocusWorker(now: Date, sessionId?: string, kind?: "preparation_complete" | "segment_transition") {
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
    const created=await request.post(`${apiBase}/api/v1/tasks`,{data:{title,scheduleKind:"none",localDate:date,timeZone:"Asia/Shanghai",plannedEffortMinutes:45,difficulty:"high",requiresContinuousFocus:true}});
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

test("390px 移动端可恢复真实专注会话并结束计时", async ({ page, request }) => {
  test.setTimeout(120_000);
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const title = `E2E 移动专注 ${Date.now().toString(36)}`;
  let taskId = "";
  try {
    const created = await request.post(`${apiBase}/api/v1/tasks`, { data: { title, scheduleKind: "none", localDate: date, timeZone: "Asia/Shanghai", plannedEffortMinutes: 30, difficulty: "medium", requiresContinuousFocus: true } });
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

test("真实结构执行会持久化段运行并自动切换到休息段", async ({ page, request }) => {
  test.setTimeout(120_000);
  const now = new Date();
  const localHour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", hour: "2-digit", hour12: false }).format(now));
  test.skip(localHour >= 23, "23:00 后当天没有可用的、不会跨午夜的 60 分钟精确任务窗口");
  const halfHour = 30 * 60 * 1_000;
  const startAt = new Date(Math.floor(now.getTime() / halfHour) * halfHour);
  const endAt = new Date(startAt.getTime() + 60 * 60_000);
  const title = `E2E 分段结构 ${Date.now().toString(36)}`;
  let taskId = "";
  try {
    const created = await request.post(`${apiBase}/api/v1/tasks`, { data: {
      title,
      scheduleKind: "exact",
      timeZone: "Asia/Shanghai",
      startAt: startAt.toISOString(),
      endAt: endAt.toISOString(),
      plannedEffortMinutes: 60,
      notes: "结构执行验收"
    } });
    expect(created.status()).toBe(201);
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
    const session = (await started.json()).session as { id: string };
    await expirePreparation(session.id);
    expect(await runFocusWorker(new Date(), session.id, "preparation_complete")).toBe("completed");

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
    await page.reload();
    await page.locator(".app-rail").getByRole("button", { name: "专注", exact: true }).click();
    await expect(page.getByText("第 2 段 · 休息 · 最后一次休息", { exact: true })).toBeVisible();
  } finally {
    if (taskId) await cleanup(request, taskId);
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
