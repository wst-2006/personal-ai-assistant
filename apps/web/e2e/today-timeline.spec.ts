import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const apiBase = "http://127.0.0.1:3000";
const halfHourPixels = 36;
let dateSequence = 0;
const isolatedDate = () => new Date(Date.UTC(2090,0,1+(Date.now()+dateSequence++)%300)).toISOString().slice(0,10);

async function createExactTask(page:Page, title:string, start:string, end:string, planned="45") {
  await page.getByRole("button", { name: "完整添加" }).click();
  await page.getByLabel("任务标题").fill(title);
  await page.getByLabel("排期方式").selectOption("exact");
  await page.getByLabel("开始时间").fill(start);
  await page.getByLabel("结束时间").fill(end);
  await page.getByLabel("预计投入（与时间块独立）").fill(planned);
  const responsePromise=page.waitForResponse((response)=>response.url()===`${apiBase}/api/v1/tasks`&&response.request().method()==="POST"&&response.status()===201);
  await page.getByRole("button", { name: "保存任务" }).click();
  const response=await responsePromise;
  return (await response.json()).task as {id:string;version:number;startAt:string;endAt:string};
}

async function cleanup(request:APIRequestContext, ids:string[]) {
  for(const id of ids){
    const detail=await request.get(`${apiBase}/api/v1/tasks/${id}`);
    if(!detail.ok()) continue;
    const task=(await detail.json()).task as {version:number};
    await request.delete(`${apiBase}/api/v1/tasks/${id}`,{data:{expectedVersion:task.version,reason:"e2e cleanup"}});
  }
}

