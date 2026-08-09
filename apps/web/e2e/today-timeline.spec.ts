import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { connectVerifiedDatabase } from "@personal-ai/db/client";
import { loadDatabaseConfig } from "@personal-ai/db/config";
import { desktopCommandRequests, focusSessionSegmentRuns, focusSessions, focusStructureSegments, focusStructures, focusTimerJobs, reminderJobs, taskConflictAcceptances, taskFeedback, taskLegacyMetadata, taskLifecycleEvents, taskOutcomes, tasks } from "@personal-ai/db/schema";
import { eq, inArray, or } from "drizzle-orm";

const apiBase = process.env.PLAYWRIGHT_API_BASE_URL ?? "http://127.0.0.1:3100";
const halfHourPixels = 36;
const reservedDates = new Set<string>();

async function isolatedDate(request: APIRequestContext): Promise<string> {
  const startOffset = Date.now() % 3_000;
  for (let attempt = 0; attempt < 3_650; attempt += 1) {
    const date = new Date(Date.UTC(2090, 0, 1 + ((startOffset + attempt) % 3_650))).toISOString().slice(0, 10);
    if (reservedDates.has(date)) continue;
    const response = await request.get(`${apiBase}/api/v1/tasks?date=${date}`);
    if (!response.ok()) throw new Error(`Unable to inspect isolated timeline date ${date}.`);
    const body = await response.json() as { tasks: unknown[] };
    if (body.tasks.length === 0) {
      reservedDates.add(date);
      return date;
    }
  }
  throw new Error("No empty timeline date was available in the E2E isolation range.");
}

async function createExactTask(
  page:Page,
  title:string,
  start:string,
  end:string,
  confirmConflict?: (dialog: ReturnType<Page["getByRole"]>) => Promise<void>
) {
  await page.getByRole("button", { name: "完整添加" }).click();
  await page.getByLabel("任务标题").fill(title);
  await page.getByLabel("排期方式").selectOption("exact");
  await page.getByLabel("开始时间").fill(start);
  await page.getByLabel("结束时间").fill(end);
  const requestPromise=page.waitForRequest((request)=>request.url()===`${apiBase}/api/v1/tasks`&&request.method()==="POST");
  const responsePromise=page.waitForResponse((response)=>response.url()===`${apiBase}/api/v1/tasks`&&response.request().method()==="POST");
  await page.getByRole("button", { name: "保存任务" }).click();
  const request=await requestPromise;
  let response=await responsePromise;
  const body=request.postDataJSON() as Record<string, unknown>;
  expect(body).not.toHaveProperty("plannedEffortMinutes");
  expect(body).not.toHaveProperty("difficulty");
  expect(body).not.toHaveProperty("taskType");
  expect(body).not.toHaveProperty("requiresContinuousFocus");
  if (confirmConflict) {
    if (response.status() !== 409) {
      throw new Error(`Expected a schedule conflict, but task creation returned ${response.status()}.`);
    }
    const conflictDialog=page.getByRole("alertdialog",{name:"这项安排与现有任务重叠"});
    await expect(conflictDialog).toBeVisible();
    const kept=page.waitForResponse((candidateResponse)=>candidateResponse.url()===`${apiBase}/api/v1/tasks`
      &&candidateResponse.request().method()==="POST"&&candidateResponse.status()===201);
    await confirmConflict(conflictDialog);
    response=await kept;
  } else if (response.status() !== 201) {
    throw new Error(`Unexpected task creation response ${response.status()}: ${await response.text()}`);
  }
  return (await response.json()).task as {id:string;version:number;startAt:string;endAt:string};
}

