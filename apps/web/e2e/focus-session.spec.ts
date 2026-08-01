import { expect, test, type APIRequestContext } from "@playwright/test";
import { connectVerifiedDatabase } from "@personal-ai/db/client";
import { loadDatabaseConfig } from "@personal-ai/db/config";
import { focusSessions } from "@personal-ai/db/schema";
import { eq } from "drizzle-orm";

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
  } finally {
    await client.end();
  }
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
