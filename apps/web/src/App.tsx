import { useMemo, useState } from "react";
import { BarChart3, Bot, BrainCircuit, CalendarDays, Check, CircleHelp, LoaderCircle, NotebookPen, Sparkles, Target, X } from "lucide-react";
import { DiaryWorkspace } from "./DiaryWorkspace";
import { FocusWorkspace } from "./FocusWorkspace";
import { GrowthWorkspace } from "./GrowthWorkspace";
import { ReviewWorkspace } from "./ReviewWorkspace";
import { TodayWorkspace } from "./TodayWorkspace";

type EntryType = "task" | "idea" | "question";
type View = "today" | "focus" | "review" | "diary" | "growth";
type NaturalLanguageTaskCandidate = {
  title: string;
  entryType: EntryType;
  date: string | null;
  startAt: string | null;
  endAt: string | null;
  plannedEffortMinutes: number | null;
  difficulty: "low" | "medium" | "high" | null;
  taskType: string | null;
  requiresContinuousFocus: boolean | null;
  schedulePrecision: "exact" | "morning" | "afternoon" | "evening" | null;
  notes: string | null;
  missingFields: string[];
};
type ApiErrorBody = { error?: string; conflictSetFingerprint?: string };

class ApiError extends Error {
  constructor(readonly status: number, readonly body: ApiErrorBody) {
    super(body.error ?? `HTTP ${status}`);
  }
}

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3000";
const entryLabels: Record<EntryType, string> = { task: "任务", idea: "想法", question: "问题" };
const difficultyLabels = { low: "轻", medium: "中", high: "深" };
const navItems: Array<{ id: View; label: string; icon: typeof CalendarDays }> = [
  { id: "today", label: "今日", icon: CalendarDays },
  { id: "focus", label: "专注", icon: Target },
  { id: "review", label: "复盘", icon: Sparkles },
  { id: "diary", label: "日记", icon: NotebookPen },
  { id: "growth", label: "成长", icon: BarChart3 },
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
  const [aiCandidate, setAiCandidate] = useState<NaturalLanguageTaskCandidate | null>(null);
  const activeNavLabel = navItems.find((item) => item.id === view)?.label ?? "今日";

  async function parseWithAi() {
    const text = aiInput.trim();
    if (!text) return;
    setAiLoading(true); setError(null);
    try {
      const result = await requestJson<{ candidate: NaturalLanguageTaskCandidate }>("/api/v1/ai/tasks/parse", "POST", { text, referenceDate: today, timeZone: "Asia/Shanghai" });
      setAiCandidate(result.candidate);
    } catch {
      setError("AI 暂时无法整理这条内容，原始输入仍保留在侧边层。");
    } finally {
      setAiLoading(false);
    }
  }

  async function saveAiCandidate() {
    if (!aiCandidate) return;
    setSaving(true); setError(null);
    try {
      if (aiCandidate.entryType !== "task") {
        await requestJson("/api/v1/inbox-entries", "POST", {
          entryKind: aiCandidate.entryType,
          content: aiCandidate.title,
          ...(aiCandidate.notes ? { notes: aiCandidate.notes } : {}),
        });
      } else {
        const exact = aiCandidate.schedulePrecision === "exact" && aiCandidate.startAt && aiCandidate.endAt;
        if (exact && (!isThirtyMinuteBoundary(aiCandidate.startAt!) || !isThirtyMinuteBoundary(aiCandidate.endAt!))) {
          setError("AI 候选的开始和结束时间必须使用 30 分钟间隔，请修改原句后重新生成。");
          return;
        }
        const daypart = aiCandidate.schedulePrecision && aiCandidate.schedulePrecision !== "exact" ? aiCandidate.schedulePrecision : null;
        await requestWithConflictConfirmation("/api/v1/tasks", "POST", {
          title: aiCandidate.title,
          scheduleKind: exact ? "exact" : daypart && aiCandidate.date ? "daypart" : "none",
          ...(!exact && aiCandidate.date ? { localDate: aiCandidate.date } : {}),
          ...(exact ? { startAt: aiCandidate.startAt, endAt: aiCandidate.endAt } : {}),
          ...(daypart && aiCandidate.date ? { daypart } : {}),
          timeZone: "Asia/Shanghai",
          ...(aiCandidate.plannedEffortMinutes ? { plannedEffortMinutes: aiCandidate.plannedEffortMinutes } : {}),
          ...(aiCandidate.difficulty ? { difficulty: aiCandidate.difficulty } : {}),
          ...(aiCandidate.taskType ? { taskType: aiCandidate.taskType } : {}),
          ...(aiCandidate.requiresContinuousFocus !== null ? { requiresContinuousFocus: aiCandidate.requiresContinuousFocus } : {}),
          ...(aiCandidate.notes ? { notes: aiCandidate.notes } : {}),
        });
      }
      setAiInput(""); setAiCandidate(null); setAiOpen(false);
      setTodayRefreshToken((value) => value + 1);
    } catch {
      setError("确认保存失败，候选内容仍保留在 AI 侧边层。");
    } finally {
      setSaving(false);
    }
  }

  return <main className="app-shell">
    <aside className="app-rail" aria-label="主要导航">
      <button className="brand-mark" type="button" aria-label="回到今日" onClick={() => setView("today")}><BrainCircuit /></button>
      <nav className="rail-nav">{navItems.map(({ id, label, icon: Icon }) => <button className={`rail-button ${view === id ? "active" : ""}`} type="button" key={id} aria-label={label} aria-current={view === id ? "page" : undefined} onClick={() => setView(id)}><Icon /><span>{label}</span></button>)}</nav>
      <div className="rail-footer" title="只记录你主动输入的内容"><CircleHelp /></div>
    </aside>
    <section className="app-canvas">
      <header className="topbar"><div className="context-line"><span className="live-dot" />{displayDate()}<span>/</span>{activeNavLabel}</div><div className="topbar-actions"><button className="ai-trigger" type="button" onClick={() => setAiOpen(true)}><Bot /> 与 AI 一起整理</button></div></header>
      {error && <div className="error-banner" role="alert"><X />{error}<button type="button" aria-label="关闭错误提示" onClick={() => setError(null)}><X /></button></div>}
      {view === "today" && <TodayWorkspace refreshToken={todayRefreshToken} onFocus={(id) => { setSelectedTaskId(id); setView("focus"); }} />}
      {view === "focus" && <FocusWorkspace preferredTaskId={selectedTaskId} onBack={() => setView("today")} />}
      {view === "review" && <ReviewWorkspace />}
      {view === "diary" && <DiaryWorkspace onOpenReview={() => setView("review")} />}
      {view === "growth" && <GrowthWorkspace />}
    </section>
    <aside className={`ai-drawer ${aiOpen ? "open" : ""}`} aria-label="AI 助手" aria-hidden={!aiOpen}>
      <div className="drawer-header"><div><span className="bot-orb"><Bot /></span><div><p>AI 整理助手</p><strong>把一句话变得清楚</strong></div></div><button className="quiet-icon" type="button" aria-label="关闭 AI 助手" onClick={() => setAiOpen(false)}><X /></button></div>
      {!aiCandidate ? <div className="drawer-entry"><div className="drawer-prompt"><p>说说你想记下什么。</p><small>我会整理成候选，确认后才会保存。</small></div><textarea value={aiInput} onChange={(event) => setAiInput(event.target.value)} placeholder="例如：明天上午九点用六十分钟学习线性代数" rows={7} maxLength={4000} /><button className="primary-button full-width" type="button" disabled={aiLoading || !aiInput.trim()} onClick={() => void parseWithAi()}>{aiLoading ? <LoaderCircle className="spin" /> : <Sparkles />}{aiLoading ? "正在整理" : "生成候选"}</button></div> : <div className="candidate-view"><p className="section-kicker">待你确认</p><div className="candidate-title"><span>{entryLabels[aiCandidate.entryType]}</span><h2>{aiCandidate.title}</h2></div><dl><div><dt>日期</dt><dd>{aiCandidate.date ?? "尚未确定"}</dd></div><div><dt>时间</dt><dd>{aiCandidate.startAt ? new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(aiCandidate.startAt)) : "尚未确定"}</dd></div><div><dt>预计投入</dt><dd>{aiCandidate.plannedEffortMinutes ? `${aiCandidate.plannedEffortMinutes} 分钟` : "尚未确定"}</dd></div><div><dt>难度</dt><dd>{aiCandidate.difficulty ? `${difficultyLabels[aiCandidate.difficulty]}量` : "尚未确定"}</dd></div></dl>{aiCandidate.missingFields.length > 0 && <p className="candidate-note">仍待确定：{aiCandidate.missingFields.map((field) => ({ taskType: "类型", requiresContinuousFocus: "连续专注", notes: "备注", date: "日期", startAt: "时间", endAt: "结束时间", plannedEffortMinutes: "预计投入", difficulty: "难度" }[field] ?? field)).join("、")}</p>}<button className="primary-button full-width" type="button" disabled={saving} onClick={() => void saveAiCandidate()}><Check />确认并保存</button><button className="text-button centered" type="button" onClick={() => setAiCandidate(null)}>返回修改原句</button></div>}
    </aside>
    {aiOpen && <button className="drawer-scrim" type="button" aria-label="关闭 AI 助手" onClick={() => setAiOpen(false)} />}
    <nav className="mobile-nav" aria-label="移动端主要导航">{navItems.map(({ id, label, icon: Icon }) => <button className={view === id ? "active" : ""} type="button" key={id} onClick={() => setView(id)}><Icon /><span>{label}</span></button>)}</nav>
  </main>;
}