async function cleanup(request:APIRequestContext, ids:string[]) {
  if(!ids.length)return;
  const {client,db}=await connectVerifiedDatabase(loadDatabaseConfig());
  try{await db.transaction(async(tx)=>{
    await tx.delete(desktopCommandRequests).where(inArray(desktopCommandRequests.taskId,ids));
    await tx.delete(reminderJobs).where(inArray(reminderJobs.taskId,ids));
    await tx.delete(taskConflictAcceptances).where(or(inArray(taskConflictAcceptances.taskIdLow,ids),inArray(taskConflictAcceptances.taskIdHigh,ids)));
    await tx.delete(taskFeedback).where(inArray(taskFeedback.taskId,ids));
    await tx.delete(taskOutcomes).where(inArray(taskOutcomes.taskId,ids));
    const sessions=await tx.select({id:focusSessions.id}).from(focusSessions).where(inArray(focusSessions.taskId,ids));
    if(sessions.length){const sessionIds=sessions.map(session=>session.id);await tx.delete(focusTimerJobs).where(inArray(focusTimerJobs.focusSessionId,sessionIds));await tx.delete(focusSessionSegmentRuns).where(inArray(focusSessionSegmentRuns.focusSessionId,sessionIds));await tx.delete(focusSessions).where(inArray(focusSessions.id,sessionIds));}
    const structures=await tx.select({id:focusStructures.id}).from(focusStructures).where(inArray(focusStructures.taskId,ids));
    if(structures.length){const structureIds=structures.map(structure=>structure.id);await tx.delete(focusStructureSegments).where(inArray(focusStructureSegments.focusStructureId,structureIds));await tx.delete(focusStructures).where(inArray(focusStructures.id,structureIds));}
    await tx.delete(taskLegacyMetadata).where(inArray(taskLegacyMetadata.taskId,ids));
    await tx.delete(taskLifecycleEvents).where(inArray(taskLifecycleEvents.taskId,ids));
    await tx.delete(tasks).where(inArray(tasks.id,ids));
  });}finally{await client.end();}
}

async function timelinePoint(page:Page, hour:number, minute=0){
  const line=page.locator(".hour-line").filter({hasText:`${String(hour).padStart(2,"0")}:00`});
  await line.scrollIntoViewIfNeeded();
  const lineBox=await line.boundingBox();expect(lineBox).not.toBeNull();
  const grid=await page.locator(".day-grid").boundingBox();expect(grid).not.toBeNull();
  return {x:grid!.x+Math.min(180,grid!.width-20),y:lineBox!.y+Math.max(1,minute/60*72)};
}

