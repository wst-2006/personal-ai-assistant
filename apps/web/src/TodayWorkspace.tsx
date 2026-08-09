import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CalendarPlus, Check, CheckCircle2, ChevronDown, CircleDashed, GripHorizontal, HeartPulse, History, Leaf, Lightbulb, LoaderCircle, MoreHorizontal, Pencil, Play, RotateCcw, Sparkles, Trash2, X, XCircle } from "lucide-react";

type ScheduleKind = "none" | "daypart" | "exact";
type Daypart = "morning" | "afternoon" | "evening";
type Task = { id:string; title:string; lifecycleStatus:"open"|"active"|"awaiting_outcome"|"closed"|"cancelled"; currentOutcome:"not_completed"|"partial"|"complete"|null; scheduleKind:ScheduleKind; localDate:string|null; daypart:Daypart|null; startAt:string|null; endAt:string|null; timeZone:string; notes:string|null; version:number; scheduleRevision:number };
type InboxEntry = { id:string; entryKind:"idea"|"question"; content:string; notes:string|null; version:number };
type Pair = { taskIdA:string; taskIdB:string; accepted:boolean };
type FormState = { entryMode:"schedule"|"backfill"; origin:"manual"|"health"|"plan_change"; advisoryReason:string|null; title:string; scheduleKind:ScheduleKind; localDate:string; daypart:Daypart; start:string; end:string; notes:string };
type DragState = { task:Task; mode:"move"|"resize"; startY:number; startMinute:number; endMinute:number; nextStart:number; nextEnd:number };
type RangeState = { pointerId:number; start:number; current:number; moved:boolean };
type Lane = { index:number; count:number };
type OutcomeDraft = { task:Task; outcome:"not_completed"|"partial"|"complete"; progress:string; satisfaction:"satisfied"|"neutral"|"dissatisfied"; note:string };
type TaskOutcomeRecord = { id:string; taskId:string; focusSessionId:string|null; outcome:"not_completed"|"partial"|"complete"; progressPercent:number; source:"app"|"ai"|"feishu"|"system"; note:string|null; recordedAt:string };
type OutcomeHistory = { task:Task; outcomes:TaskOutcomeRecord[] };
type ConflictDetail = { taskId:string; title:string; startAt:string; endAt:string; lifecycleStatus:Task["lifecycleStatus"]; scheduleRevision:number; accepted:boolean };
type ConflictPrompt = { conflicts:ConflictDetail[]; fingerprint:string; resolve:(decision:"keep"|"return")=>void };
type HealthTaskDraft = { requestId:string; title:string; localDate:string; notes:string };
export type PlanChangeTaskEditRequest = {
  requestId:string;
  taskId:string;
  expectedVersion:number;
  expectedScheduleRevision:number;
  scheduleKind:ScheduleKind;
  localDate:string|null;
  daypart:Daypart|null;
  startAt:string|null;
  endAt:string|null;
  timeZone:"Asia/Shanghai";
  reason:string;
};
type HealthDaySummary = {
  plan:{ id:string; city:string|null; solarTerm:string; weekStart:string };
  day:{ localDate:string; content:{
    nutritionDirection:string;
    seasonalVegetables:string[];
    movement:{ category:"strength"|"volleyball"|"running"|"cycling"|"recovery"|"rest"; durationMinutes:{minimum:number;maximum:number}; intensity:"rest"|"low"|"moderate"|"high"; safetyReminder:string };
  }};
};
class ConflictDecisionCancelledError extends Error {}

const API = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3000";
const TIMELINE_STEP_MINUTES = 30;
const LAST_TIMELINE_MINUTE = 23 * 60 + 30;
const HOUR_PX = 72;
const DAY_PX = HOUR_PX * 24;
const MIN_READABLE_LANE_PX = 128;
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone:"Asia/Shanghai", year:"numeric", month:"2-digit", day:"2-digit" }).format(new Date());
const localDateOf = (value:string) => new Intl.DateTimeFormat("en-CA", { timeZone:"Asia/Shanghai", year:"numeric", month:"2-digit", day:"2-digit" }).format(new Date(value));
const iso = (date:string,time:string) => `${date}T${time}:00+08:00`;
const timeFormatter = new Intl.DateTimeFormat("en-GB", { timeZone:"Asia/Shanghai", hour:"2-digit", minute:"2-digit", hour12:false });
const minuteOf = (value:string|null) => {
  if (!value) return 0;
  const parts = timeFormatter.formatToParts(new Date(value));
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0) % 24;
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
};
const hhmm = (minute:number) => `${String(Math.floor(minute/60)).padStart(2,"0")}:${String(minute%60).padStart(2,"0")}`;
const snapTimelineMinute = (minute:number) => Math.max(0, Math.min(LAST_TIMELINE_MINUTE, Math.round(minute/TIMELINE_STEP_MINUTES)*TIMELINE_STEP_MINUTES));
const isTimelineMinute = (minute:number) => minute % TIMELINE_STEP_MINUTES === 0;
const earliestTodayMinute = () => Math.min(24 * 60, (Math.floor(minuteOf(new Date().toISOString()) / TIMELINE_STEP_MINUTES) + 1) * TIMELINE_STEP_MINUTES);
const earliestAllowedMinute = (date:string) => date===today() ? earliestTodayMinute() : 0;
const emptyForm = (date=today(), start?:string, end?:string, entryMode:FormState["entryMode"]="schedule"):FormState => {
  const defaultStart = Math.min(earliestAllowedMinute(date), LAST_TIMELINE_MINUTE-TIMELINE_STEP_MINUTES);
  const startMinute = start ? Number(start.slice(0,2))*60+Number(start.slice(3)) : defaultStart;
  return { entryMode, origin:"manual", advisoryReason:null, title:"", scheduleKind:"exact", localDate:date, daypart:"morning", start:start ?? hhmm(startMinute), end:end ?? hhmm(Math.min(LAST_TIMELINE_MINUTE,startMinute+TIMELINE_STEP_MINUTES)), notes:"" };
};
const normalizedTimelineRange = (anchor:number,current:number) => {
  const low=Math.min(anchor,current);const high=Math.max(anchor,current);
  const start=Math.min(low,LAST_TIMELINE_MINUTE-TIMELINE_STEP_MINUTES);
  const end=high-low>=TIMELINE_STEP_MINUTES?Math.min(LAST_TIMELINE_MINUTE,Math.max(start+TIMELINE_STEP_MINUTES,high)):start+TIMELINE_STEP_MINUTES;
  return {start,end};
};

