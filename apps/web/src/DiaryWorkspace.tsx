import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, BarChart3, CalendarDays, Check, CheckCircle2, ChevronLeft, ChevronRight, Clock3, CloudSun, Download, Leaf, MapPin, NotebookPen, Sparkles, Timer } from "lucide-react";

type Brief = { id: string; content: { title: string; reflection: string; taskSummary: string; location?: { name: string } | null; weather?: { temperatureCelsius: number; apparentTemperatureCelsius: number; weatherCode: number } | null } };
type Review = { id: string; localDate: string };
type RadarKey = "mainlineProgress" | "overallExecution" | "focusQuality" | "energyState" | "wellbeing" | "growthGain";
type RadarValues = Record<RadarKey, number | null>;
type Diary = { id: string; localDate: string; reviewSessionId: string; briefId: string; content: { title: string; body: string; radar?: RadarValues } };
type DayTask = {
  id: string;
  title: string;
  recordKind?: "formal" | "backfill";
  lifecycleStatus: string;
  scheduleKind?: "none" | "daypart" | "exact";
  startAt?: string | null;
  endAt?: string | null;
  currentOutcome?: string | null;
  focusMinutes: number;
  rawFocusMinutes: number;
  latestOutcome: string | null;
  startedWithinWindow?: boolean;
  latestSatisfaction?: "satisfied" | "neutral" | "dissatisfied" | null;
  latestFeedbackNote?: string | null;
};
type DayData = {
  tasks: DayTask[];
  plannedTasks: number; closedTasks: number; completedTasks: number; rawFocusMinutes: number; effectiveFocusMinutes: number;
  satisfaction: { satisfied: number; neutral: number; dissatisfied: number };
  radar: Array<{ key: RadarKey; label: string; value: number | null; source: "system" | "user" }>; stateTone: "quiet" | "steady" | "bright" | "strained";
  tree: { kind: string; points: number; pointsBreakdown?: { execution: number; focus: number; satisfaction: number; review: number }; growthPercent: number; quality: number };
};
type DiaryRead = { diary: Diary | null; review: Review | null; confirmedBrief: Brief | null; hasReviewMessage: boolean; dayData?: DayData };
type MonthData = { month: string; days: Array<{ localDate: string; hasDiary: boolean; hasReview: boolean; hasConfirmedBrief: boolean; taskCount: number; closedTasks: number; focusMinutes: number; tone: "quiet" | "steady" | "bright" | "strained" }> };

const API = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3000";
const todayDate = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const displayDate = (value: string) => new Intl.DateTimeFormat("zh-CN", { timeZone: "UTC", weekday: "long", year: "numeric", month: "long", day: "numeric" }).format(new Date(`${value}T12:00:00Z`));
const taskTimeFormatter = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false });
const outcomeText: Record<string, string> = { complete: "完成", partial: "部分完成", not_completed: "未完成", open: "待处理", awaiting_outcome: "待记录结果", closed: "已结束", cancelled: "已取消" };
const satisfactionText: Record<string, string> = { satisfied: "满意", neutral: "一般", dissatisfied: "不满意" };

function taskTimeRange(task: DayTask) {
  if (!task.startAt || !task.endAt) return null;
  return `${taskTimeFormatter.format(new Date(task.startAt))}–${taskTimeFormatter.format(new Date(task.endAt))}`;
}

function DiaryTaskRecords({ tasks }: { tasks: DayTask[] }) {
  if (tasks.length === 0) return <p className="diary-muted">今天还没有任务记录。</p>;
  return <div className="diary-task-list">{tasks.slice(0, 6).map((task) => {
    const factual = task.recordKind === "backfill";
    const time = taskTimeRange(task);
    const result = outcomeText[task.latestOutcome ?? (task.startedWithinWindow ? "complete" : task.lifecycleStatus)] ?? "已记录";
    const feeling = task.latestSatisfaction ? satisfactionText[task.latestSatisfaction] : null;
    return <div className={factual ? "diary-fact-record" : undefined} key={task.id}>
      <span className={`diary-task-dot ${factual ? "backfill" : task.lifecycleStatus}`} />
      <div>
        {factual && <span className="diary-fact-badge">事实记录</span>}
        <strong>{task.title}</strong>
        <small>{factual ? [time, result, feeling].filter(Boolean).join(" · ") : `${task.focusMinutes}m 有效专注 · ${result}`}</small>
        {factual && task.latestFeedbackNote && <p>{task.latestFeedbackNote}</p>}
      </div>
    </div>;
  })}</div>;
}

