import { useMemo, useState, type FormEvent } from "react";
import { BarChart3, Bot, BrainCircuit, CalendarDays, Check, CircleHelp, Download, HardDriveDownload, HeartPulse, LoaderCircle, NotebookPen, Sparkles, Target, X } from "lucide-react";
import { DiaryWorkspace } from "./DiaryWorkspace";
import { FocusWorkspace } from "./FocusWorkspace";
import { GrowthWorkspace } from "./GrowthWorkspace";
import { HealthWorkspace } from "./HealthWorkspace";
import { ReviewWorkspace } from "./ReviewWorkspace";
import { TodayWorkspace } from "./TodayWorkspace";

type EntryType = "task" | "idea" | "question";
type ScheduleKind = "none" | "daypart" | "exact";
type Daypart = "morning" | "afternoon" | "evening";
type View = "today" | "focus" | "review" | "diary" | "growth" | "health";
type NaturalLanguageTaskCandidate = {
  title: string;
  entryType: EntryType;
  date: string | null;
  startAt: string | null;
  endAt: string | null;
  schedulePrecision: "exact" | "morning" | "afternoon" | "evening" | null;
  notes: string | null;
  missingFields: string[];
};
type CandidateDraft = {
  title: string;
  entryType: EntryType;
  scheduleKind: ScheduleKind;
  localDate: string;
  daypart: Daypart;
  start: string;
  end: string;
  notes: string;
};
type ApiErrorBody = { error?: string; conflictSetFingerprint?: string; earliestStartAt?: string };
type StandaloneBrief = {
  id: string;
  localDate: string;
  reviewSessionId: null;
  state: "confirmed";
  content: { title: string; reflection: string; taskSummary: string; sections: Array<{ title: string; body: string }> };
  sources: Array<{ label: string; url?: string }>;
  createdAt: string;
};

class ApiError extends Error {
  constructor(readonly status: number, readonly body: ApiErrorBody) {
    super(body.error ?? `HTTP ${status}`);
  }
}

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3000";
const entryLabels: Record<EntryType, string> = { task: "任务", idea: "想法", question: "问题" };
const navItems: Array<{ id: View; label: string; icon: typeof CalendarDays }> = [
  { id: "today", label: "今日", icon: CalendarDays },
  { id: "focus", label: "专注", icon: Target },
  { id: "review", label: "复盘", icon: Sparkles },
  { id: "diary", label: "日记", icon: NotebookPen },
  { id: "growth", label: "成长", icon: BarChart3 },
  { id: "health", label: "健康", icon: HeartPulse },
];

function shanghaiDate() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function displayDate() {
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", weekday: "long", month: "long", day: "numeric" }).format(new Date());
}

function isThirtyMinuteBoundary(value: string) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", minute: "2-digit" }).formatToParts(new Date(value));
  return Number(parts.find((part) => part.type === "minute")?.value ?? -1) % 30 === 0;
}

function localDateFromIso(value: string | null): string {
  if (!value) return "";
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
}

