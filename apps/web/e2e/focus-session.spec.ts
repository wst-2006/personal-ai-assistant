import { expect, test, type APIRequestContext } from "@playwright/test";

const apiBase = "http://127.0.0.1:3000";

async function cleanup(request:APIRequestContext, id:string) {
  const current=await request.get(`${apiBase}/api/v1/focus-sessions/current`);
  if(current.ok()) {
    const session=(await current.json()).session as {id:string;taskId:string;state:string;version:number}|null;
    if(session?.taskId===id && (session.state==="running"||session.state==="paused")) {
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

test("真实专注会话可暂停、恢复、结束、评估并在刷新后保持",async({page,request})=>{
  const date=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
  const title=`E2E 专注会话 ${Date.now().toString(36)}`; let taskId="";
  try {
    const created=await request.post(`${apiBase}/api/v1/tasks`,{data:{title,scheduleKind:"none",localDate:date,timeZone:"Asia/Shanghai",plannedEffortMinutes:45,difficulty:"high",requiresContinuousFocus:true}});
    expect(created.status()).toBe(201);
    const task=(await created.json()).task as {id:string;version:number}; taskId=task.id;
    const started=await request.post(`${apiBase}/api/v1/focus-sessions`,{data:{taskId,expectedTaskVersion:task.version,mode:"restart"}});
    expect(started.status()).toBe(201);

    await page.goto("/");
    const focusNav=page.locator(".app-rail").getByRole("button",{name:"专注"}); await expect(focusNav).toHaveCount(1); await focusNav.click();
    await expect(page.getByRole("heading",{name:title})).toBeVisible();
    await expect(page.getByRole("button",{name:"暂停专注"})).toBeVisible();
    await page.reload();
    const restoredFocusNav=page.locator(".app-rail").getByRole("button",{name:"专注"}); await expect(restoredFocusNav).toHaveCount(1); await restoredFocusNav.click();
    await expect(page.getByRole("button",{name:"暂停专注"})).toBeVisible();

    const paused=page.waitForResponse(response=>response.url().endsWith("/pause")&&response.request().method()==="POST"&&response.status()===200);
    await page.getByRole("button",{name:"暂停专注"}).click(); await paused;
    await expect(page.getByRole("button",{name:"继续专注"})).toBeVisible();
    const resumed=page.waitForResponse(response=>response.url().endsWith("/resume")&&response.request().method()==="POST"&&response.status()===200);
    await page.getByRole("button",{name:"继续专注"}).click(); await resumed;
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
