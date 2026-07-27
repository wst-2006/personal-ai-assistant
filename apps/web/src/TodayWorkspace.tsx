import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CalendarPlus, Check, GripHorizontal, Lightbulb, LoaderCircle, Pencil, Sparkles, X } from "lucide-react";

type ScheduleKind = "none" | "daypart" | "exact";
type Daypart = "morning" | "afternoon" | "evening";
type Difficulty = "low" | "medium" | "high";
type Task = { id:string; title:string; lifecycleStatus:"open"|"active"|"awaiting_outcome"|"closed"|"cancelled"; scheduleKind:ScheduleKind; localDate:string|null; daypart:Daypart|null; startAt:string|null; endAt:string|null; timeZone:string; plannedEffortMinutes:number|null; difficulty:Difficulty|null; taskType:string|null; requiresContinuousFocus:boolean|null; notes:string|null; version:number; scheduleRevision:number };
type InboxEntry = { id:string; entryKind:"idea"|"question"; content:string; notes:string|null; version:number };
type Pair = { taskIdA:string; taskIdB:string; accepted:boolean };
type FormState = { title:string; scheduleKind:ScheduleKind; localDate:string; daypart:Daypart; start:string; end:string; plannedEffortMinutes:string; difficulty:Difficulty; taskType:string; requiresContinuousFocus:boolean; notes:string };
type DragState = { task:Task; mode:"move"|"resize"; startY:number; startMinute:number; endMinute:number };
type RangeState = { pointerId:number; start:number; current:number };
type Lane = { index:number; count:number };

const API = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3000";
const HOUR_PX = 72;
const DAY_PX = HOUR_PX * 24;
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone:"Asia/Shanghai", year:"numeric", month:"2-digit", day:"2-digit" }).format(new Date());
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
const snap15 = (minute:number) => Math.max(0, Math.min(1425, Math.round(minute/15)*15));
const emptyForm = (date=today(), start="09:00", end="09:30"):FormState => ({ title:"", scheduleKind:"exact", localDate:date, daypart:"morning", start, end, plannedEffortMinutes:"30", difficulty:"medium", taskType:"", requiresContinuousFocus:false, notes:"" });

