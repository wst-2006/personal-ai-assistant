import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, CalendarDays, CalendarPlus, Check, CheckCircle2, ChevronDown, CircleDashed, GripHorizontal, HeartPulse, History, Leaf, Lightbulb, ListTodo, LoaderCircle, MoreHorizontal, Pencil, Play, RotateCcw, Search, Sparkles, Trash2, X, XCircle } from "lucide-react";
import { SeasonalPlant } from "./SeasonalAtmosphere";
import { useShanghaiDate } from "./useShanghaiDate";
import type { FocusTheme } from "@personal-ai/domain/user-profile";
import { CyberFocusEvaluation } from "./CyberFocusEvaluation";
import { FocusEvaluationForm, progressForOutcome, validFocusEvaluation, type FocusOutcome, type FocusSatisfaction } from "./FocusEvaluationForm";

type ScheduleKind = "none" | "daypart" | "exact";
type Daypart = "morning" | "afternoon" | "evening";
type Task = { id:string; title:string; recordKind:"formal"|"backfill"; lifecycleStatus:"open"|"active"|"awaiting_outcome"|"closed"|"cancelled"; currentOutcome:"not_completed"|"partial"|"complete"|null; scheduleKind:ScheduleKind; localDate:string|null; daypart:Daypart|null; startAt:string|null; endAt:string|null; timeZone:string; notes:string|null; deletedAt:string|null; version:number; scheduleRevision:number };
type InboxEntry = { id:string; entryKind:"idea"|"question"; content:string; notes:string|null; version:number };
type Pair = { taskIdA:string; taskIdB:string; accepted:boolean };
type FormState = { entryMode:"schedule"|"backfill"; origin:"manual"|"health"|"plan_change"; advisoryReason:string|null; title:string; scheduleKind:ScheduleKind; localDate:string; daypart:Daypart; start:string; end:string; notes:string };
type DragState = { task:Task; mode:"move"|"resize"; startY:number; startMinute:number; endMinute:number; nextStart:number; nextEnd:number };
type PlacementDragState = { task:Task; pointerId:number; originX:number; originY:number; clientX:number; clientY:number; dragging:boolean; nextStart:number; valid:boolean; startedAt:number };
type PlacementPreview = { taskId:string; title:string; start:number; end:number; valid:boolean; overTimeline:boolean };
type TimelinePeriodKey = "morning" | "afternoon" | "evening";
type TimelineMode = "segmented" | "combined";
type RangeState = {
  pointerId:number;
  start:number;
  current:number;
  moved:boolean;
  surfaceId:string;
  rangeStart:number;
  rangeEnd:number;
};
type Lane = { index:number; count:number };
type OutcomeDraft = { task:Task; mode:"record"|"edit"; outcome:FocusOutcome; progress:string; satisfaction:FocusSatisfaction; note:string; expectedOutcomeId:string|null; focusSession:{id:string;version:number}|null };
type TaskOutcomeRecord = { id:string; taskId:string; focusSessionId:string|null; outcome:"not_completed"|"partial"|"complete"; progressPercent:number; source:"app"|"ai"|"feishu"|"system"; note:string|null; recordedAt:string };
type TaskFeedbackRecord = { id:string; taskId:string; focusSessionId:string|null; satisfaction:FocusSatisfaction; note:string|null; createdAt:string };
type OutcomeHistory = { task:Task; outcomes:TaskOutcomeRecord[] };
type ConflictDetail = { taskId:string; title:string; startAt:string; endAt:string; lifecycleStatus:Task["lifecycleStatus"]; scheduleRevision:number; accepted:boolean };
type ConflictPrompt = { conflicts:ConflictDetail[]; fingerprint:string; resolve:(decision:"return")=>void };
type HealthTaskDraft = { requestId:string; title:string; localDate:string; notes:string };
type ActionSurface = "timeline" | "list";
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
    proteinRangeGrams:{minimum:number;maximum:number};
    seasonalVegetables:string[];
    movement:{ category:"strength"|"volleyball"|"running"|"walking"|"cycling"|"recovery"|"rest"; durationMinutes:{minimum:number;maximum:number}; intensity:"rest"|"low"|"moderate"|"high"; safetyReminder:string };
  }};
};
class ConflictDecisionCancelledError extends Error {}