async function request<T>(path: string, method = "GET", body?: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${API}${path}`, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  if (!response.ok) throw new Error((await response.json().catch(() => ({})) as { error?: string }).error ?? "diary_request_failed");
  return response.json() as Promise<T>;
}

function makeDraft(brief: Brief) {
  return `${brief.content.reflection}\n\n${brief.content.taskSummary}\n\n我把这一页留给明天的自己：继续向前，但不催促。`;
}

function defaultRadar(dayData?: DayData): RadarValues {
  const values = Object.fromEntries((dayData?.radar ?? []).map((metric) => [metric.key, metric.value])) as Partial<RadarValues>;
  return {
    mainlineProgress: values.mainlineProgress ?? 0,
    overallExecution: values.overallExecution ?? 0,
    focusQuality: values.focusQuality ?? 0,
    energyState: values.energyState ?? null,
    wellbeing: values.wellbeing ?? null,
    growthGain: values.growthGain ?? null
  };
}

export function DiaryWorkspace({ onOpenReview }: { onOpenReview: () => void }) {
  const [selectedDate, setSelectedDate] = useState(todayDate);
  const [data, setData] = useState<DiaryRead | null>(null);
  const [monthData, setMonthData] = useState<MonthData | null>(null);
  const [title, setTitle] = useState(() => displayDate(todayDate()));
  const [body, setBody] = useState("");
  const [radarValues, setRadarValues] = useState<RadarValues>(() => defaultRadar());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadRequestRef = useRef(0);
  const load = useCallback(async () => {
    const requestId = ++loadRequestRef.current;
    setData(null);
    setError(null);
    const [result, month] = await Promise.all([
      request<DiaryRead>(`/api/v1/diaries/${selectedDate}`),
      request<MonthData>(`/api/v1/diaries?month=${selectedDate.slice(0, 7)}`)
    ]);
    if (requestId !== loadRequestRef.current) return;
    setData(result);
    setMonthData(month);
    if (result.diary) { setTitle(result.diary.content.title); setBody(result.diary.content.body); }
    else { setTitle(displayDate(selectedDate)); setBody(""); }
    setRadarValues(result.diary?.content.radar ?? defaultRadar(result.dayData));
  }, [selectedDate]);
  useEffect(() => {
    const pending = load();
    const requestId = loadRequestRef.current;
    void pending.catch(() => { if (requestId === loadRequestRef.current) setError("无法读取赛博日记，请确认 API 正在运行。"); });
  }, [load]);
  const ready = Boolean(data?.review && data.hasReviewMessage && data.confirmedBrief);
  function prepareDraft() {
    if (!data?.confirmedBrief) return;
    setTitle(data.diary?.content.title ?? displayDate(selectedDate));
    setBody(data.diary?.content.body ?? makeDraft(data.confirmedBrief));
  }
  async function save() {
    if (!data?.review || !data.confirmedBrief || !title.trim() || !body.trim()) return;
    setSaving(true); setError(null);
    try {
      const result = await request<{ diary: Diary }>(`/api/v1/diaries/${selectedDate}`, "PUT", { reviewSessionId: data.review.id, briefId: data.confirmedBrief.id, content: { title: title.trim(), body: body.trim(), radar: radarValues } });
      setData((current) => current ? { ...current, diary: result.diary } : current);
    } catch (requestError) {
      setError(requestError instanceof Error && requestError.message === "confirmed_brief_required" ? "请先回到复盘页确认每日简报。" : "日记没有保存，请重试。");
    } finally { setSaving(false); }
  }
  function exportText() {
    if (!data?.diary || !data.dayData) return;
    const savedRadar = data.diary.content.radar ?? defaultRadar(data.dayData);
    const radarLines = data.dayData.radar.map((metric) => `${metric.label}：${savedRadar[metric.key] ?? "未填写"}`).join("\n");
    const place = data.confirmedBrief?.content.location?.name ? `地点：${data.confirmedBrief.content.location.name}\n` : "";
    const weather = data.confirmedBrief?.content.weather ? `天气：${data.confirmedBrief.content.weather.temperatureCelsius}°C，体感 ${data.confirmedBrief.content.weather.apparentTemperatureCelsius}°C\n` : "";
    const file = new Blob([`${title}\n\n日期：${data.diary.localDate}\n${place}${weather}有效专注：${data.dayData.effectiveFocusMinutes} 分钟\n原始计时：${data.dayData.rawFocusMinutes} 分钟\n\n六维回看\n${radarLines}\n\n${body}\n`], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(file); const link = document.createElement("a");
    link.href = url; link.download = `${data.diary.localDate}-cyber-diary.txt`; link.click(); URL.revokeObjectURL(url);
  }
  function updateRadar(key: RadarKey, value: number | null) {
    setRadarValues((current) => ({ ...current, [key]: value }));
  }
  function shiftMonth(offset: number) {
    const cursor = new Date(`${selectedDate}T12:00:00Z`);
    const day = cursor.getUTCDate();
    cursor.setUTCDate(1);
    cursor.setUTCMonth(cursor.getUTCMonth() + offset);
    const lastDay = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0)).getUTCDate();
    cursor.setUTCDate(Math.min(day, lastDay));
    setSelectedDate(cursor.toISOString().slice(0, 10));
  }
  const monthOffset = monthData ? (new Date(`${monthData.month}-01T12:00:00Z`).getUTCDay() + 6) % 7 : 0;
  return <section className="page diary-page" aria-labelledby="diary-title">
    <div className="diary-toolbar">
      <button className="quiet-icon" type="button" aria-label="上个月" onClick={()=>shiftMonth(-1)}><ChevronLeft /></button>
      <div><p className="eyebrow">赛博日记</p><h1 id="diary-title">{displayDate(selectedDate)}</h1></div>
      <div className="diary-toolbar-actions"><button className="quiet-icon" type="button" aria-label="下个月" onClick={()=>shiftMonth(1)}><ChevronRight /></button><button className="quiet-icon" type="button" aria-label="导出日记" disabled={!data?.diary} onClick={exportText}><Download /></button></div>
    </div>
    {monthData && <section className="diary-month" aria-label={`${monthData.month} 日记月视图`}>
      <header><CalendarDays /><strong>{monthData.month.replace("-"," / ")}</strong><span>有记录的日子会留下颜色</span></header>
      <div className="diary-weekdays">{["一","二","三","四","五","六","日"].map(day=><span key={day}>{day}</span>)}</div>
      <div className="diary-month-grid">{Array.from({length:monthOffset},(_,index)=><span className="diary-day-empty" key={`empty-${index}`} />)}{monthData.days.map(day=><button className={`diary-day ${day.tone} ${day.hasDiary?"has-diary":""} ${day.localDate===selectedDate?"selected":""}`} type="button" aria-label={`查看 ${day.localDate} 日记`} aria-pressed={day.localDate===selectedDate} onClick={()=>setSelectedDate(day.localDate)} key={day.localDate}><strong>{Number(day.localDate.slice(8))}</strong><small>{day.focusMinutes?`${day.focusMinutes}m`:day.hasReview?"复盘":""}</small><i /></button>)}</div>
    </section>}
    {!data ? <div className="diary-lock"><NotebookPen /><h2>正在读取今天</h2></div> : !ready || !data.dayData ? <div className="diary-lock"><NotebookPen /><h2>{!data.hasReviewMessage ? "先留下一条复盘" : "先确认每日简报"}</h2><p>{!data.hasReviewMessage ? "赛博日记从今天真实写下的一句话开始。" : "确认后的简报会成为这页日记可靠的素材。"}</p><button className="primary-button" type="button" onClick={onOpenReview}>去复盘 <ArrowRight /></button></div> : <div className="diary-content">
      <section className={`diary-data-strip ${data.dayData.stateTone}`} aria-label="今日真实数据">
        <div className="diary-tree"><span className="tree-stem" style={{height:`${Math.max(34,data.dayData.tree.growthPercent * .72)}px`}} /><i /><b /></div>
        <div><p className="section-kicker">当日成长</p><strong>{data.dayData.tree.kind}</strong><span>{data.dayData.tree.points} 积分 · 质量 {data.dayData.tree.quality}%</span></div>
        <div className="diary-data-stat"><Clock3 /><strong>{data.dayData.effectiveFocusMinutes}m</strong><span>有效专注</span></div>
        <div className="diary-data-stat"><CheckCircle2 /><strong>{data.dayData.completedTasks}/{data.dayData.plannedTasks}</strong><span>正式任务完成</span></div>
        <div className="diary-data-stat"><Timer /><strong>{data.dayData.rawFocusMinutes}m</strong><span>原始计时</span></div>
      </section>
      {data.dayData.tree.pointsBreakdown && <section className="diary-points-breakdown" aria-label="当日积分来源">
        <div><span>执行进度</span><strong>{data.dayData.tree.pointsBreakdown.execution}<small>/45</small></strong></div>
        <div><span>有效专注</span><strong>{data.dayData.tree.pointsBreakdown.focus}<small>/25</small></strong></div>
        <div><span>主观感受</span><strong>{data.dayData.tree.pointsBreakdown.satisfaction}<small>/20</small></strong></div>
        <div><span>主动复盘</span><strong>{data.dayData.tree.pointsBreakdown.review}<small>/10</small></strong></div>
        <p>任务数量本身不加分；事实补录只留下当天事实，不计入积分。</p>
      </section>}
      <section className="diary-signal-grid">
        <div className="diary-signal-card">
          <div className="diary-card-heading"><BarChart3 /><div><strong>六维回看</strong><small>前三项由记录预填，六项都由你最终决定</small></div></div>
          <div className="diary-radar-editor">{data.dayData.radar.map(metric=>{const value=radarValues[metric.key];return <div className="diary-radar-row" key={metric.key}><span><span className="metric-label">{metric.label}</span><small>{metric.source==="system"?"系统预填，可调整":"由你主动填写"}</small></span>{value===null?<button className="text-button" type="button" onClick={()=>updateRadar(metric.key,50)}>填写</button>:<><input aria-label={`${metric.label}评分`} type="range" min="0" max="100" step="5" value={value} onChange={(event)=>updateRadar(metric.key,Number(event.target.value))}/><strong>{value}</strong>{metric.source==="user"&&<button className="text-button radar-clear" type="button" aria-label={`清空${metric.label}`} onClick={()=>updateRadar(metric.key,null)}>清空</button>}</>}</div>})}</div>
        </div>
        <div className="diary-signal-card"><div className="diary-card-heading"><CheckCircle2 /><strong>今天留下的任务与事实记录</strong></div><DiaryTaskRecords tasks={data.dayData.tasks} /></div>
      </section>
      {(data.confirmedBrief?.content.location||data.confirmedBrief?.content.weather) && <div className="diary-place"><MapPin /><span>{data.confirmedBrief.content.location?.name??"地点未记录"}</span>{data.confirmedBrief.content.weather&&<><CloudSun /><span>{data.confirmedBrief.content.weather.temperatureCelsius}°C · 体感 {data.confirmedBrief.content.weather.apparentTemperatureCelsius}°C</span></>}</div>}
      <div className="diary-sheet">
        <header><div className="diary-mood"><span /><span /><span className="active" /><span /><span /></div><p>{data.diary ? "已持久保存" : "今天的坐标"}</p><strong>{data.confirmedBrief?.content.title}</strong></header>
        {!body ? <div className="diary-ready"><Leaf /><h2>今天已经有材料了。</h2><p>把复盘与已确认简报整理成一页可以继续编辑的日记。</p><button className="primary-button" type="button" onClick={prepareDraft}><Sparkles />整理为草稿</button></div> : <><label className="diary-title-field"><span>标题</span><input aria-label="日记标题" value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} /></label><textarea className="diary-editor" aria-label="日记正文" value={body} onChange={(event) => setBody(event.target.value)} rows={11} maxLength={20_000} /><footer><span>{data.diary ? "已保存" : "草稿"}</span><button className="primary-button" type="button" disabled={saving || !title.trim() || !body.trim()} onClick={() => void save()}><Check />{saving ? "正在保存" : "确认并保存赛博日记"}</button></footer></>}
      </div>
    </div>}
    {error && <div className="focus-error" role="alert">{error}</div>}
  </section>;
}