test.describe("真实今日时间轴",()=>{
  test("创建、刷新、拖动、拉伸、保留冲突并再次刷新",async({page,request})=>{
    const suffix=Date.now().toString(36);const ids:string[]=[];
    const testDate=isolatedDate();
    const firstTitle=`E2E 深度任务 ${suffix}`;const secondTitle=`E2E 冲突任务 ${suffix}`;
    try{
      await page.goto("/");
      await expect(page.getByRole("heading",{name:"把今天放回时间里。"})).toBeVisible();
      await page.getByLabel("时间轴日期").fill(testDate);
      const first=await createExactTask(page,firstTitle,"13:00","13:30","50");ids.push(first.id);
      await expect(page.locator(`[data-task-id="${first.id}"]`)).toContainText(firstTitle);

      await page.reload();
      await page.getByLabel("时间轴日期").fill(testDate);
      const block=page.locator(`[data-task-id="${first.id}"]`);
      await expect(block).toBeVisible();
      await block.scrollIntoViewIfNeeded();
      const box=await block.boundingBox();expect(box).not.toBeNull();
      const moved=page.waitForResponse((response)=>response.url().endsWith(`/api/v1/tasks/${first.id}`)&&response.request().method()==="PATCH"&&response.status()===200);
      const dragStartY=box!.y+3;
      await page.mouse.move(box!.x+8,dragStartY);
      await page.mouse.down();await page.mouse.move(box!.x+8,dragStartY+halfHourPixels,{steps:5});await page.mouse.up();
      const movedTask=(await (await moved).json()).task as {startAt:string;plannedEffortMinutes:number};
      expect(movedTask.startAt).toContain("05:30:00.000Z");
      expect(movedTask.plannedEffortMinutes).toBe(50);

      const handle=page.locator(`[data-task-id="${first.id}"] .resize-handle`);
      await handle.scrollIntoViewIfNeeded();const handleBox=await handle.boundingBox();expect(handleBox).not.toBeNull();
      const resized=page.waitForResponse((response)=>response.url().endsWith(`/api/v1/tasks/${first.id}`)&&response.request().method()==="PATCH"&&response.status()===200);
      const resizeStartY=handleBox!.y+handleBox!.height/2;
      await page.mouse.move(handleBox!.x+handleBox!.width/2,resizeStartY);
      await page.mouse.down();await page.mouse.move(handleBox!.x+handleBox!.width/2,resizeStartY+halfHourPixels,{steps:4});await page.mouse.up();
      const resizedTask=(await (await resized).json()).task as {endAt:string;plannedEffortMinutes:number};
      expect(resizedTask.endAt).toContain("06:30:00.000Z");
      expect(resizedTask.plannedEffortMinutes).toBe(50);

      page.once("dialog",(dialog)=>dialog.accept());
      const second=await createExactTask(page,secondTitle,"14:00","15:00","30");ids.push(second.id);
      await expect(page.locator(`[data-task-id="${first.id}"]`)).toHaveClass(/conflict/);
      await expect(page.locator(`[data-task-id="${second.id}"]`)).toHaveClass(/conflict/);

      await page.reload();
      await page.getByLabel("时间轴日期").fill(testDate);
      await expect(page.locator(`[data-task-id="${first.id}"]`)).toContainText(firstTitle);
      await expect(page.locator(`[data-task-id="${second.id}"]`)).toContainText(secondTitle);
      const list=await request.get(`${apiBase}/api/v1/tasks?date=${await page.getByLabel("时间轴日期").inputValue()}`);
      const body=await list.json() as {blockingConflicts:Array<{accepted:boolean}>};
      expect(body.blockingConflicts.some((pair)=>pair.accepted)).toBe(true);
    }finally{await cleanup(request,ids);}
  });

  test("点击空白时间以 30 分钟默认块创建并持久化",async({page,request})=>{
    const ids:string[]=[];const title=`E2E 空白创建 ${Date.now().toString(36)}`;const testDate=isolatedDate();
    try{
      await page.goto("/");
      await page.getByLabel("时间轴日期").fill(testDate);
      const scroll=page.locator(".day-scroll");
      await scroll.evaluate((element)=>{element.scrollTop=9*72-120;});
      const grid=page.locator(".day-grid");const box=await grid.boundingBox();expect(box).not.toBeNull();
      await page.mouse.click(box!.x+Math.min(180,box!.width-20),box!.y+9*72);
      await expect(page.getByRole("dialog")).toBeVisible();
      await expect(page.getByLabel("开始时间")).toHaveValue("09:00");
      await expect(page.getByLabel("结束时间")).toHaveValue("09:30");
      await page.getByLabel("任务标题").fill(title);
      const created=page.waitForResponse((response)=>response.url()===`${apiBase}/api/v1/tasks`&&response.request().method()==="POST"&&response.status()===201);
      await page.getByRole("button",{name:"保存任务"}).click();
      const task=(await (await created).json()).task as {id:string;startAt:string;endAt:string};ids.push(task.id);
      expect(task.startAt).toContain("01:00:00.000Z");expect(task.endAt).toContain("01:30:00.000Z");
      await page.reload();
      await page.getByLabel("时间轴日期").fill(testDate);
      await expect(page.locator(`[data-task-id="${task.id}"]`)).toContainText("09:00–09:30");
    }finally{await cleanup(request,ids);}
  });

  test("今日任务操作可带入真实专注页",async({page,request})=>{
    const ids:string[]=[];const title=`E2E 专注入口 ${Date.now().toString(36)}`;
    try{
      await page.goto("/");
      await page.getByLabel("快速记录内容").fill(title);
      const created=page.waitForResponse((response)=>response.url()===`${apiBase}/api/v1/tasks`&&response.request().method()==="POST"&&response.status()===201);
      await page.getByRole("button",{name:"保存",exact:true}).click();
      const task=(await (await created).json()).task as {id:string};ids.push(task.id);
      const loose=page.locator(".loose-task").filter({hasText:title});
      await loose.getByLabel(`打开 ${title} 的任务操作`).click();
      await page.getByRole("button",{name:"开始专注"}).click();
      await expect(page.getByRole("heading",{name:title})).toBeVisible();
      await page.getByRole("button",{name:"回到时间轴"}).click();
      await expect(page.locator(".loose-task").filter({hasText:title})).toBeVisible();
    }finally{await cleanup(request,ids);}
  });

  test("390px 移动端可查看时间轴并打开完整表单",async({page})=>{
    await page.setViewportSize({width:390,height:844});
    await page.goto("/");
    await expect(page.getByRole("heading",{name:"把今天放回时间里。"})).toBeVisible();
    await expect(page.locator(".day-scroll")).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth)).toBe(true);
    await page.getByRole("button",{name:"完整添加"}).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByLabel("任务标题")).toBeVisible();
    await expect(page.getByLabel("开始时间")).toHaveAttribute("step","1800");
    await expect(page.getByLabel("结束时间")).toHaveAttribute("step","1800");
  });

  test("记录结果、刷新并重新打开任务",async({page,request})=>{
    const suffix=Date.now().toString(36); const ids:string[]=[];
    const title=`E2E 生命周期任务 ${suffix}`;const testDate=isolatedDate();
    try {
      await page.goto("/");
      await page.getByLabel("时间轴日期").fill(testDate);
      const task=await createExactTask(page,title,"15:00","16:00","45"); ids.push(task.id);
      const block=page.locator(`[data-task-id="${task.id}"]`);
      await block.scrollIntoViewIfNeeded();
      await block.getByLabel(`打开 ${title} 的任务操作`).click();
      await page.getByRole("button",{name:"记录结果"}).click();
      await expect(page.getByRole("dialog",{name:"记录这次完成情况"})).toBeVisible();
      await page.getByRole("button",{name:"完成",exact:true}).click();
      const closed=page.waitForResponse((response)=>response.url().endsWith(`/api/v1/tasks/${task.id}/outcomes`)&&response.request().method()==="POST"&&response.status()===201);
      await page.getByRole("button",{name:"保存结果"}).click();
      await closed;
      await expect(block).toHaveClass(/closed/);
      await expect(block).toContainText("已完成");

      await page.reload();
      await page.getByLabel("时间轴日期").fill(testDate);
      const restored=page.locator(`[data-task-id="${task.id}"]`);
      await expect(restored).toHaveClass(/closed/);
      await expect(restored).toContainText("已完成");

      await restored.scrollIntoViewIfNeeded();
      await restored.getByLabel(`打开 ${title} 的任务操作`).click();
      const reopened=page.waitForResponse((response)=>response.url().endsWith(`/api/v1/tasks/${task.id}/reopen`)&&response.request().method()==="POST"&&response.status()===200);
      await page.getByRole("button",{name:"重新打开"}).click();
      await reopened;
      await expect(restored).toHaveClass(/open/);
      await page.reload();
      await page.getByLabel("时间轴日期").fill(testDate);
      await expect(page.locator(`[data-task-id="${task.id}"]`)).toHaveClass(/open/);
    } finally { await cleanup(request,ids); }
  });
});