test.describe("真实今日时间轴",()=>{
  test("时间轴和完整表单共同限制为07:00至23:00",async({page,request})=>{
    const testDate=await isolatedDate(request);
    await page.goto("/");
    await page.getByLabel("时间轴日期").fill(testDate);
    const labels=await page.locator(".hour-line time").allTextContents();
    expect(labels).toHaveLength(17);
    expect(labels[0]).toBe("07:00");
    expect(labels.at(-1)).toBe("23:00");
    await page.getByRole("button",{name:"完整添加"}).click();
    await page.getByLabel("任务标题").fill("不应进入清晨的任务");
    await page.getByLabel("开始时间").fill("06:30");
    await page.getByLabel("结束时间").fill("07:30");
    await page.getByRole("button",{name:"保存任务"}).click();
    expect(await page.getByLabel("开始时间").evaluate(input=>(input as HTMLInputElement).validity.rangeUnderflow)).toBe(true);
    await expect(page.getByRole("dialog",{name:"让这项安排足够清楚"})).toBeVisible();
  });

  test("创建、刷新、拖动、拉伸、保留冲突并再次刷新",async({page,request})=>{
    const suffix=Date.now().toString(36);const ids:string[]=[];
    const testDate=await isolatedDate(request);
    const firstTitle=`E2E 深度任务 ${suffix}`;const secondTitle=`E2E 冲突任务 ${suffix}`;
    try{
      await page.goto("/");
      await expect(page.getByRole("heading",{name:"把今天放回时间里。"})).toBeVisible();
      await page.getByLabel("时间轴日期").fill(testDate);
      const first=await createExactTask(page,firstTitle,"13:00","13:30");ids.push(first.id);
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
      const movedTask=(await (await moved).json()).task as {startAt:string};
      expect(movedTask.startAt).toContain("05:30:00.000Z");

      const handle=page.locator(`[data-task-id="${first.id}"] .resize-handle`);
      await handle.scrollIntoViewIfNeeded();const handleBox=await handle.boundingBox();expect(handleBox).not.toBeNull();
      const resized=page.waitForResponse((response)=>response.url().endsWith(`/api/v1/tasks/${first.id}`)&&response.request().method()==="PATCH"&&response.status()===200);
      const resizeStartY=handleBox!.y+handleBox!.height/2;
      await page.mouse.move(handleBox!.x+handleBox!.width/2,resizeStartY);
      await page.mouse.down();await page.mouse.move(handleBox!.x+handleBox!.width/2,resizeStartY+halfHourPixels,{steps:4});await page.mouse.up();
      const resizedTask=(await (await resized).json()).task as {endAt:string};
      expect(resizedTask.endAt).toContain("06:30:00.000Z");

      const second=await createExactTask(page,secondTitle,"14:00","15:00",async(conflictDialog)=>{
        await expect(conflictDialog).toContainText(firstTitle);
        await expect(conflictDialog).toContainText("13:30–14:30");
        await conflictDialog.getByRole("button",{name:"明确保留全部冲突"}).click();
      });ids.push(second.id);
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

  test("冲突确认返回调整时保留表单内容且不显示保存失败",async({page,request})=>{
    const ids:string[]=[];const suffix=Date.now().toString(36);const testDate=await isolatedDate(request);
    try{
      await page.goto("/");
      await page.getByLabel("时间轴日期").fill(testDate);
      const first=await createExactTask(page,`E2E 返回调整基准 ${suffix}`,"13:00","14:00");ids.push(first.id);
      await page.getByRole("button",{name:"完整添加"}).click();
      await page.getByLabel("任务标题").fill(`E2E 返回调整候选 ${suffix}`);
      await page.getByLabel("排期方式").selectOption("exact");
      await page.getByLabel("开始时间").fill("13:00");
      await page.getByLabel("结束时间").fill("14:00");
      await page.getByRole("button",{name:"保存任务"}).click();
      const conflictDialog=page.getByRole("alertdialog",{name:"这项安排与现有任务重叠"});
      await expect(conflictDialog).toBeVisible();
      await conflictDialog.getByRole("button",{name:"返回调整",exact:true}).click();
      await expect(conflictDialog).toBeHidden();
      await expect(page.getByRole("dialog",{name:"让这项安排足够清楚"})).toBeVisible();
      await expect(page.getByLabel("任务标题")).toHaveValue(`E2E 返回调整候选 ${suffix}`);
      await expect(page.locator(".timeline-alert")).toHaveCount(0);
    }finally{await cleanup(request,ids);}
  });

  test("三个重叠任务使用稳定可读车道，移动端在时间轴内部横向查看并保持可编辑",async({page,request})=>{
    const ids:string[]=[];const suffix=Date.now().toString(36);const testDate=await isolatedDate(request);
    const titles=[`E2E 三车道 A ${suffix}`,`E2E 三车道 B ${suffix}`,`E2E 三车道 C ${suffix}`];
    try{
      await page.goto("/");
      await page.getByLabel("时间轴日期").fill(testDate);
      const first=await createExactTask(page,titles[0]!,"13:00","14:00");ids.push(first.id);
      const second=await createExactTask(page,titles[1]!,"13:00","14:00",async(dialog)=>{
        await expect(dialog).toContainText(titles[0]!);
        await dialog.getByRole("button",{name:"明确保留全部冲突"}).click();
      });ids.push(second.id);
      const third=await createExactTask(page,titles[2]!,"13:00","14:00",async(dialog)=>{
        await expect(dialog.locator("li")).toHaveCount(2);
        await expect(dialog).toContainText(titles[0]!);
        await expect(dialog).toContainText(titles[1]!);
        await dialog.getByRole("button",{name:"明确保留全部冲突"}).click();
      });ids.push(third.id);

      const blocks=ids.map(id=>page.locator(`[data-task-id="${id}"]`));
      const initialLanes=new Map<string,string>();
      for(let index=0;index<blocks.length;index+=1){
        await expect(blocks[index]!).toHaveAttribute("data-lane-count","3");
        const lane=await blocks[index]!.getAttribute("data-lane-index");
        expect(lane).not.toBeNull();
        initialLanes.set(ids[index]!,lane!);
        await expect(blocks[index]!).toContainText(`冲突车道 ${lane}/3`);
      }
      expect(new Set(initialLanes.values())).toEqual(new Set(["1","2","3"]));
      const boxes=await Promise.all(blocks.map(block=>block.boundingBox()));
      expect(boxes.every(Boolean)).toBe(true);
      const sortedBoxes=boxes.filter((box):box is NonNullable<typeof box>=>box!==null).sort((left,right)=>left.x-right.x);
      expect(sortedBoxes[0]!.x+sortedBoxes[0]!.width).toBeLessThanOrEqual(sortedBoxes[1]!.x+1);
      expect(sortedBoxes[1]!.x+sortedBoxes[1]!.width).toBeLessThanOrEqual(sortedBoxes[2]!.x+1);

      await page.reload();
      await page.getByLabel("时间轴日期").fill(testDate);
      for(let index=0;index<ids.length;index+=1){
        await expect(page.locator(`[data-task-id="${ids[index]}"]`)).toHaveAttribute("data-lane-index",initialLanes.get(ids[index]!)!);
      }

      await page.setViewportSize({width:390,height:844});
      await page.reload();
      await page.getByLabel("时间轴日期").fill(testDate);
      const scrollMetrics=await page.locator(".day-scroll").evaluate(element=>({scrollWidth:element.scrollWidth,clientWidth:element.clientWidth}));
      expect(scrollMetrics.scrollWidth).toBeGreaterThan(scrollMetrics.clientWidth);
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth)).toBe(true);
      const thirdBlock=page.locator(`[data-task-id="${third.id}"]`);
      await thirdBlock.scrollIntoViewIfNeeded();
      await thirdBlock.getByRole("button",{name:`打开 ${titles[2]} 的任务操作`}).click();
      await thirdBlock.getByRole("button",{name:"编辑任务",exact:true}).click();
      await expect(page.getByRole("dialog",{name:"让这项安排足够清楚"})).toBeVisible();
      await expect(page.getByLabel("任务标题")).toHaveValue(titles[2]!);
    }finally{await cleanup(request,ids);}
  });

  test("单击空白时间不创建任务，拖动 30 分钟才打开创建表单",async({page,request})=>{
    const ids:string[]=[];const title=`E2E 空白创建 ${Date.now().toString(36)}`;const testDate=await isolatedDate(request);
    try{
      await page.goto("/");
      const dateLoaded=page.waitForResponse((response)=>response.url()===`${apiBase}/api/v1/tasks?date=${testDate}`&&response.request().method()==="GET"&&response.status()===200);
      await page.getByLabel("时间轴日期").fill(testDate);
      await dateLoaded;
      const point=await timelinePoint(page,9);
      const clickX=point.x;const clickY=point.y;
      await page.mouse.click(clickX,clickY);
      await expect(page.locator(".range-anchor")).toHaveCount(0);
      await expect(page.getByRole("dialog")).toHaveCount(0);

      await page.mouse.move(clickX,clickY);await page.mouse.down();
      await expect(page.locator(".range-anchor")).toBeVisible();
      await page.mouse.move(clickX,clickY+halfHourPixels,{steps:4});
      await expect(page.locator(".range-preview")).toContainText("09:00–09:30");
      await page.mouse.up();
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

  test("拖动终点回到起点时取消空白创建",async({page,request})=>{
    const title=`E2E 不应创建 ${Date.now().toString(36)}`;const testDate=await isolatedDate(request);let taskCreates=0;
    page.on("request",(outgoing)=>{if(outgoing.url()===`${apiBase}/api/v1/tasks`&&outgoing.method()==="POST")taskCreates+=1;});
    try{
      await page.goto("/");
      const dateLoaded=page.waitForResponse((response)=>response.url()===`${apiBase}/api/v1/tasks?date=${testDate}`&&response.request().method()==="GET"&&response.status()===200);
      await page.getByLabel("时间轴日期").fill(testDate);await dateLoaded;
      const point=await timelinePoint(page,9);
      const x=point.x;const startY=point.y;const endY=startY+36;
      await page.mouse.move(x,startY);await page.mouse.down();await expect(page.locator(".range-anchor")).toBeVisible();
      await page.mouse.move(x,startY-36);await expect(page.locator(".range-preview")).toContainText("08:30–09:00");await expect(page.locator(".range-anchor")).toBeVisible();
      await page.mouse.move(x,endY);await expect(page.locator(".range-preview")).toContainText("09:00–09:30");
      await page.mouse.move(x,startY);await expect(page.locator(".range-preview")).toHaveCount(0);await expect(page.locator(".range-anchor")).toBeVisible();await page.mouse.up();
      await expect(page.locator(".range-anchor")).toHaveCount(0);
      await expect(page.getByRole("dialog")).toHaveCount(0);expect(taskCreates).toBe(0);
      await expect(page.getByText(title,{exact:true})).toHaveCount(0);
    }finally{}
  });

  test("点击今天已过去时段可补录、记录结果并刷新恢复",async({page,request})=>{
    const ids:string[]=[];const title=`E2E 当天补录 ${Date.now().toString(36)}`;
    const currentDate=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
    const {client,db}=await connectVerifiedDatabase(loadDatabaseConfig());
    try{
      await page.goto("/");
      await expect(page.getByLabel("时间轴日期")).toHaveValue(currentDate);
      const scroll=page.locator(".day-scroll");
      await scroll.evaluate((element)=>{element.scrollTop=0;});
      const box=await scroll.boundingBox();expect(box).not.toBeNull();
      const clickX=box!.x+Math.min(180,box!.width-20);const clickY=box!.y+8;
      await page.mouse.move(clickX,clickY);await page.mouse.down();
      await expect(page.locator(".range-anchor")).toBeVisible();
      await expect(page.locator(".range-preview.backfill")).toHaveCount(0);
      await page.mouse.up();

      const backfillDialog=page.getByRole("dialog",{name:"补上今天已经发生的事项"});
      await expect(backfillDialog).toBeVisible();
      await expect(backfillDialog).toContainText("不会发送提醒或启动专注");
      await expect(page.getByLabel("开始时间")).toHaveValue("07:00");
      await expect(page.getByLabel("结束时间")).toHaveValue("07:30");
      await page.getByLabel("任务标题").fill(title);
      const firstAttempt=page.waitForResponse((response)=>response.url()===`${apiBase}/api/v1/tasks/backfill`&&response.request().method()==="POST");
      await page.getByRole("button",{name:"保存并记录结果"}).click();
      let createdResponse=await firstAttempt;
      if(createdResponse.status()===409){
        const conflictDialog=page.getByRole("alertdialog",{name:"这项安排与现有任务重叠"});
        await expect(conflictDialog).toBeVisible();
        const kept=page.waitForResponse((response)=>response.url()===`${apiBase}/api/v1/tasks/backfill`&&response.request().method()==="POST"&&response.status()===201);
        await conflictDialog.getByRole("button",{name:"明确保留全部冲突"}).click();
        createdResponse=await kept;
      }
      expect(createdResponse.status()).toBe(201);
      const task=(await createdResponse.json()).task as {id:string;lifecycleStatus:string};ids.push(task.id);
      expect(task.lifecycleStatus).toBe("awaiting_outcome");

      const outcomeDialog=page.getByRole("dialog",{name:"记录这次完成情况"});
      await expect(outcomeDialog).toBeVisible();
      await outcomeDialog.getByRole("button",{name:"部分完成"}).click();
      await outcomeDialog.getByLabel("客观进度").fill("60");
      await outcomeDialog.getByRole("button",{name:"一般",exact:true}).click();
      await outcomeDialog.getByLabel("文字反馈（可选）").fill("补录时分别保存客观进度和主观感受");
      const outcomeSaved=page.waitForResponse((response)=>response.url().endsWith(`/api/v1/tasks/${task.id}/outcomes`)&&response.request().method()==="POST"&&response.status()===201);
      await outcomeDialog.getByRole("button",{name:"保存结果"}).click();
      const outcomeBody=await (await outcomeSaved).json() as {task:{currentOutcome:string};outcome:{progressPercent:number};feedback:{satisfaction:string}|null};
      expect(outcomeBody.task.currentOutcome).toBe("partial");
      expect(outcomeBody.outcome.progressPercent).toBe(60);
      expect(outcomeBody.feedback?.satisfaction).toBe("neutral");
      await expect(page.locator(`[data-task-id="${task.id}"]`)).toContainText(title);
      await expect(page.locator(`[data-task-id="${task.id}"]`)).toContainText("部分完成");

      const [persistedOutcome]=await db.select().from(taskOutcomes).where(eq(taskOutcomes.taskId,task.id));
      const [persistedFeedback]=await db.select().from(taskFeedback).where(eq(taskFeedback.taskId,task.id));
      expect(persistedOutcome).toMatchObject({outcome:"partial",progressPercent:60});
      expect(persistedFeedback).toMatchObject({satisfaction:"neutral",note:"补录时分别保存客观进度和主观感受"});

      await page.reload();
      await expect(page.locator(`[data-task-id="${task.id}"]`)).toContainText("07:00–07:30");
      await expect(page.locator(`[data-task-id="${task.id}"]`)).toContainText("部分完成");
    }finally{await cleanup(request,ids);await client.end();}
  });

  test("开放任务块支持键盘按30分钟移动和拉伸，并刷新恢复",async({page,request})=>{
    const ids:string[]=[];const title=`E2E 键盘排期 ${Date.now().toString(36)}`;const testDate=await isolatedDate(request);
    try{
      await page.goto("/");
      await page.getByLabel("时间轴日期").fill(testDate);
      const task=await createExactTask(page,title,"13:00","14:00");ids.push(task.id);
      const block=page.locator(`[data-task-id="${task.id}"]`);
      await block.focus();
      const moved=page.waitForResponse((response)=>response.url().endsWith(`/api/v1/tasks/${task.id}`)&&response.request().method()==="PATCH"&&response.status()===200);
      await page.keyboard.press("ArrowDown");
      const movedTask=(await (await moved).json()).task as {startAt:string;endAt:string};
      expect(movedTask.startAt).toContain("05:30:00.000Z");expect(movedTask.endAt).toContain("06:30:00.000Z");
      await expect(block).toHaveAttribute("aria-busy","false");
      await block.focus();
      const resized=page.waitForResponse((response)=>response.url().endsWith(`/api/v1/tasks/${task.id}`)&&response.request().method()==="PATCH"&&response.status()===200);
      await page.keyboard.press("Shift+ArrowDown");
      const resizedTask=(await (await resized).json()).task as {startAt:string;endAt:string};
      expect(resizedTask.startAt).toContain("05:30:00.000Z");expect(resizedTask.endAt).toContain("07:00:00.000Z");
      await page.reload();await page.getByLabel("时间轴日期").fill(testDate);
      await expect(page.locator(`[data-task-id="${task.id}"]`)).toContainText("13:30–15:00");
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
      const loose=page.locator(".task-summary-list article").filter({hasText:title});
      await loose.getByLabel(`打开 ${title} 的任务操作`).click();
      await page.getByRole("button",{name:"开始专注"}).click();
      await expect(page.getByRole("heading",{name:title})).toBeVisible();
      await page.getByRole("button",{name:"回到时间轴"}).click();
      await expect(page.locator(".task-summary-list article").filter({hasText:title})).toBeVisible();
    }finally{await cleanup(request,ids);}
  });

  test("任务列表默认三项，其他任务折叠，回收站通过图标搜索和恢复",async({page,request})=>{
    const ids:string[]=[];const testDate=await isolatedDate(request);const suffix=Date.now().toString(36);let deletedTitle="";
    try{
      for(let index=0;index<5;index+=1){
        const response=await request.post(`${apiBase}/api/v1/tasks`,{data:{title:`E2E 列表 ${index+1} ${suffix}`,scheduleKind:"none",localDate:testDate,timeZone:"Asia/Shanghai"}});
        expect(response.status()).toBe(201);
        const task=(await response.json()).task as {id:string;version:number;title:string};ids.push(task.id);
        if(index===4){deletedTitle=task.title;const removed=await request.delete(`${apiBase}/api/v1/tasks/${task.id}`,{data:{expectedVersion:task.version,reason:"e2e trash search"}});expect(removed.status()).toBe(204);}
      }
      await page.goto("/");
      await page.getByLabel("时间轴日期").fill(testDate);
      await expect(page.locator(".task-summary-list article")).toHaveCount(3);
      await page.getByRole("button",{name:"查看其他 1 项"}).click();
      await expect(page.locator(".task-summary-list article")).toHaveCount(4);
      await page.getByRole("button",{name:/打开回收站/}).click();
      const trashDialog=page.getByRole("dialog",{name:"查找并恢复任务"});
      await expect(trashDialog).toBeVisible();
      await trashDialog.getByLabel("搜索回收站任务").fill(deletedTitle);
      await expect(trashDialog.getByText(deletedTitle,{exact:true})).toBeVisible();
      await trashDialog.getByRole("button",{name:"恢复",exact:true}).click();
      await expect(trashDialog.getByText(deletedTitle,{exact:true})).toHaveCount(0);
      await trashDialog.getByRole("button",{name:"关闭回收站"}).click();
      await expect(page.locator(".task-summary-list article").filter({hasText:deletedTitle})).toBeVisible();
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
    await expect(page.getByLabel("预计投入（与时间块独立）")).toHaveCount(0);
    await expect(page.getByLabel("难度")).toHaveCount(0);
    await expect(page.getByLabel("任务类型")).toHaveCount(0);
    await expect(page.getByLabel("适合连续专注")).toHaveCount(0);
  });

  test("记录结果、刷新并重新打开任务",async({page,request})=>{
    const suffix=Date.now().toString(36); const ids:string[]=[];
    const title=`E2E 生命周期任务 ${suffix}`;const testDate=await isolatedDate(request);
    try {
      await page.goto("/");
      await page.getByLabel("时间轴日期").fill(testDate);
      const task=await createExactTask(page,title,"15:00","16:00"); ids.push(task.id);
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
      await block.getByLabel(`打开 ${title} 的任务操作`).click();
      await page.getByRole("button",{name:"结果历史",exact:true}).click();
      const historyDialog=page.getByRole("dialog",{name:"结果历史"});
      await expect(historyDialog).toBeVisible();
      await expect(historyDialog).toContainText("已完成");
      await expect(historyDialog).toContainText("100%");
      await expect(historyDialog).toContainText("软件记录");
      await historyDialog.getByRole("button",{name:"关闭结果历史"}).click();

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