function localTimeFromIso(value: string | null): string {
  if (!value) return "";
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

function minuteFromTime(value: string): number {
  if (!/^\d{2}:\d{2}$/.test(value)) return Number.NaN;
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
}

function timeFromMinute(value: number): string {
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

function nextAvailableMinuteForToday(date: string): number {
  if (date !== shanghaiDate()) return 0;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date());
  const nowMinute = Number(parts.find((part) => part.type === "hour")?.value ?? 0) * 60
    + Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  return Math.min(24 * 60, (Math.floor(nowMinute / 30) + 1) * 30);
}

function candidateDraftFrom(candidate: NaturalLanguageTaskCandidate): CandidateDraft {
  const scheduleKind: ScheduleKind = candidate.entryType !== "task"
    ? "none"
    : candidate.schedulePrecision === "exact"
      ? "exact"
      : candidate.schedulePrecision
        ? "daypart"
        : "none";
  const daypart = candidate.schedulePrecision === "morning" || candidate.schedulePrecision === "afternoon" || candidate.schedulePrecision === "evening"
    ? candidate.schedulePrecision
    : "morning";
  return {
    title: candidate.title,
    entryType: candidate.entryType,
    scheduleKind,
    localDate: scheduleKind === "exact" ? localDateFromIso(candidate.startAt) : candidate.date ?? "",
    daypart,
    start: localTimeFromIso(candidate.startAt),
    end: localTimeFromIso(candidate.endAt),
    notes: candidate.notes ?? ""
  };
}

function candidateMissingFields(candidate: CandidateDraft): string[] {
  const missing: string[] = [];
  if (!candidate.title.trim()) missing.push("标题");
  if (candidate.entryType !== "task") return missing;
  if (candidate.scheduleKind === "daypart" && !candidate.localDate) missing.push("日期");
  if (candidate.scheduleKind === "exact") {
    if (!candidate.localDate) missing.push("日期");
    if (!candidate.start) missing.push("开始时间");
    if (!candidate.end) missing.push("结束时间");
  }
  return missing;
}

function candidateSaveLabel(candidate: CandidateDraft): string {
  return candidate.entryType === "task"
    ? "确认并保存任务"
    : candidate.entryType === "idea"
      ? "确认并保存想法"
      : "确认并保存问题";
}

function standaloneBriefText(brief: StandaloneBrief) {
  const sections = brief.content.sections.map((section) => `## ${section.title}\n${section.body}`).join("\n\n");
  const sources = brief.sources.length ? `\n来源：\n${brief.sources.map((source) => `- ${source.label}${source.url ? `：${source.url}` : ""}`).join("\n")}` : "";
  return `${brief.content.title}\n\n这是一份独立简报，不关联复盘或赛博日记。\n\n## 对话摘要\n${brief.content.reflection}\n\n## 说明\n${brief.content.taskSummary}\n\n${sections}${sources}\n`;
}

async function requestJson<T>(path: string, method: string, payload?: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method,
    headers: payload ? { "content-type": "application/json" } : undefined,
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const body = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, body as ApiErrorBody);
  return body as T;
}

async function requestWithConflictConfirmation<T>(path: string, method: string, payload: Record<string, unknown>): Promise<T> {
  let currentPayload = payload;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await requestJson<T>(path, method, currentPayload);
    } catch (requestError) {
      if (!(requestError instanceof ApiError)
        || !["task_time_conflict", "conflict_set_changed"].includes(requestError.body.error ?? "")
        || !requestError.body.conflictSetFingerprint) throw requestError;
      if (!window.confirm("该时段与现有任务重叠。是否明确保留当前全部冲突？")) throw requestError;
      currentPayload = { ...payload, conflictDecision: "keep", expectedConflictFingerprint: requestError.body.conflictSetFingerprint };
    }
  }
  throw new Error("conflict_set_kept_changing");
}