function assignLanes(tasks:Task[]):Map<string,Lane> {
  const sorted = [...tasks].sort((left,right)=>minuteOf(left.startAt)-minuteOf(right.startAt) || minuteOf(left.endAt)-minuteOf(right.endAt) || left.id.localeCompare(right.id));
  const result = new Map<string,Lane>();
  let group:Task[]=[]; let groupEnd=-1;
  const placeGroup=()=>{
    if (!group.length) return;
    const laneEnds:number[]=[]; const placed:Array<{task:Task;index:number}>=[];
    for (const task of group) {
      const start=minuteOf(task.startAt); const end=minuteOf(task.endAt);
      let index=laneEnds.findIndex((laneEnd)=>laneEnd<=start);
      if(index<0) index=laneEnds.length;
      laneEnds[index]=end; placed.push({task,index});
    }
    for(const item of placed) result.set(item.task.id,{index:item.index,count:laneEnds.length});
  };
  for(const task of sorted){
    const start=minuteOf(task.startAt); const end=minuteOf(task.endAt);
    if(group.length&&start>=groupEnd){placeGroup();group=[];groupEnd=-1;}
    group.push(task);groupEnd=Math.max(groupEnd,end);
  }
  placeGroup();
  return result;
}

async function json<T>(path:string, method="GET", body?:unknown):Promise<T> {
  const response = await fetch(`${API}${path}`, { method, headers:body?{"content-type":"application/json"}:undefined, body:body?JSON.stringify(body):undefined });
  const data = response.status === 204 ? {} : await response.json().catch(()=>({}));
  if (!response.ok) throw Object.assign(new Error(data.error ?? `HTTP ${response.status}`), { status:response.status, body:data });
  return data as T;
}

const healthActivityLabel:Record<HealthDaySummary["day"]["content"]["movement"]["category"],string>={strength:"力量训练",volleyball:"排球",running:"跑步",cycling:"骑行",recovery:"轻量恢复",rest:"休息"};
const healthIntensityLabel:Record<HealthDaySummary["day"]["content"]["movement"]["intensity"],string>={rest:"休息",low:"低强度",moderate:"中等强度",high:"高强度"};