function assignLanes(tasks:Task[]):Map<string,Lane> {
  const sorted = [...tasks].sort((left,right)=>minuteOf(left.startAt)-minuteOf(right.startAt) || minuteOf(left.endAt)-minuteOf(right.endAt));
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

export function TodayWorkspace({ onFocus }:{ onFocus:(id:string)=>void }) {
  const [date,setDate]=useState(today());
  const [tasks,setTasks]=useState<Task[]>([]); const [inbox,setInbox]=useState<InboxEntry[]>([]);
  const [pairs,setPairs]=useState<Pair[]>([]); const [history,setHistory]=useState<Pair[]>([]);
  const [form,setForm]=useState<FormState|null>(null); const [editing,setEditing]=useState<Task|null>(null); const [source,setSource]=useState<InboxEntry|null>(null);
  const [quickKind,setQuickKind]=useState<"task"|"idea"|"question">("task"); const [quick,setQuick]=useState(""); const [quickEffort,setQuickEffort]=useState("30");
  const [busy,setBusy]=useState(false); const [error,setError]=useState<string|null>(null); const [preview,setPreview]=useState<Record<string,{start:number;end:number}>>({});
  const [range,setRange]=useState<RangeState|null>(null);
  const scrollRef=useRef<HTMLDivElement>(null); const dragRef=useRef<DragState|null>(null); const rangeRef=useRef<RangeState|null>(null);

  const load=useCallback(async()=>{ setError(null); const [taskData,inboxData]=await Promise.all([json<{tasks:Task[];blockingConflicts:Pair[];historicalOverlaps:Pair[]}>(`/api/v1/tasks?date=${date}`),json<InboxEntry[]>("/api/v1/inbox-entries")]); setTasks(taskData.tasks); setPairs(taskData.blockingConflicts); setHistory(taskData.historicalOverlaps); setInbox(inboxData); },[date]);
  useEffect(()=>{ void load().catch(()=>setError("无法读取安排，请确认 API 正在运行。")); },[load]);
  useEffect(()=>{ const exact=tasks.filter(t=>t.scheduleKind==="exact"&&t.startAt).sort((a,b)=>minuteOf(a.startAt)-minuteOf(b.startAt)); const target=date===today()?minuteOf(new Date().toISOString()):exact.length?minuteOf(exact[0]!.startAt):480; requestAnimationFrame(()=>scrollRef.current?.scrollTo({top:Math.max(0,target/60*HOUR_PX-160)})); },[date,tasks.length]);

  const exact=useMemo(()=>tasks.filter(t=>t.scheduleKind==="exact"&&t.startAt&&t.endAt),[tasks]);
  const other=useMemo(()=>tasks.filter(t=>t.scheduleKind!=="exact"),[tasks]);
  const lanes=useMemo(()=>assignLanes(exact),[exact]);
  const conflict=(id:string)=>pairs.some(p=>p.taskIdA===id||p.taskIdB===id); const historical=(id:string)=>history.some(p=>p.taskIdA===id||p.taskIdB===id);

  async function withConflict(path:string,method:string,payload:Record<string,unknown>) { try{return await json<any>(path,method,payload);}catch(e:any){ if(e.body?.error!=="task_time_conflict"||!e.body.conflictSetFingerprint)throw e; if(!window.confirm("该时段与现有任务重叠。是否明确保留冲突？"))throw e; const decision={conflictDecision:"keep",expectedConflictFingerprint:e.body.conflictSetFingerprint};const retry=path.includes("/inbox-entries/")?{...payload,task:{...(payload.task as Record<string,unknown>),...decision}}:{...payload,...decision};return json<any>(path,method,retry); } }
  function payload(value:FormState){ const schedule=value.scheduleKind==="none"?{localDate:value.localDate||null,daypart:null,startAt:null,endAt:null}:value.scheduleKind==="daypart"?{localDate:value.localDate,daypart:value.daypart,startAt:null,endAt:null}:{localDate:null,daypart:null,startAt:iso(value.localDate,value.start),endAt:iso(value.localDate,value.end)};return { title:value.title.trim(), scheduleKind:value.scheduleKind, ...schedule, timeZone:"Asia/Shanghai", plannedEffortMinutes:value.plannedEffortMinutes?Number(value.plannedEffortMinutes):null, difficulty:value.difficulty, taskType:value.taskType.trim()||null, requiresContinuousFocus:value.requiresContinuousFocus, notes:value.notes.trim()||null }; }
  async function saveForm(e:React.FormEvent){e.preventDefault();if(!form?.title.trim())return;if(form.scheduleKind==="exact"){const start=Number(form.start.slice(0,2))*60+Number(form.start.slice(3));const end=Number(form.end.slice(0,2))*60+Number(form.end.slice(3));if(end-start<5){setError("精确任务的结束时间必须至少晚于开始时间 5 分钟。");return;}}setBusy(true);setError(null);try{const taskPayload=payload(form); if(source){await withConflict(`/api/v1/inbox-entries/${source.id}/convert-to-task`,"POST",{confirmed:true,expectedVersion:source.version,task:taskPayload});}else if(editing){await withConflict(`/api/v1/tasks/${editing.id}`,"PATCH",{expectedVersion:editing.version,expectedScheduleRevision:editing.scheduleRevision,...taskPayload});}else{await withConflict("/api/v1/tasks","POST",taskPayload);}setForm(null);setEditing(null);setSource(null);await load();}catch(err:any){setError(err.body?.error==="task_schedule_revision_conflict"?"排期已在其他位置更新，请重新打开。":"保存失败，原内容仍在表单中。");}finally{setBusy(false);}}
  async function quickSave(e:React.FormEvent){e.preventDefault();if(!quick.trim())return;setBusy(true);try{if(quickKind==="task")await json("/api/v1/tasks","POST",{title:quick.trim(),scheduleKind:"none",localDate:date,timeZone:"Asia/Shanghai",plannedEffortMinutes:Number(quickEffort)});else await json("/api/v1/inbox-entries","POST",{entryKind:quickKind,content:quick.trim()});setQuick("");await load();}catch{setError("快速记录失败，内容没有丢失。");}finally{setBusy(false);}}
  function editTask(task:Task){setEditing(task);setSource(null);setForm({title:task.title,scheduleKind:task.scheduleKind,localDate:task.localDate??date,daypart:task.daypart??"morning",start:hhmm(minuteOf(task.startAt)),end:hhmm(minuteOf(task.endAt)),plannedEffortMinutes:String(task.plannedEffortMinutes??""),difficulty:task.difficulty??"medium",taskType:task.taskType??"",requiresContinuousFocus:task.requiresContinuousFocus??false,notes:task.notes??""});}
  function beginPointer(e:React.PointerEvent,task:Task,mode:"move"|"resize"){if(task.lifecycleStatus!=="open")return;e.preventDefault();(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);dragRef.current={task,mode,startY:e.clientY,startMinute:minuteOf(task.startAt),endMinute:minuteOf(task.endAt)};}
  function movePointer(e:React.PointerEvent){const drag=dragRef.current;if(!drag)return;const delta=Math.round((e.clientY-drag.startY)/HOUR_PX*60/15)*15;const duration=drag.endMinute-drag.startMinute;const start=drag.mode==="move"?Math.max(0,Math.min(1435-duration,drag.startMinute+delta)):drag.startMinute;const end=drag.mode==="move"?start+duration:Math.max(start+5,Math.min(1435,drag.endMinute+delta));setPreview(p=>({...p,[drag.task.id]:{start,end}}));}
  async function endPointer(){const drag=dragRef.current;if(!drag)return;dragRef.current=null;const next=preview[drag.task.id];if(!next)return;try{await withConflict(`/api/v1/tasks/${drag.task.id}`,"PATCH",{expectedVersion:drag.task.version,expectedScheduleRevision:drag.task.scheduleRevision,scheduleKind:"exact",startAt:iso(date,hhmm(next.start)),endAt:iso(date,hhmm(next.end)),timeZone:"Asia/Shanghai"});await load();}catch{setError("排期修改未保存，任务已恢复到原位置。");}finally{setPreview(p=>{const n={...p};delete n[drag.task.id];return n;});}}
  function gridMinute(e:React.PointerEvent){const rect=e.currentTarget.getBoundingClientRect();return snap15((e.clientY-rect.top)/HOUR_PX*60);}
  function beginRange(e:React.PointerEvent<HTMLDivElement>){if(e.button!==0||e.target!==e.currentTarget)return;e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId);const minute=gridMinute(e);const next={pointerId:e.pointerId,start:minute,current:minute};rangeRef.current=next;setRange(next);}
  function moveRange(e:React.PointerEvent<HTMLDivElement>){const current=rangeRef.current;if(!current||current.pointerId!==e.pointerId)return;const next={...current,current:gridMinute(e)};rangeRef.current=next;setRange(next);}
  function endRange(e:React.PointerEvent<HTMLDivElement>){const current=rangeRef.current;if(!current||current.pointerId!==e.pointerId)return;rangeRef.current=null;setRange(null);const low=Math.min(current.start,current.current);const high=Math.max(current.start,current.current);const start=high-low>=15?low:Math.min(low,1395);const end=high-low>=15?Math.min(1435,high):start+30;setEditing(null);setSource(null);setForm(emptyForm(date,hhmm(start),hhmm(end)));}

  return <section className="today-workspace">
    <header className="timeline-header"><div><p className="eyebrow">TODAY / 时间坐标</p><h1>把今天放回时间里。</h1></div><div className="timeline-date"><input aria-label="时间轴日期" type="date" value={date} onChange={e=>setDate(e.target.value)}/><button className="primary-button" onClick={()=>{setEditing(null);setSource(null);setForm(emptyForm(date));}}><CalendarPlus/>完整添加</button></div></header>
    {error&&<div className="timeline-alert"><AlertTriangle/>{error}<button onClick={()=>setError(null)} aria-label="关闭"><X/></button></div>}
    <div className="today-layout"><main className="day-canvas"><div className="day-toolbar"><span>精确时间</span><small>点击或拖动空白处创建，拖动任务调整排期</small></div><div className="day-scroll" ref={scrollRef}><div className="day-grid" style={{height:DAY_PX}} onPointerDown={beginRange} onPointerMove={moveRange} onPointerUp={endRange}>
      {Array.from({length:25},(_,h)=><div className="hour-line" style={{top:h*HOUR_PX}} key={h}><time>{String(h).padStart(2,"0")}:00</time></div>)}
      {date===today()&&<div className="now-line" style={{top:minuteOf(new Date().toISOString())/60*HOUR_PX}}><span>现在</span></div>}
      {range&&<div className="range-preview" style={{top:Math.min(range.start,range.current)/60*HOUR_PX,height:Math.max(18,Math.abs(range.current-range.start)/60*HOUR_PX)}}><span>{hhmm(Math.min(range.start,range.current))}–{hhmm(Math.max(range.start,range.current))}</span></div>}
      {exact.map(task=>{const value=preview[task.id]??{start:minuteOf(task.startAt),end:minuteOf(task.endAt)};const locked=task.lifecycleStatus!=="open";const lane=lanes.get(task.id)??{index:0,count:1};const width=`calc(${100/lane.count}% - 10px)`;const left=`calc(${lane.index*100/lane.count}% + 2px)`;return <article data-task-id={task.id} className={`time-block ${task.lifecycleStatus} ${conflict(task.id)?"conflict":""} ${historical(task.id)?"historical":""}`} style={{top:value.start/60*HOUR_PX,height:Math.max(18,(value.end-value.start)/60*HOUR_PX),width,left}} key={task.id} onPointerDown={e=>beginPointer(e,task,"move")} onPointerMove={movePointer} onPointerUp={endPointer}><div className="block-copy"><time>{hhmm(value.start)}–{hhmm(value.end)}</time><strong>{task.title}</strong><small>{task.plannedEffortMinutes?`预计投入 ${task.plannedEffortMinutes} 分钟`:"未填写预计投入"}{historical(task.id)?" · 历史重叠":""}</small></div><button className="block-edit" onPointerDown={e=>e.stopPropagation()} onClick={()=>editTask(task)} aria-label="编辑任务"><Pencil/></button>{!locked&&<button className="resize-handle" aria-label="调整任务时长" onPointerDown={e=>{e.stopPropagation();beginPointer(e,task,"resize");}} onPointerMove={movePointer} onPointerUp={endPointer}><GripHorizontal/></button>}{locked&&<span className="block-lock">{task.lifecycleStatus==="closed"?"已结束":"锁定"}</span>}</article>;})}
    </div></div></main>
    <aside className="capture-panel"><section className="quick-capture"><div className="section-heading compact"><div><p className="section-kicker">快速记录</p><h2>先放进来</h2></div><Lightbulb/></div><div className="entry-switch">{(["task","idea","question"] as const).map(k=><button aria-pressed={quickKind===k} onClick={()=>setQuickKind(k)} key={k}>{k==="task"?"任务":k==="idea"?"想法":"问题"}</button>)}</div><form onSubmit={quickSave}><textarea aria-label="快速记录内容" value={quick} onChange={e=>setQuick(e.target.value)} rows={3} maxLength={200}/>{quickKind==="task"&&<label className="duration-field"><span>预计投入</span><input type="number" min="1" max="1440" value={quickEffort} onChange={e=>setQuickEffort(e.target.value)}/><em>分钟</em></label>}<button className="primary-button full-width" disabled={busy||!quick.trim()}>{busy?<LoaderCircle className="spin"/>:<Check/>}保存</button></form></section>
      <section className="loose-tasks"><p className="section-kicker">未排期与时段任务</p>{other.length===0?<small>这里很安静。</small>:other.map(t=><button key={t.id} onClick={()=>editTask(t)}><span>{t.scheduleKind==="daypart"?({morning:"上午",afternoon:"下午",evening:"晚上"}[t.daypart!]):"未排期"}</span><strong>{t.title}</strong><Pencil/></button>)}</section>
      <section className="inbox-list"><p className="section-kicker">等待整理</p>{inbox.length===0?<small>没有待整理的想法或问题。</small>:inbox.map(entry=><article key={entry.id}><span>{entry.entryKind==="idea"?"想法":"问题"}</span><p>{entry.content}</p><button onClick={()=>{setSource(entry);setEditing(null);setForm({...emptyForm(date),title:entry.content,notes:entry.notes??""});}}>转为任务</button></article>)}</section>
    </aside></div>
    {form&&<div className="task-dialog-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget){setForm(null);setEditing(null);setSource(null);}}}><section className="task-dialog" role="dialog" aria-modal="true" aria-labelledby="task-form-title"><header><div><p className="section-kicker">{source?"从收件箱建立任务":editing?"编辑任务":"完整添加"}</p><h2 id="task-form-title">让这项安排足够清楚</h2></div><button onClick={()=>setForm(null)} aria-label="关闭"><X/></button></header><form onSubmit={saveForm}><label className="field-wide"><span>任务标题</span><input autoFocus required maxLength={200} value={form.title} onChange={e=>setForm({...form,title:e.target.value})}/></label><label><span>排期方式</span><select value={form.scheduleKind} onChange={e=>setForm({...form,scheduleKind:e.target.value as ScheduleKind})}><option value="none">未排期</option><option value="daypart">时间段</option><option value="exact">精确时间</option></select></label><label><span>日期</span><input type="date" required={form.scheduleKind!=="none"} value={form.localDate} onChange={e=>setForm({...form,localDate:e.target.value})}/></label>{form.scheduleKind==="daypart"&&<label><span>时间段</span><select value={form.daypart} onChange={e=>setForm({...form,daypart:e.target.value as Daypart})}><option value="morning">上午</option><option value="afternoon">下午</option><option value="evening">晚上</option></select></label>}{form.scheduleKind==="exact"&&<><label><span>开始时间</span><input type="time" step="300" required value={form.start} onChange={e=>setForm({...form,start:e.target.value})}/></label><label><span>结束时间</span><input type="time" step="300" required value={form.end} onChange={e=>setForm({...form,end:e.target.value})}/></label></>}<label><span>预计投入（与时间块独立）</span><input type="number" min="1" max="1440" value={form.plannedEffortMinutes} onChange={e=>setForm({...form,plannedEffortMinutes:e.target.value})}/></label><label><span>难度</span><select value={form.difficulty} onChange={e=>setForm({...form,difficulty:e.target.value as Difficulty})}><option value="low">轻量</option><option value="medium">适中</option><option value="high">深度</option></select></label><label><span>任务类型</span><input maxLength={80} value={form.taskType} onChange={e=>setForm({...form,taskType:e.target.value})}/></label><label className="toggle-field"><input type="checkbox" checked={form.requiresContinuousFocus} onChange={e=>setForm({...form,requiresContinuousFocus:e.target.checked})}/><span>适合连续专注</span></label><label className="field-wide"><span>备注</span><textarea rows={3} maxLength={4000} value={form.notes} onChange={e=>setForm({...form,notes:e.target.value})}/></label><footer className="field-wide"><button type="button" className="text-button" onClick={()=>setForm(null)}>取消</button><button className="primary-button" disabled={busy}>{busy?<LoaderCircle className="spin"/>:<Sparkles/>}{source?"确认并转为任务":"保存任务"}</button></footer></form></section></div>}
  </section>;
}