const API = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3000";
const TIMELINE_STEP_MINUTES = 30;
const TIMELINE_START_MINUTE = 7 * 60;
const TIMELINE_END_MINUTE = 23 * 60;
const LAST_TIMELINE_MINUTE = TIMELINE_END_MINUTE;
const HOUR_PX = 72;
const TIMELINE_PERIOD_TOP_INSET_PX = 24;
const MIN_READABLE_LANE_PX = 128;
const TIMELINE_PERIODS:Array<{key:TimelinePeriodKey;label:string;latin:string;start:number;end:number}> = [
  { key:"morning", label:"上午", latin:"MORNING", start:7*60, end:12*60 },
  { key:"afternoon", label:"下午", latin:"AFTERNOON", start:12*60, end:18*60 },
  { key:"evening", label:"晚上", latin:"EVENING", start:18*60, end:23*60 }
];
const defaultTimelinePeriod = ():TimelinePeriodKey => {
  const minute=minuteOf(new Date().toISOString());
  if(minute<12*60)return "morning";
  if(minute<18*60)return "afternoon";
  return "evening";
};
const periodForMinute = (minute:number):TimelinePeriodKey => {
  if(minute<12*60)return "morning";
  if(minute<18*60)return "afternoon";
  return "evening";
};
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
const timelineDateFolio = (value:string) => {
  const parsed = new Date(`${value}T12:00:00+08:00`);
  const month = new Intl.DateTimeFormat("zh-CN",{timeZone:"Asia/Shanghai",month:"long"}).format(parsed);
  const weekday = new Intl.DateTimeFormat("zh-CN",{timeZone:"Asia/Shanghai",weekday:"short"}).format(parsed);
  return {
    day:String(parsed.getDate()).padStart(2,"0"),
    meta:`${month} · ${weekday}`
  };
};
const snapTimelineMinute = (minute:number, rangeStart=TIMELINE_START_MINUTE, rangeEnd=TIMELINE_END_MINUTE) => Math.max(rangeStart, Math.min(rangeEnd, Math.round(minute/TIMELINE_STEP_MINUTES)*TIMELINE_STEP_MINUTES));
const isTimelineMinute = (minute:number) => minute % TIMELINE_STEP_MINUTES === 0;
const timelineTop = (minute:number, rangeStart=TIMELINE_START_MINUTE) => (minute-rangeStart)/60*HOUR_PX;
const earliestTodayMinute = () => Math.min(TIMELINE_END_MINUTE, Math.max(TIMELINE_START_MINUTE, (Math.floor(minuteOf(new Date().toISOString()) / TIMELINE_STEP_MINUTES) + 1) * TIMELINE_STEP_MINUTES));
const earliestAllowedMinute = (date:string) => date===today() ? earliestTodayMinute() : TIMELINE_START_MINUTE;
const emptyForm = (date=today(), start?:string, end?:string, entryMode:FormState["entryMode"]="schedule"):FormState => {
  const defaultStart = Math.min(earliestAllowedMinute(date), LAST_TIMELINE_MINUTE-TIMELINE_STEP_MINUTES);
  const startMinute = start ? Number(start.slice(0,2))*60+Number(start.slice(3)) : defaultStart;
  return { entryMode, origin:"manual", advisoryReason:null, title:"", scheduleKind:"exact", localDate:date, daypart:"morning", start:start ?? hhmm(startMinute), end:end ?? hhmm(Math.min(LAST_TIMELINE_MINUTE,startMinute+TIMELINE_STEP_MINUTES)), notes:"" };
};
const normalizedTimelineRange = (anchor:number,current:number,rangeStart=TIMELINE_START_MINUTE,rangeEnd=TIMELINE_END_MINUTE) => {
  const low=Math.max(rangeStart,Math.min(anchor,current));const high=Math.min(rangeEnd,Math.max(anchor,current));
  const start=Math.min(low,rangeEnd-TIMELINE_STEP_MINUTES);
  const end=high-low>=TIMELINE_STEP_MINUTES?Math.min(rangeEnd,Math.max(start+TIMELINE_STEP_MINUTES,high)):Math.min(rangeEnd,start+TIMELINE_STEP_MINUTES);
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

const healthActivityLabel:Record<HealthDaySummary["day"]["content"]["movement"]["category"],string>={strength:"力量训练",volleyball:"排球",running:"跑步",walking:"步行",cycling:"骑行",recovery:"轻量恢复",rest:"休息"};
const healthIntensityLabel:Record<HealthDaySummary["day"]["content"]["movement"]["intensity"],string>={rest:"休息",low:"低强度",moderate:"中等强度",high:"高强度"};

export function TodayWorkspace({ onFocus, onOpenHealth, healthTaskDraft, onHealthTaskDraftConsumed, planChangeTaskEditRequest, onPlanChangeTaskEditRequestConsumed, refreshToken=0 }:{ onFocus:(id:string)=>void; onOpenHealth:()=>void; healthTaskDraft?:HealthTaskDraft|null; onHealthTaskDraftConsumed?:()=>void; planChangeTaskEditRequest?:PlanChangeTaskEditRequest|null; onPlanChangeTaskEditRequestConsumed?:()=>void; refreshToken?:number }) {
  const todayDate = useShanghaiDate();
  const [date,setDate]=useState(todayDate);
  const [tasks,setTasks]=useState<Task[]>([]); const [inbox,setInbox]=useState<InboxEntry[]>([]); const [trash,setTrash]=useState<Task[]>([]);
  const [pairs,setPairs]=useState<Pair[]>([]); const [history,setHistory]=useState<Pair[]>([]);
  const [form,setForm]=useState<FormState|null>(null); const [editing,setEditing]=useState<Task|null>(null); const [source,setSource]=useState<InboxEntry|null>(null);
  const [quickKind,setQuickKind]=useState<"task"|"idea"|"question">("task"); const [quick,setQuick]=useState("");
  const [busy,setBusy]=useState(false); const [error,setError]=useState<string|null>(null); const [preview,setPreview]=useState<Record<string,{start:number;end:number}>>({});
  const [actionTaskId,setActionTaskId]=useState<string|null>(null); const [actionSurface,setActionSurface]=useState<ActionSurface|null>(null); const [outcomeDraft,setOutcomeDraft]=useState<OutcomeDraft|null>(null);
  const [actionMenuPosition,setActionMenuPosition]=useState<{ top:number; left:number }|null>(null);
  const [outcomeHistory,setOutcomeHistory]=useState<OutcomeHistory|null>(null); const [historyLoading,setHistoryLoading]=useState(false);
  const [range,setRange]=useState<RangeState|null>(null);
  const [conflictPrompt,setConflictPrompt]=useState<ConflictPrompt|null>(null);
  const [healthSummary,setHealthSummary]=useState<HealthDaySummary|null>(null); const [healthExpanded,setHealthExpanded]=useState(false);
  const [scheduledTasksOpen,setScheduledTasksOpen]=useState(true); const [unscheduledTasksOpen,setUnscheduledTasksOpen]=useState(true); const [scheduledTasksExpanded,setScheduledTasksExpanded]=useState(false); const [unscheduledTasksExpanded,setUnscheduledTasksExpanded]=useState(false); const [inboxExpanded,setInboxExpanded]=useState(false);
  const [trashOpen,setTrashOpen]=useState(false); const [trashQuery,setTrashQuery]=useState("");
  const [recycleRetentionDays,setRecycleRetentionDays]=useState(3);
  const [focusTheme,setFocusTheme]=useState<FocusTheme>("ink");
  const [timelineMode,setTimelineMode]=useState<TimelineMode>("segmented");
  const [frontPeriod,setFrontPeriod]=useState<TimelinePeriodKey>(()=>defaultTimelinePeriod());
  const [clockNowMs,setClockNowMs]=useState(()=>Date.now());
  const [placementPreview,setPlacementPreview]=useState<PlacementPreview|null>(null);
  const [newTaskInkId,setNewTaskInkId]=useState<string|null>(null);
  const [completedTaskSealId,setCompletedTaskSealId]=useState<string|null>(null);
  const [conflictPulseIds,setConflictPulseIds]=useState<Set<string>>(()=>new Set());
  const scrollRef=useRef<HTMLDivElement>(null); const dragRef=useRef<DragState|null>(null); const rangeRef=useRef<RangeState|null>(null);
  const placementDragRef=useRef<PlacementDragState|null>(null); const placementGhostRef=useRef<HTMLDivElement>(null); const placementScrollFrameRef=useRef(0); const placementHoldTimerRef=useRef(0); const suppressTaskClickRef=useRef<string|null>(null);
  const loadRequestRef=useRef(0);
  const frontPeriodUserSelectedRef=useRef(false);
  const frontPeriodDateRef=useRef(date);
  const combinedScrollPositionsRef=useRef(new Map<string,number>());
  const feedbackTimersRef=useRef<number[]>([]);
  const pendingConflictPulseIdsRef=useRef(new Set<string>());
  const previousTodayDateRef=useRef(todayDate);

  useEffect(()=>()=>{feedbackTimersRef.current.forEach(timer=>window.clearTimeout(timer));if(placementScrollFrameRef.current)window.cancelAnimationFrame(placementScrollFrameRef.current);if(placementHoldTimerRef.current)window.clearTimeout(placementHoldTimerRef.current);},[]);
  useEffect(()=>{
    const previous=previousTodayDateRef.current;
    previousTodayDateRef.current=todayDate;
    if(previous===todayDate)return;
    setDate(current=>current===previous?todayDate:current);
  },[todayDate]);
  useEffect(()=>{
    let interval=0;
    const tick=()=>setClockNowMs(Date.now());
    const delay=60_000-(Date.now()%60_000)+25;
    const timeout=window.setTimeout(()=>{tick();interval=window.setInterval(tick,60_000);},delay);
    const resync=()=>tick();
    const resyncVisible=()=>{if(document.visibilityState==="visible")tick();};
    window.addEventListener("focus",resync);
    document.addEventListener("visibilitychange",resyncVisible);
    return()=>{window.clearTimeout(timeout);if(interval)window.clearInterval(interval);window.removeEventListener("focus",resync);document.removeEventListener("visibilitychange",resyncVisible);};
  },[]);
  useEffect(()=>{
    const move=(event:PointerEvent)=>{
      const drag=placementDragRef.current;if(!drag||drag.pointerId!==event.pointerId)return;
      if(!drag.dragging&&(Math.hypot(event.clientX-drag.originX,event.clientY-drag.originY)>=5||(event.pressure>0&&performance.now()-drag.startedAt>90)))activatePlacementDrag(drag);
      if(drag.dragging){event.preventDefault();updatePlacementPointer(event.clientX,event.clientY);}
    };
    const up=(event:PointerEvent)=>{const drag=placementDragRef.current;if(drag?.pointerId===event.pointerId)void completePlacementGesture();};
    const cancel=(event:PointerEvent)=>{const drag=placementDragRef.current;if(drag?.pointerId===event.pointerId)cancelPlacementGesture();};
    window.addEventListener("pointermove",move,{passive:false});window.addEventListener("pointerup",up);window.addEventListener("pointercancel",cancel);
    return()=>{window.removeEventListener("pointermove",move);window.removeEventListener("pointerup",up);window.removeEventListener("pointercancel",cancel);};
  },[busy,date]);

  const load=useCallback(async()=>{ const requestId=++loadRequestRef.current;setError(null);try{const [taskData,inboxData,trashData,healthData,profileData]=await Promise.all([json<{tasks:Task[];blockingConflicts:Pair[];historicalOverlaps:Pair[]}>(`/api/v1/tasks?date=${date}`),json<InboxEntry[]>("/api/v1/inbox-entries"),json<{tasks:Task[]}>("/api/v1/tasks/trash"),json<{reference:HealthDaySummary|null}>(`/api/v1/health/days/${date}`).catch(()=>({reference:null})),json<{profile:{recycleRetentionDays?:number;focusTheme?:FocusTheme}}>("/api/v1/user-profile").catch(()=>({profile:{} as {recycleRetentionDays?:number;focusTheme?:FocusTheme}}))]);if(requestId!==loadRequestRef.current)return;setTasks(taskData.tasks);setPairs(taskData.blockingConflicts);setHistory(taskData.historicalOverlaps);setInbox(inboxData);setTrash(trashData.tasks);setHealthSummary(healthData.reference);setRecycleRetentionDays(profileData.profile.recycleRetentionDays??3);setFocusTheme(profileData.profile.focusTheme??"ink");if(pendingConflictPulseIdsRef.current.size){const ids=new Set(pendingConflictPulseIdsRef.current);pendingConflictPulseIdsRef.current.clear();setConflictPulseIds(ids);feedbackTimersRef.current.push(window.setTimeout(()=>setConflictPulseIds(new Set()),760));}}catch(error){if(requestId!==loadRequestRef.current)return;throw error;}},[date]);
  useEffect(()=>{ void load().catch(()=>setError("无法读取安排，请确认 API 正在运行。")); },[load,refreshToken]);
  useEffect(()=>{
    const refresh=()=>{if(document.visibilityState==="visible")void load().catch(()=>undefined);};
    window.addEventListener("focus",refresh);
    window.addEventListener("pageshow",refresh);
    document.addEventListener("visibilitychange",refresh);
    return()=>{window.removeEventListener("focus",refresh);window.removeEventListener("pageshow",refresh);document.removeEventListener("visibilitychange",refresh);};
  },[load]);
  useEffect(()=>{
    if(!actionTaskId)return;
    const closeFromPointer=(event:PointerEvent)=>{
      const target=event.target instanceof Element?event.target:null;
      if(target?.closest(".task-action-menu, .block-actions-toggle, .list-actions-toggle"))return;
      closeTaskActions();
    };
    const closeFromKeyboard=(event:KeyboardEvent)=>{if(event.key==="Escape")closeTaskActions();};
    window.addEventListener("pointerdown",closeFromPointer);
    window.addEventListener("keydown",closeFromKeyboard);
    return()=>{window.removeEventListener("pointerdown",closeFromPointer);window.removeEventListener("keydown",closeFromKeyboard);};
  },[actionTaskId]);
  useEffect(()=>{
    if(frontPeriodDateRef.current!==date){
      frontPeriodDateRef.current=date;
      frontPeriodUserSelectedRef.current=false;
    }
    if(frontPeriodUserSelectedRef.current)return;
    if(date===today()){
      setFrontPeriod(defaultTimelinePeriod());
      return;
    }
    const firstScheduledMinute=tasks
      .filter(task=>task.recordKind==="formal"&&task.scheduleKind==="exact"&&task.startAt&&task.endAt&&task.lifecycleStatus!=="cancelled")
      .map(task=>minuteOf(task.startAt))
      .sort((left,right)=>left-right)[0];
    setFrontPeriod(firstScheduledMinute===undefined?"morning":periodForMinute(firstScheduledMinute));
  },[date,tasks]);
  useEffect(()=>{if(error!=="无法读取安排，请确认 API 正在运行。")return;const timer=window.setTimeout(()=>void load().catch(()=>setError("无法读取安排，请确认 API 正在运行。")),5_000);return()=>window.clearTimeout(timer);},[error,load]);
  useEffect(()=>{
    if(timelineMode!=="combined")return;
    const stored=combinedScrollPositionsRef.current.get(date);
    const scheduled=tasks.filter(t=>t.scheduleKind==="exact"&&t.startAt&&minuteOf(t.startAt)>=TIMELINE_START_MINUTE&&minuteOf(t.startAt)<=TIMELINE_END_MINUTE).sort((a,b)=>minuteOf(a.startAt)-minuteOf(b.startAt));
    const target=date===today()?Math.max(TIMELINE_START_MINUTE,Math.min(TIMELINE_END_MINUTE,minuteOf(new Date().toISOString()))):scheduled.length?minuteOf(scheduled[0]!.startAt):TIMELINE_START_MINUTE;
    requestAnimationFrame(()=>scrollRef.current?.scrollTo({top:stored??Math.max(0,timelineTop(target)-160)}));
  },[date,tasks.length,timelineMode]);
  useEffect(()=>{
    if(timelineMode!=="combined"||!scrollRef.current)return;
    const element=scrollRef.current;
    const remember=()=>combinedScrollPositionsRef.current.set(date,element.scrollTop);
    element.addEventListener("scroll",remember,{passive:true});
    return()=>{
      remember();
      element.removeEventListener("scroll",remember);
    };
  },[date,timelineMode]);
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

  const exact=useMemo(()=>tasks.filter(t=>t.recordKind==="formal"&&t.scheduleKind==="exact"&&t.startAt&&t.endAt&&t.lifecycleStatus!=="cancelled"&&minuteOf(t.startAt)>=TIMELINE_START_MINUTE&&minuteOf(t.endAt)<=TIMELINE_END_MINUTE),[tasks]);
  const backfills=useMemo(()=>tasks.filter(t=>t.recordKind==="backfill"&&t.scheduleKind==="exact"&&t.startAt&&t.endAt&&t.lifecycleStatus!=="cancelled"&&minuteOf(t.startAt)>=TIMELINE_START_MINUTE&&minuteOf(t.endAt)<=TIMELINE_END_MINUTE),[tasks]);
  const cancelled=useMemo(()=>tasks.filter(t=>t.recordKind==="formal"&&t.lifecycleStatus==="cancelled"),[tasks]);
  const sortedTasks=useMemo(()=>[...tasks.filter(t=>t.lifecycleStatus!=="cancelled")].sort((a,b)=>{const aMinute=a.scheduleKind==="exact"&&a.startAt?minuteOf(a.startAt):a.scheduleKind==="daypart"?({morning:8*60,afternoon:13*60,evening:19*60}[a.daypart??"morning"]):24*60;const bMinute=b.scheduleKind==="exact"&&b.startAt?minuteOf(b.startAt):b.scheduleKind==="daypart"?({morning:8*60,afternoon:13*60,evening:19*60}[b.daypart??"morning"]):24*60;return aMinute-bMinute||a.title.localeCompare(b.title,"zh-CN");}),[tasks]);
  const scheduledTasks=useMemo(()=>sortedTasks.filter(task=>task.scheduleKind!=="none"),[sortedTasks]);
  const unscheduledTasks=useMemo(()=>sortedTasks.filter(task=>task.scheduleKind==="none"),[sortedTasks]);
  const displayedScheduledTasks=scheduledTasksExpanded?scheduledTasks:scheduledTasks.slice(0,3);
  const displayedUnscheduledTasks=unscheduledTasksExpanded?unscheduledTasks:unscheduledTasks.slice(0,3);
  const hiddenScheduledTaskCount=scheduledTasks.length-displayedScheduledTasks.length;
  const hiddenUnscheduledTaskCount=unscheduledTasks.length-displayedUnscheduledTasks.length;
  const displayedInbox=inboxExpanded?inbox:inbox.slice(0,3);
  const filteredTrash=useMemo(()=>{const query=trashQuery.trim().toLocaleLowerCase("zh-CN");return [...trash].filter(task=>!query||task.title.toLocaleLowerCase("zh-CN").includes(query)||(task.notes??"").toLocaleLowerCase("zh-CN").includes(query)).sort((a,b)=>(b.startAt?new Date(b.startAt).getTime():0)-(a.startAt?new Date(a.startAt).getTime():0)||a.title.localeCompare(b.title,"zh-CN"));},[trash,trashQuery]);
  const lanes=useMemo(()=>assignLanes(exact),[exact]);
  const maximumLaneCount=useMemo(()=>Math.max(1,...Array.from(lanes.values(),lane=>lane.count)),[lanes]);
  const conflict=(id:string)=>pairs.some(p=>p.taskIdA===id||p.taskIdB===id); const historical=(id:string)=>history.some(p=>p.taskIdA===id||p.taskIdB===id);
  const dateFolio=useMemo(()=>timelineDateFolio(date),[date]);
  const frontPeriodOrder=Math.max(0,TIMELINE_PERIODS.findIndex(period=>period.key===frontPeriod));

  function requestConflictDecision(conflicts:ConflictDetail[], fingerprint:string):Promise<"return"> { return new Promise(resolve=>setConflictPrompt({conflicts,fingerprint,resolve})); }
  function resolveConflictPrompt(decision:"return"){ const prompt=conflictPrompt;setConflictPrompt(null);prompt?.resolve(decision); }
  async function withConflict(path:string,method:string,payload:Record<string,unknown>) {
    try{
      return await json<any>(path,method,payload);
    }catch(e:any){
      if(!["task_time_conflict","conflict_set_changed"].includes(e.body?.error)||!e.body.conflictSetFingerprint)throw e;
      const conflicts=(e.body.conflicts??[]) as ConflictDetail[];
      await requestConflictDecision(conflicts,e.body.conflictSetFingerprint);
      throw new ConflictDecisionCancelledError();
    }
  }
  function payload(value:FormState){ const schedule=value.scheduleKind==="none"?{localDate:value.localDate||null,daypart:null,startAt:null,endAt:null}:value.scheduleKind==="daypart"?{localDate:value.localDate,daypart:value.daypart,startAt:null,endAt:null}:{localDate:null,daypart:null,startAt:iso(value.localDate,value.start),endAt:iso(value.localDate,value.end)};return { title:value.title.trim(), scheduleKind:value.scheduleKind, ...schedule, timeZone:"Asia/Shanghai", notes:value.notes.trim()||null }; }
  async function saveForm(e:React.FormEvent){
    e.preventDefault();
    if(!form?.title.trim()){setError("请填写任务标题。");return;}
    if(form.scheduleKind!=="none"&&!form.localDate){setError("请选择任务日期。");return;}
    if(form.scheduleKind==="exact"){
      if(!form.start||!form.end){setError("请填写任务的开始时间和结束时间。");return;}
      const start=Number(form.start.slice(0,2))*60+Number(form.start.slice(3));
      const end=Number(form.end.slice(0,2))*60+Number(form.end.slice(3));
      if(!isTimelineMinute(start)||!isTimelineMinute(end)){setError("精确任务的开始和结束时间必须使用 30 分钟间隔。");return;}
      if(end-start<TIMELINE_STEP_MINUTES){setError("精确任务的结束时间必须至少晚于开始时间 30 分钟。");return;}
      if(start<TIMELINE_START_MINUTE||end>TIMELINE_END_MINUTE){setError("精确任务只能安排在 07:00–23:00 之间。");return;}
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
        const result=await withConflict(`/api/v1/inbox-entries/${source.id}/convert-to-task`,`POST`,{confirmed:true,expectedVersion:source.version,task:taskPayload});created=result.task as Task;
      }else if(editing){
        await withConflict(`/api/v1/tasks/${editing.id}`,`PATCH`,{expectedVersion:editing.version,expectedScheduleRevision:editing.scheduleRevision,...taskPayload});
      }else{
        const result=await withConflict("/api/v1/tasks","POST",taskPayload);created=result.task as Task;
      }
      setForm(null);setEditing(null);setSource(null);await load();
      if(form.entryMode==="backfill"&&created)setOutcomeDraft({task:created,mode:"record",outcome:"complete",progress:"100",satisfaction:"satisfied",note:"",expectedOutcomeId:null,focusSession:null});
      else if(created?.recordKind==="formal"&&created.scheduleKind==="exact"){setNewTaskInkId(created.id);feedbackTimersRef.current.push(window.setTimeout(()=>setNewTaskInkId(null),900));}
    }catch(err:any){
      if(err instanceof ConflictDecisionCancelledError)return;
      setError(err.body?.error==="inbox_entry_conflict"?"这条想法已被其他位置更新或转换，请刷新后重新整理。":err.body?.error==="task_schedule_revision_conflict"?"排期已在其他位置更新，请重新打开。":err.body?.error==="task_schedule_outside_allowed_hours"?"精确任务只能安排在 07:00–23:00 之间。":err.body?.error==="task_backfill_window_unavailable"?"这个补录区间已经超出今天当前可补录范围，请重新选择。":"保存失败，原内容仍在表单中。");
    }finally{setBusy(false);}
  }
  async function quickSave(e:React.FormEvent){e.preventDefault();if(!quick.trim())return;setBusy(true);try{if(quickKind==="task")await json("/api/v1/tasks","POST",{title:quick.trim(),scheduleKind:"none",localDate:date,timeZone:"Asia/Shanghai"});else await json("/api/v1/inbox-entries","POST",{entryKind:quickKind,content:quick.trim()});setQuick("");await load();}catch{setError("快速记录失败，内容没有丢失。");}finally{setBusy(false);}}
  function editTask(task:Task){if(task.recordKind!=="formal")return;setEditing(task);setSource(null);setForm({entryMode:"schedule",origin:"manual",advisoryReason:null,title:task.title,scheduleKind:task.scheduleKind,localDate:task.localDate??date,daypart:task.daypart??"morning",start:hhmm(minuteOf(task.startAt)),end:hhmm(minuteOf(task.endAt)),notes:task.notes??""});}
  function closeTaskActions(){setActionTaskId(null);setActionSurface(null);setActionMenuPosition(null);}
  function toggleTaskActions(taskId:string,surface:ActionSurface,event:React.MouseEvent<HTMLButtonElement>){const same=actionTaskId===taskId&&actionSurface===surface;if(same){closeTaskActions();return;}const rect=event.currentTarget.getBoundingClientRect();const menuHeight=220;const menuWidth=190;const top=rect.bottom+4+menuHeight>window.innerHeight?Math.max(8,rect.top-menuHeight-4):rect.bottom+4;const left=Math.max(8,Math.min(window.innerWidth-menuWidth-8,rect.right-menuWidth));setActionTaskId(taskId);setActionSurface(surface);setActionMenuPosition({top,left});}
  useEffect(()=>{
    if(!actionMenuPosition)return;
    const closeOnViewportChange=()=>closeTaskActions();
    window.addEventListener("resize",closeOnViewportChange);
    window.addEventListener("scroll",closeOnViewportChange,true);
    return()=>{window.removeEventListener("resize",closeOnViewportChange);window.removeEventListener("scroll",closeOnViewportChange,true);};
  },[actionMenuPosition]);
  async function openOutcome(task:Task){
    closeTaskActions();setBusy(true);setError(null);
    try{
      const [detail,focus]=await Promise.all([
        json<{task:Task;outcomes:TaskOutcomeRecord[];feedback:TaskFeedbackRecord[]}>(`/api/v1/tasks/${task.id}`),
        json<{session:{id:string;version:number;state:string}|null}>(`/api/v1/focus-sessions/tasks/${task.id}/current`).catch(()=>({session:null}))
      ]);
      const latestOutcome=detail.outcomes[0]??null;
      const latestFeedback=detail.feedback[0]??null;
      const editing=detail.task.lifecycleStatus==="closed"&&Boolean(latestOutcome);
      setOutcomeDraft({
        task:detail.task,
        mode:editing?"edit":"record",
        outcome:latestOutcome?.outcome??"complete",
        progress:String(latestOutcome?.progressPercent??100),
        satisfaction:latestFeedback?.satisfaction??"satisfied",
        note:latestFeedback?.note??latestOutcome?.note??"",
        expectedOutcomeId:latestOutcome?.id??null,
        focusSession:focus.session?.state==="ended"?{id:focus.session.id,version:focus.session.version}:null
      });
    }catch{setError("无法读取这项任务的评价记录，请刷新后重试。");}
    finally{setBusy(false);}
  }
  async function openOutcomeHistory(task:Task){closeTaskActions();setOutcomeHistory({task,outcomes:[]});setHistoryLoading(true);try{const detail=await json<{task:Task;outcomes:TaskOutcomeRecord[]}>(`/api/v1/tasks/${task.id}`);setOutcomeHistory({task:detail.task,outcomes:detail.outcomes});}catch{setOutcomeHistory(null);setError("无法读取任务结果历史，请刷新后重试。");}finally{setHistoryLoading(false);}}
  function chooseOutcome(outcome:FocusOutcome){setOutcomeDraft(current=>current?{...current,outcome,progress:progressForOutcome(outcome)}:current);}
  async function submitOutcome(){if(!outcomeDraft)return;const progress=Number(outcomeDraft.progress);if(!validFocusEvaluation(outcomeDraft.outcome,outcomeDraft.progress)){setError("请填写与结果一致的客观进度。");return;}setBusy(true);setError(null);const completedTaskId=outcomeDraft.outcome==="complete"?outcomeDraft.task.id:null;try{
    if(outcomeDraft.mode==="edit"&&outcomeDraft.expectedOutcomeId){
      await json(`/api/v1/tasks/${outcomeDraft.task.id}/outcomes/correct`,`POST`,{expectedVersion:outcomeDraft.task.version,expectedOutcomeId:outcomeDraft.expectedOutcomeId,outcome:outcomeDraft.outcome,progressPercent:progress,source:"app",satisfaction:outcomeDraft.satisfaction});
    }else if(outcomeDraft.focusSession){
      await json(`/api/v1/focus-sessions/${outcomeDraft.focusSession.id}/evaluate`,`POST`,{expectedVersion:outcomeDraft.focusSession.version,commandId:crypto.randomUUID(),outcome:outcomeDraft.outcome,progressPercent:progress,satisfaction:outcomeDraft.satisfaction,note:outcomeDraft.note.trim()||null});
    }else{
      await json(`/api/v1/tasks/${outcomeDraft.task.id}/outcomes`,`POST`,{expectedVersion:outcomeDraft.task.version,outcome:outcomeDraft.outcome,progressPercent:progress,source:"app",satisfaction:outcomeDraft.satisfaction,note:outcomeDraft.note.trim()||null});
    }
    setOutcomeDraft(null);await load();if(completedTaskId){setCompletedTaskSealId(completedTaskId);feedbackTimersRef.current.push(window.setTimeout(()=>setCompletedTaskSealId(null),900));}
  }catch{setError("任务评价没有保存，请刷新后重试。");}finally{setBusy(false);}}
  async function runTaskAction(task:Task,action:"cancel"|"delete"|"reopen"|"restore"){if(action==="delete"&&!window.confirm("删除后任务将移入回收站，可以从当天页面恢复。是否继续？"))return;setBusy(true);setError(null);try{if(action==="cancel")await json(`/api/v1/tasks/${task.id}/cancel-and-trash`,`POST`,{expectedVersion:task.version,reason:"取消任务后默认移入回收站"});else if(action==="delete")await json(`/api/v1/tasks/${task.id}`,`DELETE`,{expectedVersion:task.version});else await withConflict(`/api/v1/tasks/${task.id}/${action}`,`POST`,{expectedVersion:task.version});closeTaskActions();await load();}catch(err:any){if(err instanceof ConflictDecisionCancelledError)return;setError(err.body?.error==="task_version_conflict"?"任务已在其他位置更新，请刷新后重试。":"操作没有保存，任务状态保持不变。");}finally{setBusy(false);}}
  async function emptyTrash(){if(trash.length===0||!window.confirm(`将回收站中的 ${trash.length} 项任务永久删除？此操作不可恢复。`))return;setBusy(true);setError(null);try{await json<{purgedCount:number}>("/api/v1/tasks/trash/empty","POST");setTrash([]);setTrashQuery("");}catch(err:any){setError(err.body?.error??"回收站清空失败，请稍后重试。");}finally{setBusy(false);}}
  function outcomeLabelValue(outcome:Task["currentOutcome"]){return outcome==="complete"?"已完成":outcome==="partial"?"部分完成":outcome==="not_completed"?"未完成":"已结束";}
  function outcomeLabel(task:Task){return outcomeLabelValue(task.currentOutcome);}
  function taskStatusLabel(task:Task){return task.lifecycleStatus==="active"?"正在进行":task.lifecycleStatus==="awaiting_outcome"?"待评价":task.lifecycleStatus==="closed"?outcomeLabel(task):task.lifecycleStatus==="cancelled"?"已取消":"待开始";}
  function scheduledTaskStatus(task:Task){
    if(task.lifecycleStatus==="open")return {label:"未开始",tone:"pending"};
    if(task.lifecycleStatus==="closed"){
      if(task.currentOutcome==="complete")return {label:"完成",tone:"complete"};
      if(task.currentOutcome==="not_completed")return {label:"未完成",tone:"incomplete"};
      if(task.currentOutcome==="partial")return {label:"部分完成",tone:"partial"};
      return {label:"已结束",tone:"incomplete"};
    }
    if(task.lifecycleStatus==="active")return {label:"正在进行",tone:"active"};
    if(task.lifecycleStatus==="awaiting_outcome")return {label:"待评价",tone:"awaiting"};
    return {label:"已取消",tone:"incomplete"};
  }
  function actionMenu(task:Task,surface:ActionSurface){if(actionTaskId!==task.id||actionSurface!==surface||task.lifecycleStatus==="active"||!actionMenuPosition||typeof document==="undefined")return null;const factual=task.recordKind==="backfill";const canStartFocus=!factual&&task.lifecycleStatus==="open"&&task.scheduleKind==="exact"&&Boolean(task.startAt&&task.endAt);const canEvaluate=task.lifecycleStatus==="closed"||task.lifecycleStatus==="awaiting_outcome"||factual&&task.lifecycleStatus==="open";return createPortal(<div className="task-action-menu" style={{top:actionMenuPosition.top,left:actionMenuPosition.left}} onPointerDown={e=>e.stopPropagation()}>{!factual&&task.lifecycleStatus==="open"&&<button onClick={()=>{closeTaskActions();editTask(task);}}><Pencil/>编辑任务</button>}{canStartFocus&&<button onClick={()=>{closeTaskActions();onFocus(task.id);}}><Play/>我会准时开始</button>}{canEvaluate&&<button onClick={()=>void openOutcome(task)}><CheckCircle2/>{task.lifecycleStatus==="closed"?"重新打开评价":"记录结果"}</button>}<button onClick={()=>void openOutcomeHistory(task)}><History/>结果历史</button>{!factual&&task.lifecycleStatus==="open"&&<button onClick={()=>void runTaskAction(task,"cancel")}><XCircle/>取消任务</button>}{!factual&&task.lifecycleStatus==="cancelled"&&<button onClick={()=>void runTaskAction(task,"reopen")}><RotateCcw/>重新启用任务</button>}<button className="danger" onClick={()=>void runTaskAction(task,"delete")}><Trash2/>移入回收站</button></div>,document.body);}
  function beginPointer(e:React.PointerEvent,task:Task,mode:"move"|"resize"){if(task.recordKind!=="formal"||task.lifecycleStatus!=="open")return;e.preventDefault();(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);const startMinute=minuteOf(task.startAt);const endMinute=minuteOf(task.endAt);dragRef.current={task,mode,startY:e.clientY,startMinute,endMinute,nextStart:startMinute,nextEnd:endMinute};}
  function movePointer(e:React.PointerEvent){const drag=dragRef.current;if(!drag)return;const delta=Math.round((e.clientY-drag.startY)/HOUR_PX*60/TIMELINE_STEP_MINUTES)*TIMELINE_STEP_MINUTES;const duration=drag.endMinute-drag.startMinute;const earliest=Math.max(TIMELINE_START_MINUTE,earliestAllowedMinute(date));const start=drag.mode==="move"?Math.max(earliest,Math.min(LAST_TIMELINE_MINUTE-duration,drag.startMinute+delta)):drag.startMinute;const end=drag.mode==="move"?start+duration:Math.max(start+TIMELINE_STEP_MINUTES,Math.min(LAST_TIMELINE_MINUTE,drag.endMinute+delta));drag.nextStart=start;drag.nextEnd=end;setPreview(p=>({...p,[drag.task.id]:{start,end}}));}
  async function endPointer(){const drag=dragRef.current;if(!drag)return;dragRef.current=null;if(drag.nextStart===drag.startMinute&&drag.nextEnd===drag.endMinute)return;try{await withConflict(`/api/v1/tasks/${drag.task.id}`,"PATCH",{expectedVersion:drag.task.version,expectedScheduleRevision:drag.task.scheduleRevision,scheduleKind:"exact",startAt:iso(date,hhmm(drag.nextStart)),endAt:iso(date,hhmm(drag.nextEnd)),timeZone:"Asia/Shanghai"});await load();}catch{setError("排期修改未保存，任务已恢复到原位置。");}finally{setPreview(p=>{const n={...p};delete n[drag.task.id];return n;});}}
  function cancelPointer(){const drag=dragRef.current;if(!drag)return;dragRef.current=null;setPreview(p=>{const next={...p};delete next[drag.task.id];return next;});}
  async function adjustWithKeyboard(task:Task,mode:"move"|"resize",delta:number){if(task.recordKind!=="formal"||task.lifecycleStatus!=="open"||busy)return;const startMinute=minuteOf(task.startAt);const endMinute=minuteOf(task.endAt);const duration=endMinute-startMinute;const earliest=earliestAllowedMinute(date);const nextStart=mode==="move"?Math.max(earliest,Math.min(LAST_TIMELINE_MINUTE-duration,startMinute+delta)):startMinute;const nextEnd=mode==="move"?nextStart+duration:Math.max(startMinute+TIMELINE_STEP_MINUTES,Math.min(LAST_TIMELINE_MINUTE,endMinute+delta));if(nextStart===startMinute&&nextEnd===endMinute)return;setBusy(true);setError(null);try{await withConflict(`/api/v1/tasks/${task.id}`,"PATCH",{expectedVersion:task.version,expectedScheduleRevision:task.scheduleRevision,scheduleKind:"exact",startAt:iso(date,hhmm(nextStart)),endAt:iso(date,hhmm(nextEnd)),timeZone:"Asia/Shanghai"});await load();}catch{setError("排期修改未保存，任务已恢复到原位置。");}finally{setBusy(false);}}
  function handleTaskKeyDown(event:React.KeyboardEvent<HTMLElement>,task:Task){if(event.target!==event.currentTarget||!(["ArrowUp","ArrowDown"].includes(event.key))||task.recordKind!=="formal"||task.lifecycleStatus!=="open"||busy)return;event.preventDefault();void adjustWithKeyboard(task,event.shiftKey?"resize":"move",event.key==="ArrowUp"?-TIMELINE_STEP_MINUTES:TIMELINE_STEP_MINUTES);}
  function updatePlacementPointer(clientX:number,clientY:number){
    const drag=placementDragRef.current;
    if(!drag||!drag.dragging)return;
    drag.clientX=clientX;drag.clientY=clientY;
    if(placementGhostRef.current)placementGhostRef.current.style.transform=`translate3d(${clientX+18}px,${clientY+18}px,0)`;
    const viewport=scrollRef.current;
    const grid=viewport?.querySelector<HTMLElement>('.day-grid[data-surface-id="combined"]');
    if(!viewport||!grid)return;
    const viewportRect=viewport.getBoundingClientRect();
    const gridRect=grid.getBoundingClientRect();
    const overTimeline=clientX>=gridRect.left&&clientX<=gridRect.right&&clientY>=viewportRect.top&&clientY<=viewportRect.bottom;
    const rawMinute=TIMELINE_START_MINUTE+(clientY-gridRect.top)/HOUR_PX*60;
    const start=Math.max(TIMELINE_START_MINUTE,Math.min(LAST_TIMELINE_MINUTE-TIMELINE_STEP_MINUTES,Math.round(rawMinute/TIMELINE_STEP_MINUTES)*TIMELINE_STEP_MINUTES));
    const valid=overTimeline&&start>=earliestAllowedMinute(date)&&start+TIMELINE_STEP_MINUTES<=TIMELINE_END_MINUTE;
    drag.nextStart=start;drag.valid=valid;
    setPlacementPreview({taskId:drag.task.id,title:drag.task.title,start,end:start+TIMELINE_STEP_MINUTES,valid,overTimeline});
  }
  function runPlacementAutoScroll(){
    placementScrollFrameRef.current=0;
    const drag=placementDragRef.current;const viewport=scrollRef.current;
    if(!drag?.dragging)return;
    if(!viewport){placementScrollFrameRef.current=window.requestAnimationFrame(runPlacementAutoScroll);return;}
    const rect=viewport.getBoundingClientRect();const edge=82;let delta=0;
    if(drag.clientY<rect.top+edge)delta=-Math.min(18,(rect.top+edge-drag.clientY)*.24);
    else if(drag.clientY>rect.bottom-edge)delta=Math.min(18,(drag.clientY-(rect.bottom-edge))*.24);
    if(delta){viewport.scrollTop=Math.max(0,Math.min(viewport.scrollHeight-viewport.clientHeight,viewport.scrollTop+delta));updatePlacementPointer(drag.clientX,drag.clientY);}
    placementScrollFrameRef.current=window.requestAnimationFrame(runPlacementAutoScroll);
  }
  function activatePlacementDrag(drag:PlacementDragState){
    if(drag.dragging||placementDragRef.current!==drag)return;
    drag.dragging=true;suppressTaskClickRef.current=drag.task.id;setTimelineMode("combined");
    setPlacementPreview({taskId:drag.task.id,title:drag.task.title,start:drag.nextStart,end:drag.nextStart+TIMELINE_STEP_MINUTES,valid:false,overTimeline:false});
    if(!placementScrollFrameRef.current)placementScrollFrameRef.current=window.requestAnimationFrame(runPlacementAutoScroll);
  }
  function beginPlacementPointer(event:React.PointerEvent<HTMLButtonElement>,task:Task){
    if(event.button!==0||placementDragRef.current||task.recordKind!=="formal"||task.lifecycleStatus!=="open"||task.scheduleKind!=="none")return;
    const pointerId=event.pointerId;
    placementDragRef.current={task,pointerId,originX:event.clientX,originY:event.clientY,clientX:event.clientX,clientY:event.clientY,dragging:false,nextStart:earliestAllowedMinute(date),valid:false,startedAt:performance.now()};
    if(placementHoldTimerRef.current)window.clearTimeout(placementHoldTimerRef.current);
    placementHoldTimerRef.current=window.setTimeout(()=>{placementHoldTimerRef.current=0;const current=placementDragRef.current;if(current?.pointerId===pointerId)activatePlacementDrag(current);},110);
    try{event.currentTarget.setPointerCapture(pointerId);}catch{/* Window-level motion still keeps the placement gesture alive. */}
  }
  function movePlacementPointer(event:React.PointerEvent<HTMLButtonElement>){
    const drag=placementDragRef.current;if(!drag||drag.pointerId!==event.pointerId)return;
    if(!drag.dragging&&Math.hypot(event.clientX-drag.originX,event.clientY-drag.originY)<5&&performance.now()-drag.startedAt<90)return;
    event.preventDefault();
    if(!drag.dragging)activatePlacementDrag(drag);
    updatePlacementPointer(event.clientX,event.clientY);
  }
  async function finishPlacementPointer(event:React.PointerEvent<HTMLButtonElement>){
    const drag=placementDragRef.current;if(!drag||drag.pointerId!==event.pointerId||drag.dragging)return;
    placementDragRef.current=null;if(placementHoldTimerRef.current){window.clearTimeout(placementHoldTimerRef.current);placementHoldTimerRef.current=0;}
  }
  async function completePlacementGesture(){
    const drag=placementDragRef.current;if(!drag)return;
    const shouldSave=drag.dragging&&drag.valid;const task=drag.task;const start=drag.nextStart;
    placementDragRef.current=null;if(placementHoldTimerRef.current){window.clearTimeout(placementHoldTimerRef.current);placementHoldTimerRef.current=0;}if(placementScrollFrameRef.current){window.cancelAnimationFrame(placementScrollFrameRef.current);placementScrollFrameRef.current=0;}
    setPlacementPreview(null);
    if(!drag.dragging)return;
    if(!shouldSave)return;
    setBusy(true);setError(null);
    try{
      await withConflict(`/api/v1/tasks/${task.id}`,"PATCH",{expectedVersion:task.version,expectedScheduleRevision:task.scheduleRevision,scheduleKind:"exact",startAt:iso(date,hhmm(start)),endAt:iso(date,hhmm(start+TIMELINE_STEP_MINUTES)),timeZone:"Asia/Shanghai"});
      await load();setNewTaskInkId(task.id);feedbackTimersRef.current.push(window.setTimeout(()=>setNewTaskInkId(null),900));
    }catch(error){if(!(error instanceof ConflictDecisionCancelledError))setError("排期没有保存，任务已回到未排期列表。");}
    finally{setBusy(false);}
  }
  function cancelPlacementGesture(){
    const drag=placementDragRef.current;if(!drag)return;
    if(drag.dragging)suppressTaskClickRef.current=drag.task.id;
    placementDragRef.current=null;if(placementHoldTimerRef.current){window.clearTimeout(placementHoldTimerRef.current);placementHoldTimerRef.current=0;}if(placementScrollFrameRef.current){window.cancelAnimationFrame(placementScrollFrameRef.current);placementScrollFrameRef.current=0;}setPlacementPreview(null);
  }
  function cancelPlacementPointer(event:React.PointerEvent<HTMLButtonElement>){const drag=placementDragRef.current;if(drag?.pointerId===event.pointerId)cancelPlacementGesture();}
  function openTaskFromList(task:Task){if(suppressTaskClickRef.current===task.id){suppressTaskClickRef.current=null;return;}if(task.recordKind==="formal"&&task.lifecycleStatus==="open")editTask(task);else closeTaskActions();}
  function gridMinute(e:React.PointerEvent<HTMLDivElement>){
    const rect=e.currentTarget.getBoundingClientRect();
    const start=Number(e.currentTarget.dataset.rangeStart??TIMELINE_START_MINUTE);
    const end=Number(e.currentTarget.dataset.rangeEnd??TIMELINE_END_MINUTE);
    const topInset=Number(e.currentTarget.dataset.topInset??0);
    const raw=start+(e.clientY-rect.top-topInset)/HOUR_PX*60;
    return snapTimelineMinute(raw,start,end);
  }
  function beginRange(e:React.PointerEvent<HTMLDivElement>){
    if(e.button!==0||e.target!==e.currentTarget)return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const minute=gridMinute(e);
    const rangeStart=Number(e.currentTarget.dataset.rangeStart??TIMELINE_START_MINUTE);
    const rangeEnd=Number(e.currentTarget.dataset.rangeEnd??TIMELINE_END_MINUTE);
    const next={pointerId:e.pointerId,start:minute,current:minute,moved:false,surfaceId:e.currentTarget.dataset.surfaceId??"combined",rangeStart,rangeEnd};
    rangeRef.current=next;setRange(next);
  }
  function moveRange(e:React.PointerEvent<HTMLDivElement>){const current=rangeRef.current;if(!current||current.pointerId!==e.pointerId)return;const minute=gridMinute(e);const next={...current,current:minute,moved:current.moved||minute!==current.start};rangeRef.current=next;setRange(next);}
  function endRange(e:React.PointerEvent<HTMLDivElement>){
    const current=rangeRef.current;
    if(!current||current.pointerId!==e.pointerId)return;
    rangeRef.current=null;setRange(null);
    if(!current.moved||current.start===current.current)return;
    const interval=normalizedTimelineRange(current.start,current.current,current.rangeStart,current.rangeEnd);
    const earliest=earliestAllowedMinute(date);
    const entryMode:FormState["entryMode"]=date===today()&&interval.start<earliest?"backfill":"schedule";
    setEditing(null);setSource(null);setForm(emptyForm(date,hhmm(interval.start),hhmm(interval.end),entryMode));
  }

  function selectPeriod(period:TimelinePeriodKey){frontPeriodUserSelectedRef.current=true;setFrontPeriod(period);}
  function switchTimelineMode(nextMode:TimelineMode){
    if(nextMode===timelineMode)return;
    if(timelineMode==="combined"&&scrollRef.current){
      const element=scrollRef.current;
      combinedScrollPositionsRef.current.set(date,element.scrollTop);
      const focusMinute=TIMELINE_START_MINUTE+((element.scrollTop+element.clientHeight/2)/HOUR_PX)*60;
      const period=TIMELINE_PERIODS.find(item=>focusMinute>=item.start&&focusMinute<item.end)??TIMELINE_PERIODS.at(-1)!;
       frontPeriodUserSelectedRef.current=true;
       setFrontPeriod(period.key);
    }
    setTimelineMode(nextMode);
  }

  function renderTimelineGrid(surfaceId:string,rangeStart=TIMELINE_START_MINUTE,rangeEnd=TIMELINE_END_MINUTE){
    const activeRange=range?.surfaceId===surfaceId?range:null;
    const activePreview=activeRange?.moved&&activeRange.start!==activeRange.current?normalizedTimelineRange(activeRange.start,activeRange.current,rangeStart,rangeEnd):null;
    const topInset=surfaceId==="combined"?0:TIMELINE_PERIOD_TOP_INSET_PX;
    const timelineHeight=(rangeEnd-rangeStart)/60*HOUR_PX;
    const gridHeight=timelineHeight+topInset;
    const currentMinute=minuteOf(new Date(clockNowMs).toISOString());
    const surfaceExact=exact.filter(task=>minuteOf(task.endAt)>rangeStart&&minuteOf(task.startAt)<rangeEnd);
    const surfaceBackfills=backfills.filter(task=>minuteOf(task.endAt)>rangeStart&&minuteOf(task.startAt)<rangeEnd);
    const surfaceMaximumLaneCount=Math.max(1,...surfaceExact.map(task=>lanes.get(task.id)?.count??1));
    const surfaceFormalTimelineWidth=surfaceBackfills.length>0?72:100;
    const surfaceTimelineMinimumWidth=surfaceMaximumLaneCount>=3?surfaceMaximumLaneCount*MIN_READABLE_LANE_PX+(surfaceBackfills.length>0?180:0):undefined;
    const surfaceLabel=surfaceId==="combined"?"07:00至23:00合并时间轴":surfaceId==="morning"?"上午时间轴":surfaceId==="afternoon"?"下午时间轴":"晚上时间轴";
    return <div aria-label={surfaceLabel} data-surface-id={surfaceId} data-range-start={rangeStart} data-range-end={rangeEnd} data-top-inset={topInset} className={`day-grid ${surfaceMaximumLaneCount>=3?"multi-lane":""} ${surfaceBackfills.length>0?"has-fact-records":""} ${placementPreview?.overTimeline?"placement-active":""}`} style={{height:gridHeight,minHeight:gridHeight,minWidth:surfaceTimelineMinimumWidth}} onPointerDown={beginRange} onPointerMove={moveRange} onPointerUp={endRange} onPointerCancel={()=>{rangeRef.current=null;setRange(null);}}>
      {Array.from({length:Math.floor((rangeEnd-rangeStart)/60)+1},(_,index)=>rangeStart/60+index).map(hour=>{const terminal=hour*60===rangeEnd;return <div className="hour-line" data-terminal={terminal?"true":undefined} style={{top:terminal?gridHeight-1:topInset+(hour-rangeStart/60)*HOUR_PX}} key={hour}><time>{String(hour).padStart(2,"0")}:00</time></div>;})}
      {date===today()&&currentMinute>=rangeStart&&currentMinute<=rangeEnd&&<div className="now-line" style={{top:topInset+timelineTop(currentMinute,rangeStart)}}><span>现在</span></div>}
      {activeRange&&<div className="range-anchor" aria-hidden="true" style={{top:topInset+timelineTop(activeRange.start,rangeStart)}}/>}
      {activePreview&&<div className={`range-preview ${date===today()&&activePreview.start<earliestAllowedMinute(date)?"backfill":""}`} style={{top:topInset+timelineTop(activePreview.start,rangeStart),height:Math.max(18,(activePreview.end-activePreview.start)/60*HOUR_PX)}}><span>{hhmm(activePreview.start)}–{hhmm(activePreview.end)}</span></div>}
      {surfaceId==="combined"&&placementPreview?.overTimeline&&<div className={`placement-preview ${placementPreview.valid?"valid":"invalid"}`} style={{top:timelineTop(placementPreview.start,rangeStart),height:TIMELINE_STEP_MINUTES/60*HOUR_PX}}><span>{hhmm(placementPreview.start)}–{hhmm(placementPreview.end)}</span><strong>{placementPreview.title}</strong></div>}
      {surfaceExact.map(task=>{const value=preview[task.id]??{start:minuteOf(task.startAt),end:minuteOf(task.endAt)};const visibleStart=Math.max(rangeStart,value.start);const visibleEnd=Math.min(rangeEnd,value.end);const locked=task.lifecycleStatus!=="open";const lane=lanes.get(task.id)??{index:0,count:1};const width=`calc(${surfaceFormalTimelineWidth/lane.count}% - 10px)`;const left=`calc(${lane.index*surfaceFormalTimelineWidth/lane.count}% + 2px)`;const overlapLabel=conflict(task.id)?lane.count>1?`冲突车道 ${lane.index+1}/${lane.count}`:"冲突已保留":historical(task.id)?"历史重叠":"精确排期";return <article data-task-id={task.id} data-lane-index={lane.index+1} data-lane-count={lane.count} className={`time-block ${task.lifecycleStatus} ${lane.count>=3?"dense-lanes":""} ${conflict(task.id)?"conflict":""} ${historical(task.id)?"historical":""} ${newTaskInkId===task.id?"new-task-ink":""} ${completedTaskSealId===task.id?"completion-seal-landing":""} ${conflictPulseIds.has(task.id)?"conflict-pulse":""}`} style={{top:topInset+timelineTop(visibleStart,rangeStart),height:Math.max(18,(visibleEnd-visibleStart)/60*HOUR_PX),width,left}} key={task.id} tabIndex={locked?-1:0} title={lane.count>1?`与其他任务重叠，当前为第 ${lane.index+1}/${lane.count} 条车道`:undefined} aria-busy={busy} aria-label={`${task.title} ${hhmm(value.start)}至${hhmm(value.end)}${lane.count>1?`，重叠车道 ${lane.index+1}/${lane.count}`:""}`} onKeyDown={e=>handleTaskKeyDown(e,task)} onPointerDown={e=>beginPointer(e,task,"move")} onPointerMove={movePointer} onPointerUp={endPointer} onPointerCancel={cancelPointer}><div className="block-copy"><time>{hhmm(value.start)}–{hhmm(value.end)}</time><strong>{task.title}</strong><small>{overlapLabel}</small></div>{completedTaskSealId===task.id&&<span className="task-completion-seal" aria-hidden="true">成</span>}{task.lifecycleStatus==="open"&&lane.count<3&&<button className="block-edit" onPointerDown={e=>e.stopPropagation()} onClick={()=>editTask(task)} aria-label="编辑任务"><Pencil/></button>}{task.lifecycleStatus!=="active"&&<button className="block-actions-toggle" onPointerDown={e=>e.stopPropagation()} onClick={e=>toggleTaskActions(task.id,"timeline",e)} aria-label={`打开 ${task.title} 的任务操作`}><MoreHorizontal/></button>}{actionMenu(task,"timeline")}{!locked&&<button className="resize-handle" aria-label="调整任务时长" onPointerDown={e=>{e.stopPropagation();beginPointer(e,task,"resize");}} onPointerMove={movePointer} onPointerUp={endPointer} onPointerCancel={cancelPointer}><GripHorizontal/></button>}{locked&&<span className="block-lock">{task.lifecycleStatus==="closed"?outcomeLabel(task):task.lifecycleStatus==="awaiting_outcome"?"等待记录结果":"锁定"}</span>}</article>;})}
      {surfaceBackfills.map(task=>{const start=Math.max(rangeStart,minuteOf(task.startAt));const end=Math.min(rangeEnd,minuteOf(task.endAt));const rawStart=minuteOf(task.startAt);const rawEnd=minuteOf(task.endAt);const factOutcome=task.currentOutcome?outcomeLabel(task):"待记录结果";return <article data-task-id={task.id} data-record-kind="backfill" className={`time-block fact-record ${task.lifecycleStatus}`} style={{top:topInset+timelineTop(start,rangeStart),height:Math.max(18,(end-start)/60*HOUR_PX),left:`calc(${surfaceFormalTimelineWidth}% + 4px)`,width:`calc(${100-surfaceFormalTimelineWidth}% - 10px)`}} key={task.id} aria-label={`事实记录：${task.title}，${hhmm(rawStart)}至${hhmm(rawEnd)}`}><div className="block-copy"><span className="record-kind-badge">事实记录</span><time>{hhmm(rawStart)}–{hhmm(rawEnd)}</time><strong>{task.title}</strong><small>{factOutcome} · 不占正式排期</small></div>{task.lifecycleStatus!=="active"&&<button className="block-actions-toggle" onPointerDown={e=>e.stopPropagation()} onClick={e=>toggleTaskActions(task.id,"timeline",e)} aria-label={`打开 ${task.title} 的事实记录操作`}><MoreHorizontal/></button>}{actionMenu(task,"timeline")}</article>;})}
    </div>;
  }

  function renderTaskListRow(t:Task){
    const draggable=t.recordKind==="formal"&&t.lifecycleStatus==="open"&&t.scheduleKind==="none";
    const scheduledStatus=t.recordKind==="formal"&&t.scheduleKind!=="none"?scheduledTaskStatus(t):null;
    return <article className={`${t.recordKind==="backfill"?"fact-record-row":""} ${draggable?"unscheduled-draggable":""} ${placementPreview?.taskId===t.id?"placement-source":""} ${completedTaskSealId===t.id?"completion-seal-landing":""}`} key={t.id}>
      <button type="button" onClick={()=>openTaskFromList(t)} onPointerDown={draggable?event=>beginPlacementPointer(event,t):undefined} onPointerMove={draggable?movePlacementPointer:undefined} onPointerUp={draggable?event=>void finishPlacementPointer(event):undefined} onPointerCancel={draggable?cancelPlacementPointer:undefined} aria-label={draggable?`未排期 ${t.title}，拖到时间轴安排 30 分钟`:undefined}>
        <span>{t.recordKind==="backfill"?"事实记录":t.scheduleKind==="exact"&&t.startAt&&t.endAt?`${hhmm(minuteOf(t.startAt))}–${hhmm(minuteOf(t.endAt))}`:t.scheduleKind==="daypart"?({morning:"上午",afternoon:"下午",evening:"晚上"}[t.daypart!]):"未排期"}</span>
        <strong>{t.title}</strong>
        {draggable&&<small className="placement-hint">拖到时间轴 · 默认 30 分钟</small>}
        {t.recordKind==="backfill"&&<small>实际记录 · 不占正式排期 · 不提醒</small>}
        {t.recordKind==="formal"&&<small className={`task-lifecycle-status ${t.lifecycleStatus}${scheduledStatus?` status-framed status-${scheduledStatus.tone}`:""}`}>{scheduledStatus?.label??taskStatusLabel(t)}</small>}
        {t.recordKind==="formal"&&t.scheduleKind==="exact"&&t.startAt&&t.endAt&&(minuteOf(t.startAt)<TIMELINE_START_MINUTE||minuteOf(t.endAt)>TIMELINE_END_MINUTE)&&<small>历史任务：不在 07:00–23:00 可排时段</small>}
      </button>
      {completedTaskSealId===t.id&&<span className="task-completion-seal" aria-hidden="true">成</span>}
      {t.lifecycleStatus!=="active"&&<button className="list-actions-toggle" onClick={e=>toggleTaskActions(t.id,"list",e)} aria-label={`打开 ${t.title} 的${t.recordKind==="backfill"?"事实记录":"任务"}操作`}><MoreHorizontal/></button>}
      {actionMenu(t,"list")}
    </article>;
  }

  return <section className="today-workspace">
    <header className="timeline-header">
      <svg className="today-ink-landscape" viewBox="0 0 900 300" preserveAspectRatio="none" aria-hidden="true"><path className="ink-mountain ink-mountain-far" d="M130 244C212 213 248 128 326 158C379 179 401 237 459 210C529 177 548 91 625 119C684 140 707 211 771 188C819 171 850 130 900 118"/><path className="ink-mountain ink-mountain-near" d="M253 259C324 225 343 185 397 194C449 203 472 250 531 224C596 194 620 157 679 174C735 191 761 239 838 207"/><path className="ink-flight" d="M696 79c11-10 23-10 34 0m-34 0c-10-8-20-8-29 0M764 111c8-7 17-7 25 0m-25 0c-7-6-14-6-21 0"/></svg>
      <SeasonalPlant date={date} />
      <div className="today-inscription" aria-hidden="true"><span>一日有序</span><i/><span>心自从容</span></div>
      <div className="today-title-lockup"><div className="today-title-row"><span className="today-title-han">今日</span><span className="today-title-latin">TODAY</span><span className="today-seal">今</span></div><h1>把今天放回时间里。</h1><small className="timeline-rule">{date===today()?`可排时段 07:00–23:00；未来安排从 ${hhmm(earliestAllowedMinute(date))} 开始，过去时段可补录。`:"可排时段 07:00–23:00"}</small></div>
      <div className="timeline-date"><div className="date-folio" key={date}><span>日</span><strong>{dateFolio.day}</strong><small>{dateFolio.meta}</small></div><label className="date-picker"><span>选择日期</span><div className="date-picker-field"><input aria-label="时间轴日期" type="date" value={date} onChange={e=>setDate(e.target.value)}/><CalendarDays className="date-picker-icon" aria-hidden="true" /></div></label></div>
    </header>
    {error&&!form&&<div className="timeline-alert" role="alert"><AlertTriangle/>{error}<button onClick={()=>setError(null)} aria-label="关闭"><X/></button></div>}
    <div className="today-chapter-heading"><div><span className="chapter-mark">时</span><span><strong>今日时间轴</strong><small>TIME · 07 — 23</small></span></div><i/></div>
    <section className={`today-health-summary ${healthExpanded?"expanded":""}`} aria-label="今日健康参考摘要">
      <button className="today-health-toggle" type="button" aria-expanded={healthExpanded} onClick={()=>setHealthExpanded(value=>!value)}><span><HeartPulse/></span><div><p className="section-kicker">今日健康参考</p><strong>{healthSummary?`${healthActivityLabel[healthSummary.day.content.movement.category]} · ${healthIntensityLabel[healthSummary.day.content.movement.intensity]}`:"本周还没有确认的健康参考"}</strong></div><ChevronDown/></button>
      {healthExpanded&&<div className="today-health-detail">{healthSummary?<><div><Leaf/><p>{healthSummary.day.content.nutritionDirection}</p><small>蛋白质来源：约 {healthSummary.day.content.proteinRangeGrams.minimum}–{healthSummary.day.content.proteinRangeGrams.maximum} g / 天；时令蔬菜：{healthSummary.day.content.seasonalVegetables.join(" · ")}</small></div><div><HeartPulse/><p>{healthSummary.day.content.movement.durationMinutes.maximum===0?"今天以休息和日常轻松活动为主。":`${healthSummary.day.content.movement.durationMinutes.minimum}–${healthSummary.day.content.movement.durationMinutes.maximum} 分钟，${healthIntensityLabel[healthSummary.day.content.movement.intensity]}。`}</p><small>{healthSummary.day.content.movement.safetyReminder}</small></div></>:<p>健康参考只在你确认后显示在今日页，不会自动创建任务或要求打卡。</p>}<button className="quiet-button" type="button" onClick={onOpenHealth}>打开完整健康参考</button></div>}
    </section>
    <div className="today-layout"><main className="day-canvas"><div className="day-toolbar"><div className="day-toolbar-title"><span>刻</span><div><strong>精确时间</strong><small>半小时为一格</small></div></div><div className="timeline-view-switch" role="group" aria-label="时间轴显示方式"><button type="button" aria-pressed={timelineMode==="segmented"} onClick={()=>switchTimelineMode("segmented")}>三段叠页</button><button type="button" aria-pressed={timelineMode==="combined"} onClick={()=>switchTimelineMode("combined")}>合并长轴</button></div><small>{backfills.length>0?`${backfills.length} 条事实记录独立显示，不占正式排期` : maximumLaneCount>=3?`${maximumLaneCount} 条重叠车道，可在时间轴内横向查看`:`拖动空白处创建，普通单击不会打开表单`}</small></div>
      {timelineMode==="combined"?<div className="day-scroll combined-timeline timeline-layout-enter" ref={scrollRef}>{renderTimelineGrid("combined")}</div>:<div className="timeline-period-list timeline-period-deck timeline-layout-enter" data-front-period={frontPeriod}>
        <nav className="timeline-period-tab-rail" aria-label="选择时间段">{TIMELINE_PERIODS.map((period,order)=>{const isFront=period.key===frontPeriod;const stackRank=(order-frontPeriodOrder+TIMELINE_PERIODS.length)%TIMELINE_PERIODS.length;return <button className={`timeline-period-sheet-tab period-tab period-tab-${period.key}`} style={{"--stack-rank":stackRank} as CSSProperties} data-stack-rank={stackRank} type="button" aria-label={isFront?`当前${period.label}时间轴，点击切换`:`查看${period.label}时间轴`} aria-expanded={isFront} onClick={()=>selectPeriod(period.key)} key={period.key}><span>{period.label}</span><small>{hhmm(period.start)}—{hhmm(period.end)}</small></button>;})}</nav>
        {TIMELINE_PERIODS.map((period,order)=>{const isFront=period.key===frontPeriod;const stackRank=(order-frontPeriodOrder+TIMELINE_PERIODS.length)%TIMELINE_PERIODS.length;const periodTasks=exact.filter(task=>minuteOf(task.endAt)>period.start&&minuteOf(task.startAt)<period.end).length;return <section className={`timeline-period-card timeline-period-sheet period-${period.key} ${isFront?"timeline-period-front expanded":"timeline-period-back"}`} style={{"--stack-rank":stackRank,"--period-order":order} as CSSProperties} key={period.key} data-front={isFront?"true":undefined} data-stack-rank={stackRank} aria-label={`${period.label}时间轴纸页`}>{isFront&&<><span className="timeline-period-sheet-count">{periodTasks} 项</span><div className="period-timeline-viewport" style={{height:(period.end-period.start)/60*HOUR_PX+TIMELINE_PERIOD_TOP_INSET_PX}}>{renderTimelineGrid(period.key,period.start,period.end)}</div></>}</section>;})}
      </div>}
    </main>
    <aside className="capture-panel"><section className="quick-capture"><div className="section-heading compact"><div><p className="section-kicker">快速记录</p><h2>先放进来</h2></div>{quickKind==="task"?<button className="quick-full-add" type="button" onClick={()=>{setError(null);setEditing(null);setSource(null);setForm(emptyForm(date));}}><CalendarPlus/>完整添加</button>:<Lightbulb className="quick-lightbulb" aria-hidden="true"/>}</div><div className="entry-switch">{(["task","idea","question"] as const).map(k=><button aria-pressed={quickKind===k} onClick={()=>setQuickKind(k)} key={k}>{k==="task"?"任务":k==="idea"?"想法":"问题"}</button>)}</div><form onSubmit={quickSave}><textarea aria-label="快速记录内容" placeholder={quickKind==="task"?"写下一件准备完成的事……":quickKind==="idea"?"先记下灵光，不必现在整理……":"把仍待解决的问题放在这里……"} value={quick} onChange={e=>setQuick(e.target.value)} rows={3} maxLength={200}/><button className="primary-button full-width" disabled={busy||!quick.trim()}>{busy?<LoaderCircle className="spin"/>:<Check/>}保存</button></form></section>
      <section className="task-dock"><header><div><ListTodo/><span><strong>任务列表</strong><small>已排期 {scheduledTasks.length} · 未排期 {unscheduledTasks.length}</small></span></div><button className="trash-icon-button" type="button" onClick={()=>setTrashOpen(true)} aria-label={`打开回收站，${trash.length} 项`}><Trash2/><span>{trash.length}</span></button></header><div className="task-summary-list">
        <section className="task-summary-group scheduled" aria-labelledby="scheduled-task-heading"><button className="task-summary-group-heading task-summary-group-toggle" type="button" aria-expanded={scheduledTasksOpen} onClick={()=>setScheduledTasksOpen(value=>!value)}><span><strong id="scheduled-task-heading">已排期任务</strong></span><span className="task-summary-group-meta">{scheduledTasks.length} 项<ChevronDown className={scheduledTasksOpen?"expanded":""}/></span></button>{scheduledTasksOpen&&(displayedScheduledTasks.length===0?<small className="task-summary-empty">今天还没有已排期任务。</small>:<>{displayedScheduledTasks.map(renderTaskListRow)}{hiddenScheduledTaskCount>0||scheduledTasksExpanded?<button className="task-dock-toggle" type="button" onClick={()=>setScheduledTasksExpanded(value=>!value)}>{scheduledTasksExpanded?"收起已排期其他任务":`展开已排期其他 ${hiddenScheduledTaskCount} 项`}<ChevronDown className={scheduledTasksExpanded?"expanded":""}/></button>:null}</>)}</section>
        <section className="task-summary-group unscheduled" aria-labelledby="unscheduled-task-heading"><button className="task-summary-group-heading task-summary-group-toggle" type="button" aria-expanded={unscheduledTasksOpen} onClick={()=>setUnscheduledTasksOpen(value=>!value)}><span><strong id="unscheduled-task-heading">未排期任务</strong><small>可拖入时间轴</small></span><span className="task-summary-group-meta">{unscheduledTasks.length} 项<ChevronDown className={unscheduledTasksOpen?"expanded":""}/></span></button>{unscheduledTasksOpen&&(displayedUnscheduledTasks.length===0?<small className="task-summary-empty">今天还没有未排期任务。</small>:<>{displayedUnscheduledTasks.map(renderTaskListRow)}{hiddenUnscheduledTaskCount>0||unscheduledTasksExpanded?<button className="task-dock-toggle" type="button" onClick={()=>setUnscheduledTasksExpanded(value=>!value)}>{unscheduledTasksExpanded?"收起未排期其他任务":`展开未排期其他 ${hiddenUnscheduledTaskCount} 项`}<ChevronDown className={unscheduledTasksExpanded?"expanded":""}/></button>:null}</>)}</section>
      </div>{(scheduledTasksOpen||unscheduledTasksOpen)&&cancelled.length>0&&<div className="cancelled-summary"><p className="section-kicker">已取消</p>{cancelled.map(t=><article key={t.id}><strong>{t.title}</strong><button onClick={()=>void runTaskAction(t,"reopen")} aria-label={`重新打开 ${t.title}`}><RotateCcw/></button><button onClick={()=>void runTaskAction(t,"delete")} aria-label={`将 ${t.title} 移入回收站`}><Trash2/></button></article>)}</div>}</section>
      <section className="inbox-list"><p className="section-kicker">等待整理</p>{inbox.length===0?<small>没有待整理的想法或问题。</small>:displayedInbox.map(entry=><article key={entry.id}><span>{entry.entryKind==="idea"?"想法":"问题"}</span><p>{entry.content}</p><button onClick={()=>{setSource(entry);setEditing(null);setForm({...emptyForm(date),title:entry.content,notes:entry.notes??""});}}>转为任务</button></article>)}{inbox.length>3&&<button className="task-dock-toggle" type="button" onClick={()=>setInboxExpanded(value=>!value)}>{inboxExpanded?"收起":`查看其他 ${inbox.length-3} 项`}<ChevronDown className={inboxExpanded?"expanded":""}/></button>}</section>
    </aside></div>
    {placementPreview&&<div ref={placementGhostRef} className={`task-placement-ghost ${placementPreview.valid?"valid":"invalid"}`} aria-hidden="true"><span>{hhmm(placementPreview.start)}–{hhmm(placementPreview.end)}</span><strong>{placementPreview.title}</strong><small>{placementPreview.valid?"松开即排入长轴":"移到可排时间内"}</small></div>}
    {form&&<div className="task-dialog-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget){setForm(null);setEditing(null);setSource(null);}}}><section className="task-dialog" role="dialog" aria-modal="true" aria-labelledby="task-form-title"><header><div><p className="section-kicker">{form.entryMode==="backfill"?"当天补录":form.origin==="health"?"从健康参考建立任务":form.origin==="plan_change"?"协商候选调整":source?"从收件箱建立任务":editing?"编辑任务":"完整添加"}</p><h2 id="task-form-title">{form.entryMode==="backfill"?"补上今天已经发生的事项":form.origin==="health"?"重新确认任务的开始和结束时间":form.origin==="plan_change"?"检查清楚，再决定是否保存":"让这项安排足够清楚"}</h2></div><button onClick={()=>setForm(null)} aria-label="关闭"><X/></button></header><form onSubmit={saveForm}>{form.entryMode==="backfill"&&<p className="field-wide backfill-note"><strong>这是事实记录，不是新的排期。</strong>保留你实际发生的开始和结束时间；不占正式排期、不制造冲突、不创建提醒、不启动专注，也不计入有效专注和成长积分。</p>}{form.origin==="health"&&<p className="field-wide backfill-note">原健康参考会继续保留。这里只创建一项独立正式任务，不会自动生成专注结构，也不会把健康参考标记为完成。</p>}{form.origin==="plan_change"&&<div className="field-wide plan-change-form-note"><strong>尚未修改任务</strong><p>{form.advisoryReason}</p><small>这是 AI 的排期候选。你可以继续修改所有字段；只有点击下方“确认并保存调整”才会写入数据库。</small></div>}<label className="field-wide"><span>任务标题</span><input autoFocus required maxLength={200} value={form.title} onChange={e=>setForm({...form,title:e.target.value})}/></label><label><span>排期方式</span><select disabled={form.entryMode==="backfill"||form.origin==="health"} value={form.scheduleKind} onChange={e=>setForm({...form,scheduleKind:e.target.value as ScheduleKind})}><option value="none">未排期</option><option value="daypart">时间段</option><option value="exact">精确时间</option></select></label><label><span>日期</span><input type="date" disabled={form.entryMode==="backfill"} required={form.scheduleKind!=="none"} value={form.localDate} onChange={e=>setForm({...form,localDate:e.target.value})}/></label>{form.scheduleKind==="daypart"&&<label><span>时间段</span><select value={form.daypart} onChange={e=>setForm({...form,daypart:e.target.value as Daypart})}><option value="morning">上午</option><option value="afternoon">下午</option><option value="evening">晚上</option></select></label>}{form.scheduleKind==="exact"&&<><label><span>开始时间</span><input type="time" step="1800" min={form.entryMode==="backfill"?hhmm(TIMELINE_START_MINUTE):form.localDate===today()?hhmm(earliestAllowedMinute(form.localDate)):hhmm(TIMELINE_START_MINUTE)} max={form.entryMode==="backfill"?hhmm(Math.max(TIMELINE_START_MINUTE,earliestAllowedMinute(form.localDate)-TIMELINE_STEP_MINUTES)):hhmm(TIMELINE_END_MINUTE-TIMELINE_STEP_MINUTES)} required value={form.start} onChange={e=>setForm({...form,start:e.target.value})}/></label><label><span>结束时间</span><input type="time" step="1800" min={hhmm(TIMELINE_START_MINUTE+TIMELINE_STEP_MINUTES)} max={form.entryMode==="backfill"?hhmm(earliestAllowedMinute(form.localDate)):hhmm(TIMELINE_END_MINUTE)} required value={form.end} onChange={e=>setForm({...form,end:e.target.value})}/></label></>}<label className="field-wide"><span>备注</span><textarea rows={3} maxLength={4000} value={form.notes} onChange={e=>setForm({...form,notes:e.target.value})}/></label><footer className="field-wide"><button type="button" className="text-button" onClick={()=>setForm(null)}>取消</button><button className="primary-button" disabled={busy}>{busy?<LoaderCircle className="spin"/>:<Sparkles/>}{form.entryMode==="backfill"?"保存并记录结果":form.origin==="health"?"确认时间并创建任务":form.origin==="plan_change"?"确认并保存调整":source?"确认并转为任务":"保存任务"}</button></footer></form></section></div>}
    {trashOpen&&<div className="task-dialog-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)setTrashOpen(false);}}><section className="trash-dialog" role="dialog" aria-modal="true" aria-labelledby="trash-dialog-title"><header><div><p className="section-kicker">回收站</p><h2 id="trash-dialog-title">查找并恢复任务</h2><small>任务默认保留 {recycleRetentionDays} 天；到期后由本地 Worker 永久清理，恢复时仍会重新检查版本与冲突。</small></div><div className="trash-dialog-header-actions">{trash.length>0&&<button className="trash-empty-button" type="button" disabled={busy} onClick={()=>void emptyTrash()}>一键清空</button>}<button type="button" aria-label="关闭回收站" onClick={()=>setTrashOpen(false)}><X/></button></div></header><label className="trash-search"><Search/><input autoFocus value={trashQuery} onChange={e=>setTrashQuery(e.target.value)} placeholder="搜索任务标题或备注" aria-label="搜索回收站任务"/></label><div className="trash-results">{filteredTrash.length===0?<p>{trashQuery.trim()?"没有匹配的任务。":"回收站是空的。"}</p>:filteredTrash.map(task=>{const remaining=task.deletedAt?Math.max(0,Math.ceil((new Date(task.deletedAt).getTime()+recycleRetentionDays*86_400_000-Date.now())/86_400_000)):recycleRetentionDays;return <article key={task.id}><div><span>{task.scheduleKind==="exact"&&task.startAt?`${localDateOf(task.startAt)} ${hhmm(minuteOf(task.startAt))}`:task.localDate??"未排期"} · 约剩 {remaining} 天</span><strong>{task.title}</strong>{task.notes&&<small>{task.notes}</small>}</div><button type="button" disabled={busy} onClick={()=>void runTaskAction(task,"restore")}><RotateCcw/>恢复</button></article>;})}</div></section></div>}
    {outcomeDraft&&<div className="task-dialog-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)setOutcomeDraft(null);}}><section className={`themed-outcome-dialog focus-theme-${focusTheme}`} role="dialog" aria-modal="true" aria-labelledby="outcome-title"><header className="themed-outcome-titlebar"><span>{outcomeDraft.mode==="edit"?"重新打开评价":"记录本次结果"}</span><button type="button" onClick={()=>setOutcomeDraft(null)} aria-label="关闭评价"><X/></button></header><div className="themed-outcome-body">{focusTheme==="cyber"?<CyberFocusEvaluation taskTitle={outcomeDraft.task.title} outcome={outcomeDraft.outcome} progress={outcomeDraft.progress} satisfaction={outcomeDraft.satisfaction} note={outcomeDraft.note} showNote busy={busy} error={error} onOutcomeChange={chooseOutcome} onProgressChange={value=>setOutcomeDraft({...outcomeDraft,progress:value})} onSatisfactionChange={value=>setOutcomeDraft({...outcomeDraft,satisfaction:value})} onNoteChange={value=>setOutcomeDraft({...outcomeDraft,note:value})} onSubmit={()=>void submitOutcome()}/>:<FocusEvaluationForm headingId="outcome-title" taskTitle={outcomeDraft.task.title} outcome={outcomeDraft.outcome} progress={outcomeDraft.progress} satisfaction={outcomeDraft.satisfaction} note={outcomeDraft.note} showNote busy={busy} error={error} onOutcomeChange={chooseOutcome} onProgressChange={value=>setOutcomeDraft({...outcomeDraft,progress:value})} onSatisfactionChange={value=>setOutcomeDraft({...outcomeDraft,satisfaction:value})} onNoteChange={value=>setOutcomeDraft({...outcomeDraft,note:value})} onSubmit={()=>void submitOutcome()}/>}</div></section></div>}
    {outcomeHistory&&<div className="task-dialog-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)setOutcomeHistory(null);}}><section className="outcome-history-dialog" role="dialog" aria-modal="true" aria-labelledby="outcome-history-title"><header><div><p className="section-kicker">追加式结果记录</p><h2 id="outcome-history-title">结果历史</h2><small>{outcomeHistory.task.title}</small></div><button type="button" aria-label="关闭结果历史" onClick={()=>setOutcomeHistory(null)}><X/></button></header>{historyLoading?<div className="outcome-history-loading"><LoaderCircle className="spin"/>正在读取结果记录</div>:outcomeHistory.outcomes.length===0?<p className="outcome-history-empty">这项任务还没有保存过结果。</p>:<ol>{outcomeHistory.outcomes.map(item=><li key={item.id}><div><strong>{outcomeLabelValue(item.outcome)}</strong><span>{item.progressPercent}%</span></div><time>{new Intl.DateTimeFormat("zh-CN",{timeZone:"Asia/Shanghai",month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit",hour12:false}).format(new Date(item.recordedAt))}</time><small>{item.source==="system"?"系统恢复":item.source==="feishu"?"飞书":item.source==="ai"?"AI 协助":"软件记录"}</small>{item.note&&<p>{item.note}</p>}</li>)}</ol>}<footer><button type="button" className="primary-button" onClick={()=>setOutcomeHistory(null)}>完成</button></footer></section></div>}
    {conflictPrompt&&<div className="task-dialog-backdrop conflict-dialog-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)resolveConflictPrompt("return");}}><section className="conflict-dialog" role="alertdialog" aria-modal="true" aria-labelledby="conflict-title" aria-describedby="conflict-description"><header><div><p className="section-kicker">排期冲突</p><h2 id="conflict-title">这项安排与现有任务重叠</h2></div><button type="button" aria-label="返回调整排期" onClick={()=>resolveConflictPrompt("return")}><X/></button></header><p id="conflict-description">正式时间表不允许保留重叠任务。请返回并调整其中一项任务的时间。</p><ul aria-label="当前冲突任务">{conflictPrompt.conflicts.map(item=><li key={`${item.taskId}:${item.scheduleRevision}`}><span>{hhmm(minuteOf(item.startAt))}–{hhmm(minuteOf(item.endAt))}</span><strong>{item.title}</strong><small>{item.lifecycleStatus==="active"?"正在专注":item.lifecycleStatus==="awaiting_outcome"?"等待结果":"待办任务"}</small></li>)}</ul><footer><button type="button" className="primary-button" onClick={()=>resolveConflictPrompt("return")}>返回调整</button></footer></section></div>}
  </section>;
}