export function App() {
  const today = useMemo(shanghaiDate, []);
  const [view, setView] = useState<View>("today");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [todayRefreshToken, setTodayRefreshToken] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiInput, setAiInput] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [aiCandidate, setAiCandidate] = useState<CandidateDraft | null>(null);
  const [standaloneBriefs, setStandaloneBriefs] = useState<StandaloneBrief[]>([]);
  const [selectedStandaloneBriefId, setSelectedStandaloneBriefId] = useState<string | null>(null);
  const [standaloneLoading, setStandaloneLoading] = useState(false);
  const activeNavLabel = navItems.find((item) => item.id === view)?.label ?? "今日";
  const selectedStandaloneBrief = standaloneBriefs.find((brief) => brief.id === selectedStandaloneBriefId) ?? standaloneBriefs[0] ?? null;

  async function loadStandaloneBriefs() {
    setStandaloneLoading(true);
    try {
      const result = await requestJson<{ briefs: StandaloneBrief[] }>(`/api/v1/briefs/standalone?date=${today}`, "GET");
      setStandaloneBriefs(result.briefs);
      setSelectedStandaloneBriefId((current) => result.briefs.some((brief) => brief.id === current) ? current : (result.briefs[0]?.id ?? null));
    } catch {
      setError("无法读取今天的独立简报，请确认 API 正在运行。");
    } finally {
      setStandaloneLoading(false);
    }
  }

  function openAiDrawer() {
    setAiOpen(true);
    void loadStandaloneBriefs();
  }

  async function parseWithAi() {
    const text = aiInput.trim();
    if (!text) return;
    setAiLoading(true); setError(null);
    try {
      const result = await requestJson<{ candidate: NaturalLanguageTaskCandidate }>("/api/v1/ai/tasks/parse", "POST", { text, referenceDate: today, timeZone: "Asia/Shanghai" });
      setAiCandidate(candidateDraftFrom(result.candidate));
    } catch {
      setError("AI 暂时无法整理这条内容，原始输入仍保留在侧边层。");
    } finally {
      setAiLoading(false);
    }
  }

  async function saveAiCandidate(event: FormEvent) {
    event.preventDefault();
    if (!aiCandidate) return;
    const candidate = aiCandidate;
    const title = candidate.title.trim();
    if (!title) {
      setError("请先填写任务、想法或问题的标题。");
      return;
    }

    let taskPayload: Record<string, unknown> | null = null;
    if (candidate.entryType === "task") {
      if (candidate.scheduleKind === "daypart" && !candidate.localDate) {
        setError("时间段任务需要选择日期。");
        return;
      }
      if (candidate.scheduleKind === "exact") {
        const startMinute = minuteFromTime(candidate.start);
        const endMinute = minuteFromTime(candidate.end);
        if (!candidate.localDate || !Number.isFinite(startMinute) || !Number.isFinite(endMinute)) {
          setError("精确任务需要日期、开始时间和结束时间。");
          return;
        }
        if (startMinute % 30 !== 0 || endMinute % 30 !== 0 || endMinute - startMinute < 30) {
          setError("精确任务的起止时间必须使用 30 分钟间隔，且至少持续 30 分钟。");
          return;
        }
        const earliest = nextAvailableMinuteForToday(candidate.localDate);
        if (startMinute < earliest) {
          setError(earliest >= 24 * 60 ? "今天已经没有可用的精确时间段，请选择其他日期。" : `今天只能从 ${timeFromMinute(earliest)} 开始安排。`);
          return;
        }
        const startAt = `${candidate.localDate}T${candidate.start}:00+08:00`;
        const endAt = `${candidate.localDate}T${candidate.end}:00+08:00`;
        if (!isThirtyMinuteBoundary(startAt) || !isThirtyMinuteBoundary(endAt)) {
          setError("精确任务的起止时间必须使用 30 分钟间隔。");
          return;
        }
        taskPayload = {
          title,
          scheduleKind: "exact",
          startAt,
          endAt,
          timeZone: "Asia/Shanghai",
          ...(candidate.notes.trim() ? { notes: candidate.notes.trim() } : {})
        };
      } else if (candidate.scheduleKind === "daypart") {
        taskPayload = {
          title,
          scheduleKind: "daypart",
          localDate: candidate.localDate,
          daypart: candidate.daypart,
          timeZone: "Asia/Shanghai",
          ...(candidate.notes.trim() ? { notes: candidate.notes.trim() } : {})
        };
      } else {
        taskPayload = {
          title,
          scheduleKind: "none",
          ...(candidate.localDate ? { localDate: candidate.localDate } : {}),
          timeZone: "Asia/Shanghai",
          ...(candidate.notes.trim() ? { notes: candidate.notes.trim() } : {})
        };
      }
    }

    setSaving(true); setError(null);
    try {
      if (candidate.entryType !== "task") {
        await requestJson("/api/v1/inbox-entries", "POST", {
          entryKind: candidate.entryType,
          content: title,
          ...(candidate.notes.trim() ? { notes: candidate.notes.trim() } : {})
        });
      } else if (taskPayload) {
        await requestWithConflictConfirmation("/api/v1/tasks", "POST", taskPayload);
      }
      setAiInput(""); setAiCandidate(null); setAiOpen(false);
      setTodayRefreshToken((value) => value + 1);
    } catch (requestError) {
      if (requestError instanceof ApiError && requestError.body.error === "task_schedule_window_unavailable") {
        setError("这个精确时间段已经不可用，请调整候选排期后再确认。");
      } else {
        setError("确认保存失败，候选内容仍保留在 AI 侧边层。");
      }
    } finally {
      setSaving(false);
    }
  }

  async function generateStandaloneBrief() {
    const conversation = aiInput.trim();
    if (!conversation) return;
    setSaving(true); setError(null);
    try {
      const result = await requestJson<{ brief: StandaloneBrief }>("/api/v1/briefs/standalone", "POST", { conversation, localDate: today });
      setStandaloneBriefs((current) => [result.brief, ...current.filter((brief) => brief.id !== result.brief.id)]);
      setSelectedStandaloneBriefId(result.brief.id);
      setAiInput("");
    } catch {
      setError("独立简报没有生成，请检查网络后重试。原始内容仍保留在侧边层。");
    } finally {
      setSaving(false);
    }
  }

  function exportStandaloneBrief(brief: StandaloneBrief) {
    const file = new Blob([standaloneBriefText(brief)], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(file);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${brief.localDate}-standalone-brief.txt`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return <main className="app-shell">
    <aside className="app-rail" aria-label="主要导航">
      <button className="brand-mark" type="button" aria-label="回到今日" onClick={() => setView("today")}><BrainCircuit /></button>
      <nav className="rail-nav">{navItems.map(({ id, label, icon: Icon }) => <button className={`rail-button ${view === id ? "active" : ""}`} type="button" key={id} aria-label={label} aria-current={view === id ? "page" : undefined} onClick={() => setView(id)}><Icon /><span>{label}</span></button>)}</nav>
      <div className="rail-footer" title="只记录你主动输入的内容"><CircleHelp /></div>
    </aside>
    <section className="app-canvas">
      <header className="topbar"><div className="context-line"><span className="live-dot" />{displayDate()}<span>/</span>{activeNavLabel}</div><div className="topbar-actions"><a className="quiet-icon backup-trigger" href={`${apiBaseUrl}/api/v1/backups/export`} download aria-label="备份所有数据" title="备份所有数据"><HardDriveDownload /></a><button className="ai-trigger" type="button" onClick={openAiDrawer}><Bot /> 与 AI 一起整理</button></div></header>
      {error && <div className="error-banner" role="alert"><X />{error}<button type="button" aria-label="关闭错误提示" onClick={() => setError(null)}><X /></button></div>}
      {view === "today" && <TodayWorkspace refreshToken={todayRefreshToken} onFocus={(id) => { setSelectedTaskId(id); setView("focus"); }} />}
      {view === "focus" && <FocusWorkspace preferredTaskId={selectedTaskId} onBack={() => setView("today")} />}
      {view === "review" && <ReviewWorkspace />}
      {view === "diary" && <DiaryWorkspace onOpenReview={() => setView("review")} />}
      {view === "growth" && <GrowthWorkspace />}
      {view === "health" && <HealthWorkspace />}
    </section>
    <aside className={`ai-drawer ${aiOpen ? "open" : ""}`} aria-label="AI 助手" aria-hidden={!aiOpen}>
      <div className="drawer-header"><div><span className="bot-orb"><Bot /></span><div><p>AI 整理助手</p><strong>把一句话变得清楚</strong></div></div><button className="quiet-icon" type="button" aria-label="关闭 AI 助手" onClick={() => setAiOpen(false)}><X /></button></div>
      {!aiCandidate ? <div className="drawer-entry">
        <div className="drawer-prompt"><p>说说你想记下什么。</p><small>可以整理成任务候选；或由你明确决定，用这段话生成独立简报。</small></div>
        <textarea aria-label="AI 输入内容" value={aiInput} onChange={(event) => setAiInput(event.target.value)} placeholder="例如：明天上午九点用六十分钟学习线性代数" rows={7} maxLength={4000} />
        <div className="drawer-actions">
          <button className="primary-button full-width" type="button" disabled={aiLoading || saving || !aiInput.trim()} onClick={() => void parseWithAi()}>{aiLoading ? <LoaderCircle className="spin" /> : <Sparkles />}{aiLoading ? "正在整理" : "生成候选"}</button>
          <button className="quiet-button full-width" type="button" disabled={aiLoading || saving || !aiInput.trim()} onClick={() => void generateStandaloneBrief()}>{saving ? <LoaderCircle className="spin" /> : <NotebookPen />}{saving ? "正在生成" : "用这段话生成独立简报"}</button>
        </div>
        <p className="standalone-note">独立简报不创建复盘，也不会生成赛博日记。</p>
        <section className="standalone-briefs" aria-labelledby="standalone-briefs-title">
          <div className="standalone-briefs-heading"><div><p className="section-kicker">已保存</p><h2 id="standalone-briefs-title">今日独立简报</h2></div>{standaloneLoading && <LoaderCircle className="spin" aria-label="正在读取独立简报" />}</div>
          {standaloneBriefs.length === 0 && !standaloneLoading ? <p className="standalone-empty">还没有独立简报。它们只会在你按下生成按钮后出现。</p> : <>
            <div className="standalone-brief-list">{standaloneBriefs.map((brief) => <button key={brief.id} className={brief.id === selectedStandaloneBrief?.id ? "active" : ""} type="button" onClick={() => setSelectedStandaloneBriefId(brief.id)}><span>{new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(brief.createdAt))}</span>{brief.content.title}</button>)}</div>
            {selectedStandaloneBrief && <article className="standalone-brief-preview"><div><p>独立简报 · 已保存</p><button className="quiet-icon" type="button" aria-label="导出独立简报" onClick={() => exportStandaloneBrief(selectedStandaloneBrief)}><Download /></button></div><h3>{selectedStandaloneBrief.content.title}</h3><p>{selectedStandaloneBrief.content.reflection}</p><small>{selectedStandaloneBrief.content.taskSummary}</small></article>}
          </>}
        </section>
      </div> : <div className="candidate-view"><p className="section-kicker">待你确认</p><div className="candidate-title"><span>{entryLabels[aiCandidate.entryType]}</span><h2>逐项确认后再保存</h2><small>AI 只提供候选，任何内容都不会在此之前写入你的计划。</small></div><form className="candidate-form" onSubmit={saveAiCandidate}><label className="candidate-wide"><span>候选类型</span><select aria-label="候选类型" value={aiCandidate.entryType} onChange={(event) => setAiCandidate((current) => current ? { ...current, entryType: event.target.value as EntryType, scheduleKind: event.target.value === "task" ? current.scheduleKind : "none" } : current)}><option value="task">任务</option><option value="idea">想法</option><option value="question">问题</option></select></label><label className="candidate-wide"><span>{aiCandidate.entryType === "task" ? "任务标题" : aiCandidate.entryType === "idea" ? "想法内容" : "问题内容"}</span><input aria-label="候选标题" required maxLength={200} value={aiCandidate.title} onChange={(event) => setAiCandidate((current) => current ? { ...current, title: event.target.value } : current)} /></label>{aiCandidate.entryType === "task" && <><label><span>排期方式</span><select aria-label="候选排期方式" value={aiCandidate.scheduleKind} onChange={(event) => setAiCandidate((current) => current ? { ...current, scheduleKind: event.target.value as ScheduleKind, localDate: current.localDate || shanghaiDate() } : current)}><option value="none">未排期</option><option value="daypart">时间段</option><option value="exact">精确时间</option></select></label><label><span>日期{aiCandidate.scheduleKind === "none" ? "（可选）" : ""}</span><input aria-label="候选日期" type="date" required={aiCandidate.scheduleKind !== "none"} value={aiCandidate.localDate} onChange={(event) => setAiCandidate((current) => current ? { ...current, localDate: event.target.value } : current)} /></label>{aiCandidate.scheduleKind === "daypart" && <label className="candidate-wide"><span>时间段</span><select aria-label="候选时间段" value={aiCandidate.daypart} onChange={(event) => setAiCandidate((current) => current ? { ...current, daypart: event.target.value as Daypart } : current)}><option value="morning">上午</option><option value="afternoon">下午</option><option value="evening">晚上</option></select></label>}{aiCandidate.scheduleKind === "exact" && <><label><span>开始时间</span><input aria-label="候选开始时间" type="time" step="1800" min={aiCandidate.localDate === today ? timeFromMinute(nextAvailableMinuteForToday(aiCandidate.localDate)) : "00:00"} required value={aiCandidate.start} onChange={(event) => setAiCandidate((current) => current ? { ...current, start: event.target.value } : current)} /></label><label><span>结束时间</span><input aria-label="候选结束时间" type="time" step="1800" max="23:30" required value={aiCandidate.end} onChange={(event) => setAiCandidate((current) => current ? { ...current, end: event.target.value } : current)} /></label></>}</>}<label className="candidate-wide"><span>备注（可选）</span><textarea aria-label="候选备注" rows={3} maxLength={4000} value={aiCandidate.notes} onChange={(event) => setAiCandidate((current) => current ? { ...current, notes: event.target.value } : current)} /></label>{candidateMissingFields(aiCandidate).length > 0 && <p className="candidate-note candidate-wide">仍待补充：{candidateMissingFields(aiCandidate).join("、")}</p>}<footer className="candidate-wide"><button className="primary-button full-width" type="submit" disabled={saving}>{saving ? <LoaderCircle className="spin" /> : <Check />}{candidateSaveLabel(aiCandidate)}</button><button className="text-button centered" type="button" disabled={saving} onClick={() => setAiCandidate(null)}>返回修改原句</button></footer></form></div>}
    </aside>
    {aiOpen && <button className="drawer-scrim" type="button" aria-label="关闭 AI 助手" onClick={() => setAiOpen(false)} />}
    <nav className="mobile-nav" aria-label="移动端主要导航">{navItems.map(({ id, label, icon: Icon }) => <button className={view === id ? "active" : ""} type="button" key={id} onClick={() => setView(id)}><Icon /><span>{label}</span></button>)}</nav>
  </main>;
}