export function TodayWorkspace({ onFocus, onOpenHealth, healthTaskDraft, onHealthTaskDraftConsumed, planChangeTaskEditRequest, onPlanChangeTaskEditRequestConsumed, refreshToken=0 }:{ onFocus:(id:string)=>void; onOpenHealth:()=>void; healthTaskDraft?:HealthTaskDraft|null; onHealthTaskDraftConsumed?:()=>void; planChangeTaskEditRequest?:PlanChangeTaskEditRequest|null; onPlanChangeTaskEditRequestConsumed?:()=>void; refreshToken?:number }) {
  const [date,setDate]=useState(today());
  const [tasks,setTasks]=useState<Task[]>([]); const [inbox,setInbox]=useState<InboxEntry[]>([]); const [trash,setTrash]=useState<Task[]>([]);
  const [pairs,setPairs]=useState<Pair[]>([]); const [history,setHistory]=useState<Pair[]>([]);
  const [form,setForm]=useState<FormState|null>(null); const [editing,setEditing]=useState<Task|null>(null); const [source,setSource]=useState<InboxEntry|null>(null);
  const [quickKind,setQuickKind]=useState<"task"|"idea"|"question">("task"); const [quick,setQuick]=useState("");
  const [busy,setBusy]=useState(false); const [error,setError]=useState<string|null>(null); const [preview,setPreview]=useState<Record<string,{start:number;end:number}>>({});
  const [actionTaskId,setActionTaskId]=useState<string|null>(null); const [outcomeDraft,setOutcomeDraft]=useState<OutcomeDraft|null>(null);
  const [outcomeHistory,setOutcomeHistory]=useState<OutcomeHistory|null>(null); const [historyLoading,setHistoryLoading]=useState(false);
  const [range,setRange]=useState<RangeState|null>(null);
  const [conflictPrompt,setConflictPrompt]=useState<ConflictPrompt|null>(null);
  const [healthSummary,setHealthSummary]=useState<HealthDaySummary|null>(null); const [healthExpanded,setHealthExpanded]=useState(false);
  const scrollRef=useRef<HTMLDivElement>(null); const dragRef=useRef<DragState|null>(null); const rangeRef=useRef<RangeState|null>(null);
  const loadRequestRef=useRef(0);

  const load=useCallback(async()=>{ const requestId=++loadRequestRef.current;setError(null);try{const [taskData,inboxData,trashData,healthData]=await Promise.all([json<{tasks:Task[];blockingConflicts:Pair[];historicalOverlaps:Pair[]}>(`/api/v1/tasks?date=${date}`),json<InboxEntry[]>("/api/v1/inbox-entries"),json<{tasks:Task[]}>("/api/v1/tasks/trash"),json<{reference:HealthDaySummary|null}>(`/api/v1/health/days/${date}`).catch(()=>({reference:null}))]);if(requestId!==loadRequestRef.current)return;setTasks(taskData.tasks);setPairs(taskData.blockingConflicts);setHistory(taskData.historicalOverlaps);setInbox(inboxData);setTrash(trashData.tasks);setHealthSummary(healthData.reference);}catch(error){if(requestId!==loadRequestRef.current)return;throw error;}},[date]);
  useEffect(()=>{ void load().catch(()=>setError("无法读取安排，请确认 API 正在运行。")); },[load,refreshToken]);
  useEffect(()=>{if(error!=="无法读取安排，请确认 API 正在运行。")return;const timer=window.setTimeout(()=>void load().catch(()=>setError("无法读取安排，请确认 API 正在运行。")),5_000);return()=>window.clearTimeout(timer);},[error,load]);
  useEffect(()=>{ const exact=tasks.filter(t=>t.scheduleKind==="exact"&&t.startAt).sort((a,b)=>minuteOf(a.startAt)-minuteOf(b.startAt)); const target=date===today()?minuteOf(new Date().toISOString()):exact.length?minuteOf(exact[0]!.startAt):480; requestAnimationFrame(()=>scrollRef.current?.scrollTo({top:Math.max(0,target/60*HOUR_PX-160)})); },[date,tasks.length]);
  useEffect(()=>{if(!healthTaskDraft)return;setDate(healthTaskDraft.localDate);setEditing(null);setSource(null);setForm({entryMode:"schedule",origin:"health",advisoryReason:null,title:healthTaskDraft.title,scheduleKind:"exact",localDate:healthTaskDraft.localDate,daypart:"morning",start:"",end:"",notes:healthTaskDraft.notes});onHealthTaskDraftConsumed?.();},[healthTaskDraft?.requestId]);
  useEffect(()=>{
    if(!planChangeTaskEditRequest)return;
    let cancelled=false;
    const request=planChangeTaskEditRequest;
    setBusy(true);setError(null);
    void json<{task:Task}>(`/api/v1/tasks/${request.taskId}`).then(({task})=>{
      if(cancelled)return;
      if(task.version!==request.expectedVersion||task.scheduleRevision!==request.expectedScheduleRevision){setError("这条协商候选已经过期：任务在协商后发生了变化。请重新打开任务发起协商。");return;}
      if(task.lifecycleStatus!=="open"){setError("这项任务当前不能调整排期；专注中、等待结果、已关闭或已取消的任务不会被协商候选移动。");return;}
      const targetDate=request.scheduleKind==="exact"&&request.startAt?localDateOf(request.startAt):request.localDate??date;
      setDate(targetDate);setEditing(task);setSource(null);
      setForm({entryMode:"schedule",origin:"plan_change",advisoryReason:request.reason,title:task.title,scheduleKind:request.scheduleKind,localDate:targetDate,daypart:request.daypart??"morning",start:request.startAt?hhmm(minuteOf(request.startAt)):"",end:request.endAt?hhmm(minuteOf(request.endAt)):"",notes:task.notes??""});
    }).catch(()=>{if(!cancelled)setError("无法重新读取这项任务，协商候选没有应用。请确认 API 正在运行后重试。");}).finally(()=>{if(!cancelled){setBusy(false);onPlanChangeTaskEditRequestConsumed?.();}});
    return()=>{cancelled=true;};
  },[planChangeTaskEditRequest?.requestId]);

  const exact=useMemo(()=>tasks.filter(t=>t.scheduleKind==="exact"&&t.startAt&&t.endAt&&t.lifecycleStatus!=="cancelled"),[tasks]);
  const other=useMemo(()=>tasks.filter(t=>t.scheduleKind!=="exact"&&t.lifecycleStatus!=="cancelled"),[tasks]);
  const cancelled=useMemo(()=>tasks.filter(t=>t.lifecycleStatus==="cancelled"),[tasks]);
  const lanes=useMemo(()=>assignLanes(exact),[exact]);
  const maximumLaneCount=useMemo(()=>Math.max(1,...Array.from(lanes.values(),lane=>lane.count)),[lanes]);
  const timelineMinimumWidth=maximumLaneCount>=3?maximumLaneCount*MIN_READABLE_LANE_PX:undefined;
  const conflict=(id:string)=>pairs.some(p=>p.taskIdA===id||p.taskIdB===id); const historical=(id:string)=>history.some(p=>p.taskIdA===id||p.taskIdB===id);
  const rangePreview=range?.moved&&range.start!==range.current?normalizedTimelineRange(range.start,range.current):null;

  function requestConflictDecision(conflicts:ConflictDetail[], fingerprint:string):Promise<"keep"|"return"> { return new Promise(resolve=>setConflictPrompt({conflicts,fingerprint,resolve})); }
  function resolveConflictPrompt(decision:"keep"|"return"){ const prompt=conflictPrompt;setConflictPrompt(null);prompt?.resolve(decision); }
  async function withConflict(path:string,method:string,payload:Record<string,unknown>) { let currentPayload=payload;for(let attempt=0;attempt<3;attempt+=1){try{return await json<any>(path,method,currentPayload);}catch(e:any){if(!["task_time_conflict","conflict_set_changed"].includes(e.body?.error)||!e.body.conflictSetFingerprint)throw e;const decision=await requestConflictDecision((e.body.conflicts??[]) as ConflictDetail[],e.body.conflictSetFingerprint);if(decision!=="keep")throw new ConflictDecisionCancelledError();const acceptance={conflictDecision:"keep",expectedConflictFingerprint:e.body.conflictSetFingerprint};currentPayload=path.includes("/inbox-entries/")?{...payload,task:{...(payload.task as Record<string,unknown>),...acceptance}}:{...payload,...acceptance};}}throw new Error("conflict_set_kept_changing"); }
  function payload(value:FormState){ const schedule=value.scheduleKind==="none"?{localDate:value.localDate||null,daypart:null,startAt:null,endAt:null}:value.scheduleKind==="daypart"?{localDate:value.localDate,daypart:value.daypart,startAt:null,endAt:null}:{localDate:null,daypart:null,startAt:iso(value.localDate,value.start),endAt:iso(value.localDate,value.end)};return { title:value.title.trim(), scheduleKind:value.scheduleKind, ...schedule, timeZone:"Asia/Shanghai", notes:value.notes.trim()||null }; }
  async function saveForm(e:React.FormEvent){
    e.preventDefault();
    if(!form?.title.trim())return;
    if(form.scheduleKind==="exact"){
      const start=Number(form.start.slice(0,2))*60+Number(form.start.slice(3));
      const end=Number(form.end.slice(0,2))*60+Number(form.end.slice(3));
      if(!isTimelineMinute(start)||!isTimelineMinute(end)){setError("精确任务的开始和结束时间必须使用 30 分钟间隔。");return;}
      if(end-start<TIMELINE_STEP_MINUTES){setError("精确任务的结束时间必须至少晚于开始时间 30 分钟。");return;}
      if(end>LAST_TIMELINE_MINUTE){setError("第一版不支持跨越午夜，最晚结束时间为 23:30。");return;}
      const earliest=earliestAllowedMinute(form.localDate);
      if(form.entryMode==="backfill"){
        if(form.localDate!==today()||start>=earliest||end>earliest){setError(`当天补录必须位于已经开始的时间范围内，最晚结束于 ${hhmm(earliest)}。`);return;}
      }else if(start<earliest){setError(`未来安排请从 ${hhmm(earliest)} 开始；过去时段请直接在时间轴上点击进行补录。`);return;}
    }
    setBusy(true);setError(null);
    try{
      const taskPayload=payload(form);let created:Task|null=null;
      if(form.entryMode==="backfill"){
        const result=await withConflict("/api/v1/tasks/backfill","POST",taskPayload);created=result.task as Task;
      }else if(source){
        await withConflict(`/api/v1/inbox-entries/${source.id}/convert-to-task`,`POST`,{confirmed:true,expectedVersion:source.version,task:taskPayload});
      }else if(editing){
        await withConflict(`/api/v1/tasks/${editing.id}`,`PATCH`,{expectedVersion:editing.version,expectedScheduleRevision:editing.scheduleRevision,...taskPayload});
      }else{
        await withConflict("/api/v1/tasks","POST",taskPayload);
      }
      setForm(null);setEditing(null);setSource(null);await load();
      if(created)setOutcomeDraft({task:created,outcome:"complete",progress:"100",satisfaction:"satisfied",note:""});
    }catch(err:any){
      if(err instanceof ConflictDecisionCancelledError)return;
      setError(err.body?.error==="inbox_entry_conflict"?"这条想法已被其他位置更新或转换，请刷新后重新整理。":err.body?.error==="task_schedule_revision_conflict"?"排期已在其他位置更新，请重新打开。":err.body?.error==="task_backfill_window_unavailable"?"这个补录区间已经超出今天当前可补录范围，请重新选择。":"保存失败，原内容仍在表单中。");
    }finally{setBusy(false);}
  }
  async function quickSave(e:React.FormEvent){e.preventDefault();if(!quick.trim())return;setBusy(true);try{if(quickKind==="task")await json("/api/v1/tasks","POST",{title:quick.trim(),scheduleKind:"none",localDate:date,timeZone:"Asia/Shanghai"});else await json("/api/v1/inbox-entries","POST",{entryKind:quickKind,content:quick.trim()});setQuick("");await load();}catch{setError("快速记录失败，内容没有丢失。");}finally{setBusy(false);}}
  function editTask(task:Task){setEditing(task);setSource(null);setForm({entryMode:"schedule",origin:"manual",advisoryReason:null,title:task.title,scheduleKind:task.scheduleKind,localDate:task.localDate??date,daypart:task.daypart??"morning",start:hhmm(minuteOf(task.startAt)),end:hhmm(minuteOf(task.endAt)),notes:task.notes??""});}
  function openOutcome(task:Task){setActionTaskId(null);setOutcomeDraft({task,outcome:"complete",progress:"100",satisfaction:"satisfied",note:""});}
  async function openOutcomeHistory(task:Task){setActionTaskId(null);setOutcomeHistory({task,outcomes:[]});setHistoryLoading(true);try{const detail=await json<{task:Task;outcomes:TaskOutcomeRecord[]}>(`/api/v1/tasks/${task.id}`);setOutcomeHistory({task:detail.task,outcomes:detail.outcomes});}catch{setOutcomeHistory(null);setError("无法读取任务结果历史，请刷新后重试。");}finally{setHistoryLoading(false);}}
  function chooseOutcome(outcome:"not_completed"|"partial"|"complete"){setOutcomeDraft(current=>current?{...current,outcome,progress:outcome==="complete"?"100":outcome==="not_completed"?"0":current.progress==="0"||current.progress==="100"?"50":current.progress}:current);}
  async function submitOutcome(e:React.FormEvent){e.preventDefault();if(!outcomeDraft)return;const progress=Number(outcomeDraft.progress);if(!Number.isInteger(progress)||(outcomeDraft.outcome==="complete"&&progress!==100)||(outcomeDraft.outcome==="not_completed"&&progress!==0)||(outcomeDraft.outcome==="partial"&&(progress<1||progress>99))){setError("请填写与结果一致的客观进度。");return;}setBusy(true);setError(null);try{await json(`/api/v1/tasks/${outcomeDraft.task.id}/outcomes`,`POST`,{expectedVersion:outcomeDraft.task.version,outcome:outcomeDraft.outcome,progressPercent:progress,source:"app",satisfaction:outcomeDraft.satisfaction,note:outcomeDraft.note.trim()||null});setOutcomeDraft(null);await load();}catch{setError("任务结果没有保存，请刷新后重试。");}finally{setBusy(false);}}
  async function runTaskAction(task:Task,action:"cancel"|"delete"|"reopen"|"restore"){if(action==="delete"&&!window.confirm("删除后任务将移入回收站，可以从当天页面恢复。是否继续？"))return;setBusy(true);setError(null);try{if(action==="cancel")await json(`/api/v1/tasks/${task.id}/cancel`,`POST`,{expectedVersion:task.version});else if(action==="delete")await json(`/api/v1/tasks/${task.id}`,`DELETE`,{expectedVersion:task.version});else await withConflict(`/api/v1/tasks/${task.id}/${action}`,`POST`,{expectedVersion:task.version});setActionTaskId(null);await load();}catch(err:any){if(err instanceof ConflictDecisionCancelledError)return;setError(err.body?.error==="task_version_conflict"?"任务已在其他位置更新，请刷新后重试。":"操作没有保存，任务状态保持不变。");}finally{setBusy(false);}}
  function outcomeLabelValue(outcome:Task["currentOutcome"]){return outcome==="complete"?"已完成":outcome==="partial"?"部分完成":outcome==="not_completed"?"未完成":"已结束";}
  function outcomeLabel(task:Task){return outcomeLabelValue(task.currentOutcome);}
  function actionMenu(task:Task){if(actionTaskId!==task.id||task.lifecycleStatus==="active")return null;return <div className="task-action-menu" onPointerDown={e=>e.stopPropagation()}>{task.lifecycleStatus==="open"&&<button onClick={()=>{setActionTaskId(null);editTask(task);}}><Pencil/>编辑任务</button>}{task.lifecycleStatus==="open"&&<button onClick={()=>{setActionTaskId(null);onFocus(task.id);}}><Play/>开始专注</button>}{(task.lifecycleStatus==="open"||task.lifecycleStatus==="awaiting_outcome")&&<button onClick={()=>openOutcome(task)}><CheckCircle2/>记录结果</button>}<button onClick={()=>void openOutcomeHistory(task)}><History/>结果历史</button>{task.lifecycleStatus==="open"&&<button onClick={()=>void runTaskAction(task,"cancel")}><XCircle/>取消任务</button>}{(task.lifecycleStatus==="closed"||task.lifecycleStatus==="cancelled")&&<button onClick={()=>void runTaskAction(task,"reopen")}><RotateCcw/>重新打开</button>}<button className="danger" onClick={()=>void runTaskAction(task,"delete")}><Trash2/>移入回收站</button></div>;}
  function beginPointer(e:React.PointerEvent,task:Task,mode:"move"|"resize"){if(task.lifecycleStatus!=="open")return;e.preventDefault();(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);const startMinute=minuteOf(task.startAt);const endMinute=minuteOf(task.endAt);dragRef.current={task,mode,startY:e.clientY,startMinute,endMinute,nextStart:startMinute,nextEnd:endMinute};}
  function movePointer(e:React.PointerEvent){const drag=dragRef.current;if(!drag)return;const delta=Math.round((e.clientY-drag.startY)/HOUR_PX*60/TIMELINE_STEP_MINUTES)*TIMELINE_STEP_MINUTES;const duration=drag.endMinute-drag.startMinute;const earliest=earliestAllowedMinute(date);const start=drag.mode==="move"?Math.max(earliest,Math.min(LAST_TIMELINE_MINUTE-duration,drag.startMinute+delta)):drag.startMinute;const end=drag.mode==="move"?start+duration:Math.max(start+TIMELINE_STEP_MINUTES,Math.min(LAST_TIMELINE_MINUTE,drag.endMinute+delta));drag.nextStart=start;drag.nextEnd=end;setPreview(p=>({...p,[drag.task.id]:{start,end}}));}
  async function endPointer(){const drag=dragRef.current;if(!drag)return;dragRef.current=null;if(drag.nextStart===drag.startMinute&&drag.nextEnd===drag.endMinute)return;try{await withConflict(`/api/v1/tasks/${drag.task.id}`,"PATCH",{expectedVersion:drag.task.version,expectedScheduleRevision:drag.task.scheduleRevision,scheduleKind:"exact",startAt:iso(date,hhmm(drag.nextStart)),endAt:iso(date,hhmm(drag.nextEnd)),timeZone:"Asia/Shanghai"});await load();}catch{setError("排期修改未保存，任务已恢复到原位置。");}finally{setPreview(p=>{const n={...p};delete n[drag.task.id];return n;});}}
  function cancelPointer(){const drag=dragRef.current;if(!drag)return;dragRef.current=null;setPreview(p=>{const next={...p};delete next[drag.task.id];return next;});}
  async function adjustWithKeyboard(task:Task,mode:"move"|"resize",delta:number){if(task.lifecycleStatus!=="open"||busy)return;const startMinute=minuteOf(task.startAt);const endMinute=minuteOf(task.endAt);const duration=endMinute-startMinute;const earliest=earliestAllowedMinute(date);const nextStart=mode==="move"?Math.max(earliest,Math.min(LAST_TIMELINE_MINUTE-duration,startMinute+delta)):startMinute;const nextEnd=mode==="move"?nextStart+duration:Math.max(startMinute+TIMELINE_STEP_MINUTES,Math.min(LAST_TIMELINE_MINUTE,endMinute+delta));if(nextStart===startMinute&&nextEnd===endMinute)return;setBusy(true);setError(null);try{await withConflict(`/api/v1/tasks/${task.id}`,"PATCH",{expectedVersion:task.version,expectedScheduleRevision:task.scheduleRevision,scheduleKind:"exact",startAt:iso(date,hhmm(nextStart)),endAt:iso(date,hhmm(nextEnd)),timeZone:"Asia/Shanghai"});await load();}catch{setError("排期修改未保存，任务已恢复到原位置。");}finally{setBusy(false);}}
  function handleTaskKeyDown(event:React.KeyboardEvent<HTMLElement>,task:Task){if(event.target!==event.currentTarget||!(["ArrowUp","ArrowDown"].includes(event.key))||task.lifecycleStatus!=="open"||busy)return;event.preventDefault();void adjustWithKeyboard(task,event.shiftKey?"resize":"move",event.key==="ArrowUp"?-TIMELINE_STEP_MINUTES:TIMELINE_STEP_MINUTES);}
  function gridMinute(e:React.PointerEvent){const rect=e.currentTarget.getBoundingClientRect();return snapTimelineMinute((e.clientY-rect.top)/HOUR_PX*60);}
  function beginRange(e:React.PointerEvent<HTMLDivElement>){if(e.button!==0||e.target!==e.currentTarget)return;e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId);const minute=gridMinute(e);const next={pointerId:e.pointerId,start:minute,current:minute,moved:false};rangeRef.current=next;setRange(next);}
  function moveRange(e:React.PointerEvent<HTMLDivElement>){const current=rangeRef.current;if(!current||current.pointerId!==e.pointerId)return;const minute=gridMinute(e);const next={...current,current:minute,moved:current.moved||minute!==current.start};rangeRef.current=next;setRange(next);}
  function endRange(e:React.PointerEvent<HTMLDivElement>){const current=rangeRef.current;if(!current||current.pointerId!==e.pointerId)return;rangeRef.current=null;setRange(null);if(current.moved&&current.start===current.current)return;const interval=normalizedTimelineRange(current.start,current.current);const earliest=earliestAllowedMinute(date);const entryMode:FormState["entryMode"]=date===today()&&interval.start<earliest?"backfill":"schedule";setEditing(null);setSource(null);setForm(emptyForm(date,hhmm(interval.start),hhmm(interval.end),entryMode));}

  return <section className="today-workspace">
    <header className="timeline-header"><div><p className="eyebrow">TODAY / 时间坐标</p><h1>把今天放回时间里。</h1><small className="timeline-rule">{date===today()?`未来安排从 ${hhmm(earliestAllowedMinute(date))} 开始；点击过去时段可补录当天事项。`:"全天可选"}</small></div><div className="timeline-date"><input aria-label="时间轴日期" type="date" value={date} onChange={e=>setDate(e.target.value)}/><button className="primary-button" onClick={()=>{setEditing(null);setSource(null);setForm(emptyForm(date));}}><CalendarPlus/>完整添加</button></div></header>
    {error&&<div className="timeline-alert"><AlertTriangle/>{error}<button onClick={()=>setError(null)} aria-label="关闭"><X/></button></div>}
    <section className={`today-health-summary ${healthExpanded?"expanded":""}`} aria-label="今日健康参考摘要">
      <button className="today-health-toggle" type="button" aria-expanded={healthExpanded} onClick={()=>setHealthExpanded(value=>!value)}><span><HeartPulse/></span><div><p className="section-kicker">今日健康参考</p><strong>{healthSummary?`${healthActivityLabel[healthSummary.day.content.movement.category]} · ${healthIntensityLabel[healthSummary.day.content.movement.intensity]}`:"本周还没有确认的健康参考"}</strong></div><ChevronDown/></button>
      {healthExpanded&&<div className="today-health-detail">{healthSummary?<><div><Leaf/><p>{healthSummary.day.content.nutritionDirection}</p><small>{healthSummary.day.content.seasonalVegetables.join(" · ")}</small></div><div><HeartPulse/><p>{healthSummary.day.content.movement.durationMinutes.maximum===0?"今天以休息和日常轻松活动为主。":`${healthSummary.day.content.movement.durationMinutes.minimum}–${healthSummary.day.content.movement.durationMinutes.maximum} 分钟，${healthIntensityLabel[healthSummary.day.content.movement.intensity]}。`}</p><small>{healthSummary.day.content.movement.safetyReminder}</small></div></>:<p>健康参考只在你确认后显示在今日页，不会自动创建任务或要求打卡。</p>}<button className="quiet-button" type="button" onClick={onOpenHealth}>打开完整健康参考</button></div>}
    </section>
    <div className="today-layout"><main className="day-canvas"><div className="day-toolbar"><span>精确时间</span><small>{maximumLaneCount>=3?`${maximumLaneCount} 条重叠车道，可在时间轴内横向查看`:`点击或拖动空白处创建，拖动任务调整排期`}</small></div><div className="day-scroll" ref={scrollRef}><div className={`day-grid ${maximumLaneCount>=3?"multi-lane":""}`} style={{height:DAY_PX,minWidth:timelineMinimumWidth}} onPointerDown={beginRange} onPointerMove={moveRange} onPointerUp={endRange} onPointerCancel={()=>{rangeRef.current=null;setRange(null);}}>
      {Array.from({length:25},(_,h)=><div className="hour-line" style={{top:h*HOUR_PX}} key={h}><time>{String(h).padStart(2,"0")}:00</time></div>)}
      {date===today()&&<div className="now-line" style={{top:minuteOf(new Date().toISOString())/60*HOUR_PX}}><span>现在</span></div>}
      {range&&<div className="range-anchor" aria-hidden="true" style={{top:range.start/60*HOUR_PX}}/>}
      {rangePreview&&<div className={`range-preview ${date===today()&&rangePreview.start<earliestAllowedMinute(date)?"backfill":""}`} style={{top:rangePreview.start/60*HOUR_PX,height:Math.max(18,(rangePreview.end-rangePreview.start)/60*HOUR_PX)}}><span>{hhmm(rangePreview.start)}–{hhmm(rangePreview.end)}</span></div>}
      {exact.map(task=>{const value=preview[task.id]??{start:minuteOf(task.startAt),end:minuteOf(task.endAt)};const locked=task.lifecycleStatus!=="open";const lane=lanes.get(task.id)??{index:0,count:1};const width=`calc(${100/lane.count}% - 10px)`;const left=`calc(${lane.index*100/lane.count}% + 2px)`;const overlapLabel=conflict(task.id)?lane.count>1?`冲突车道 ${lane.index+1}/${lane.count}`:"冲突已保留":historical(task.id)?"历史重叠":"精确排期";return <article data-task-id={task.id} data-lane-index={lane.index+1} data-lane-count={lane.count} className={`time-block ${task.lifecycleStatus} ${lane.count>=3?"dense-lanes":""} ${conflict(task.id)?"conflict":""} ${historical(task.id)?"historical":""}`} style={{top:value.start/60*HOUR_PX,height:Math.max(18,(value.end-value.start)/60*HOUR_PX),width,left}} key={task.id} tabIndex={locked?-1:0} title={lane.count>1?`与其他任务重叠，当前为第 ${lane.index+1}/${lane.count} 条车道`:undefined} aria-label={`${task.title} ${hhmm(value.start)}至${hhmm(value.end)}${lane.count>1?`，重叠车道 ${lane.index+1}/${lane.count}`:""}`} onKeyDown={e=>handleTaskKeyDown(e,task)} onPointerDown={e=>beginPointer(e,task,"move")} onPointerMove={movePointer} onPointerUp={endPointer} onPointerCancel={cancelPointer}><div className="block-copy"><time>{hhmm(value.start)}–{hhmm(value.end)}</time><strong>{task.title}</strong><small>{overlapLabel}</small></div>{task.lifecycleStatus==="open"&&lane.count<3&&<button className="block-edit" onPointerDown={e=>e.stopPropagation()} onClick={()=>editTask(task)} aria-label="编辑任务"><Pencil/></button>}{task.lifecycleStatus!=="active"&&<button className="block-actions-toggle" onPointerDown={e=>e.stopPropagation()} onClick={()=>setActionTaskId(current=>current===task.id?null:task.id)} aria-label={`打开 ${task.title} 的任务操作`}><MoreHorizontal/></button>}{actionMenu(task)}{!locked&&<button className="resize-handle" aria-label="调整任务时长" onPointerDown={e=>{e.stopPropagation();beginPointer(e,task,"resize");}} onPointerMove={movePointer} onPointerUp={endPointer} onPointerCancel={cancelPointer}><GripHorizontal/></button>}{locked&&<span className="block-lock">{task.lifecycleStatus==="closed"?outcomeLabel(task):task.lifecycleStatus==="awaiting_outcome"?"等待记录结果":"锁定"}</span>}</article>;})}
    </div></div></main>
    <aside className="capture-panel"><section className="quick-capture"><div className="section-heading compact"><div><p className="section-kicker">快速记录</p><h2>先放进来</h2></div><Lightbulb/></div><div className="entry-switch">{(["task","idea","question"] as const).map(k=><button aria-pressed={quickKind===k} onClick={()=>setQuickKind(k)} key={k}>{k==="task"?"任务":k==="idea"?"想法":"问题"}</button>)}</div><form onSubmit={quickSave}><textarea aria-label="快速记录内容" value={quick} onChange={e=>setQuick(e.target.value)} rows={3} maxLength={200}/><button className="primary-button full-width" disabled={busy||!quick.trim()}>{busy?<LoaderCircle className="spin"/>:<Check/>}保存</button></form></section>
      <section className="loose-tasks"><p className="section-kicker">未排期与时段任务</p>{other.length===0?<small>这里很安静。</small>:other.map(t=><article className="loose-task" key={t.id}><button onClick={()=>editTask(t)}><span>{t.scheduleKind==="daypart"?({morning:"上午",afternoon:"下午",evening:"晚上"}[t.daypart!]):"未排期"}</span><strong>{t.title}</strong><Pencil/></button>{t.lifecycleStatus!=="active"&&<button className="list-actions-toggle" onClick={()=>setActionTaskId(current=>current===t.id?null:t.id)} aria-label={`打开 ${t.title} 的任务操作`}><MoreHorizontal/></button>}{actionMenu(t)}</article>)}</section>
      {cancelled.length>0&&<section className="cancelled-tasks"><p className="section-kicker">已取消</p>{cancelled.map(t=><article key={t.id}><span>{t.scheduleKind==="exact"&&t.startAt?hhmm(minuteOf(t.startAt)):"待定"}</span><strong>{t.title}</strong><button onClick={()=>void runTaskAction(t,"reopen")} aria-label={`重新打开 ${t.title}`}><RotateCcw/></button><button onClick={()=>void runTaskAction(t,"delete")} aria-label={`将 ${t.title} 移入回收站`}><Trash2/></button></article>)}</section>}
      {trash.length>0&&<section className="cancelled-tasks trash-tasks"><p className="section-kicker">回收站</p>{trash.map(t=><article key={t.id}><span>{t.scheduleKind==="exact"&&t.startAt?hhmm(minuteOf(t.startAt)):"待定"}</span><strong>{t.title}</strong><button onClick={()=>void runTaskAction(t,"restore")} aria-label={`恢复 ${t.title}`}><RotateCcw/></button></article>)}</section>}
      <section className="inbox-list"><p className="section-kicker">等待整理</p>{inbox.length===0?<small>没有待整理的想法或问题。</small>:inbox.map(entry=><article key={entry.id}><span>{entry.entryKind==="idea"?"想法":"问题"}</span><p>{entry.content}</p><button onClick={()=>{setSource(entry);setEditing(null);setForm({...emptyForm(date),title:entry.content,notes:entry.notes??""});}}>转为任务</button></article>)}</section>
    </aside></div>
    {form&&<div className="task-dialog-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget){setForm(null);setEditing(null);setSource(null);}}}><section className="task-dialog" role="dialog" aria-modal="true" aria-labelledby="task-form-title"><header><div><p className="section-kicker">{form.entryMode==="backfill"?"当天补录":form.origin==="health"?"从健康参考建立任务":form.origin==="plan_change"?"协商候选调整":source?"从收件箱建立任务":editing?"编辑任务":"完整添加"}</p><h2 id="task-form-title">{form.entryMode==="backfill"?"补上今天已经发生的事项":form.origin==="health"?"重新确认任务的开始和结束时间":form.origin==="plan_change"?"检查清楚，再决定是否保存":"让这项安排足够清楚"}</h2></div><button onClick={()=>setForm(null)} aria-label="关闭"><X/></button></header><form onSubmit={saveForm}>{form.entryMode==="backfill"&&<p className="field-wide backfill-note">补录不会发送提醒或启动专注。保存后直接记录客观结果；任务会真实写入今天的时间轴和数据库。</p>}{form.origin==="health"&&<p className="field-wide backfill-note">原健康参考会继续保留。这里只创建一项独立正式任务，不会自动生成专注结构，也不会把健康参考标记为完成。</p>}{form.origin==="plan_change"&&<div className="field-wide plan-change-form-note"><strong>尚未修改任务</strong><p>{form.advisoryReason}</p><small>这是 AI 的排期候选。你可以继续修改所有字段；只有点击下方“确认并保存调整”才会写入数据库。</small></div>}<label className="field-wide"><span>任务标题</span><input autoFocus required maxLength={200} value={form.title} onChange={e=>setForm({...form,title:e.target.value})}/></label><label><span>排期方式</span><select disabled={form.entryMode==="backfill"||form.origin==="health"} value={form.scheduleKind} onChange={e=>setForm({...form,scheduleKind:e.target.value as ScheduleKind})}><option value="none">未排期</option><option value="daypart">时间段</option><option value="exact">精确时间</option></select></label><label><span>日期</span><input type="date" disabled={form.entryMode==="backfill"} required={form.scheduleKind!=="none"} value={form.localDate} onChange={e=>setForm({...form,localDate:e.target.value})}/></label>{form.scheduleKind==="daypart"&&<label><span>时间段</span><select value={form.daypart} onChange={e=>setForm({...form,daypart:e.target.value as Daypart})}><option value="morning">上午</option><option value="afternoon">下午</option><option value="evening">晚上</option></select></label>}{form.scheduleKind==="exact"&&<><label><span>开始时间</span><input type="time" step="1800" min={form.entryMode==="backfill"?"00:00":form.localDate===today()?hhmm(earliestAllowedMinute(form.localDate)):"00:00"} max={form.entryMode==="backfill"?hhmm(Math.max(0,earliestAllowedMinute(form.localDate)-TIMELINE_STEP_MINUTES)):undefined} required value={form.start} onChange={e=>setForm({...form,start:e.target.value})}/></label><label><span>结束时间</span><input type="time" step="1800" max={form.entryMode==="backfill"?hhmm(earliestAllowedMinute(form.localDate)):"23:30"} required value={form.end} onChange={e=>setForm({...form,end:e.target.value})}/></label></>}<label className="field-wide"><span>备注</span><textarea rows={3} maxLength={4000} value={form.notes} onChange={e=>setForm({...form,notes:e.target.value})}/></label><footer className="field-wide"><button type="button" className="text-button" onClick={()=>setForm(null)}>取消</button><button className="primary-button" disabled={busy}>{busy?<LoaderCircle className="spin"/>:<Sparkles/>}{form.entryMode==="backfill"?"保存并记录结果":form.origin==="health"?"确认时间并创建任务":form.origin==="plan_change"?"确认并保存调整":source?"确认并转为任务":"保存任务"}</button></footer></form></section></div>}
    {outcomeDraft&&<div className="task-dialog-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)setOutcomeDraft(null);}}><section className="outcome-dialog" role="dialog" aria-modal="true" aria-labelledby="outcome-title"><header><div><p className="section-kicker">任务结果</p><h2 id="outcome-title">记录这次完成情况</h2><small>{outcomeDraft.task.title}</small></div><button onClick={()=>setOutcomeDraft(null)} aria-label="关闭"><X/></button></header><form onSubmit={submitOutcome}><div className="outcome-options">{(["complete","partial","not_completed"] as const).map(value=><button className={outcomeDraft.outcome===value?"selected":""} type="button" onClick={()=>chooseOutcome(value)} key={value}>{value==="complete"?<CheckCircle2/>:value==="partial"?<CircleDashed/>:<XCircle/>}{value==="complete"?"完成":value==="partial"?"部分完成":"未完成"}</button>)}</div><label><span>客观进度</span><input aria-label="客观进度" type="number" min="0" max="100" disabled={outcomeDraft.outcome!=="partial"} value={outcomeDraft.progress} onChange={e=>setOutcomeDraft({...outcomeDraft,progress:e.target.value})}/><em>%</em></label><fieldset className="satisfaction-field"><legend>主观感受</legend><div className="satisfaction-options">{(["satisfied","neutral","dissatisfied"] as const).map(value=><button className={outcomeDraft.satisfaction===value?"selected":""} type="button" onClick={()=>setOutcomeDraft({...outcomeDraft,satisfaction:value})} key={value}>{value==="satisfied"?"满意":value==="neutral"?"一般":"不满意"}</button>)}</div></fieldset><label><span>文字反馈（可选）</span><textarea rows={3} maxLength={4000} value={outcomeDraft.note} onChange={e=>setOutcomeDraft({...outcomeDraft,note:e.target.value})}/></label><footer><button type="button" className="text-button" onClick={()=>setOutcomeDraft(null)}>取消</button><button className="primary-button" disabled={busy}>{busy?<LoaderCircle className="spin"/>:<Check/>}保存结果</button></footer></form></section></div>}
    {outcomeHistory&&<div className="task-dialog-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)setOutcomeHistory(null);}}><section className="outcome-history-dialog" role="dialog" aria-modal="true" aria-labelledby="outcome-history-title"><header><div><p className="section-kicker">追加式结果记录</p><h2 id="outcome-history-title">结果历史</h2><small>{outcomeHistory.task.title}</small></div><button type="button" aria-label="关闭结果历史" onClick={()=>setOutcomeHistory(null)}><X/></button></header>{historyLoading?<div className="outcome-history-loading"><LoaderCircle className="spin"/>正在读取结果记录</div>:outcomeHistory.outcomes.length===0?<p className="outcome-history-empty">这项任务还没有保存过结果。</p>:<ol>{outcomeHistory.outcomes.map(item=><li key={item.id}><div><strong>{outcomeLabelValue(item.outcome)}</strong><span>{item.progressPercent}%</span></div><time>{new Intl.DateTimeFormat("zh-CN",{timeZone:"Asia/Shanghai",month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit",hour12:false}).format(new Date(item.recordedAt))}</time><small>{item.source==="system"?"系统恢复":item.source==="feishu"?"飞书":item.source==="ai"?"AI 协助":"软件记录"}</small>{item.note&&<p>{item.note}</p>}</li>)}</ol>}<footer><button type="button" className="primary-button" onClick={()=>setOutcomeHistory(null)}>完成</button></footer></section></div>}
    {conflictPrompt&&<div className="task-dialog-backdrop conflict-dialog-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)resolveConflictPrompt("return");}}><section className="conflict-dialog" role="alertdialog" aria-modal="true" aria-labelledby="conflict-title" aria-describedby="conflict-description"><header><div><p className="section-kicker">排期冲突</p><h2 id="conflict-title">这项安排与现有任务重叠</h2></div><button type="button" aria-label="返回调整排期" onClick={()=>resolveConflictPrompt("return")}><X/></button></header><p id="conflict-description">系统不会自动移动任何任务。返回可以继续调整；确认后会保留以下全部当前冲突。</p><ul aria-label="当前冲突任务">{conflictPrompt.conflicts.map(item=><li key={`${item.taskId}:${item.scheduleRevision}`}><span>{hhmm(minuteOf(item.startAt))}–{hhmm(minuteOf(item.endAt))}</span><strong>{item.title}</strong><small>{item.lifecycleStatus==="active"?"正在专注":item.lifecycleStatus==="awaiting_outcome"?"等待结果":"待办任务"}</small></li>)}</ul><footer><button type="button" className="text-button" onClick={()=>resolveConflictPrompt("return")}>返回调整</button><button type="button" className="primary-button" onClick={()=>resolveConflictPrompt("keep")}><AlertTriangle/>明确保留全部冲突</button></footer></section></div>}
  </section>;
}
