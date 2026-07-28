import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  BarChart3,
  Bot,
  BrainCircuit,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Clock3,
  Flame,
  Leaf,
  Lightbulb,
  ListPlus,
  LoaderCircle,
  MessageCircle,
  MoreHorizontal,
  NotebookPen,
  Pencil,
  PanelRightOpen,
  Pause,
  Play,
  Send,
  Sparkles,
  Target,
  TimerReset,
  Trash2,
  Undo2,
  X
} from "lucide-react";
import { TodayWorkspace } from "./TodayWorkspace";
import { FocusWorkspace } from "./FocusWorkspace";
import { ReviewWorkspace } from "./ReviewWorkspace";
import { DiaryWorkspace } from "./DiaryWorkspace";
import { GrowthWorkspace } from "./GrowthWorkspace";

type EntryType = "task" | "idea" | "question";
type View = "today" | "focus" | "review" | "diary" | "growth";
type Satisfaction = "satisfied" | "neutral" | "dissatisfied";
type LifecycleStatus = "open" | "active" | "awaiting_outcome" | "closed" | "cancelled";
type ScheduleKind = "none" | "daypart" | "exact";
type Daypart = "morning" | "afternoon" | "evening";

type Task = {
  id: string;
  title: string;
  entryType: EntryType;
  lifecycleStatus: LifecycleStatus;
  scheduleKind: ScheduleKind;
  currentOutcome: "not_completed" | "partial" | "complete" | null;
  localDate: string | null;
  daypart: Daypart | null;
  startAt: string | null;
  endAt: string | null;
  timeZone: string;
  estimatedMinutes: number | null;
  difficulty: "low" | "medium" | "high" | null;
  notes: string | null;
  version: number;
  scheduleRevision: number;
};

type ConflictPair = { taskIdA: string; taskIdB: string; accepted: boolean };
type TaskListResponse = {
  tasks: Task[];
  blockingConflicts: ConflictPair[];
  historicalOverlaps: ConflictPair[];
};

type ApiErrorBody = {
  error?: string;
  conflictSetFingerprint?: string;
};

class ApiError extends Error {
  constructor(readonly status: number, readonly body: ApiErrorBody) {
    super(body.error ?? `HTTP ${status}`);
  }
}

type NaturalLanguageTaskCandidate = {
  title: string;
  entryType: EntryType;
  date: string | null;
  startAt: string | null;
  endAt: string | null;
  estimatedMinutes: number | null;
  difficulty: "low" | "medium" | "high" | null;
  taskType: string | null;
  requiresContinuousFocus: boolean | null;
  schedulePrecision: "exact" | "morning" | "afternoon" | "evening" | null;
  notes: string | null;
  missingFields: string[];
};

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3000";
const entryLabels: Record<EntryType, string> = {
  task: "任务",
  idea: "想法",
  question: "问题"
};
const difficultyLabels = { low: "轻", medium: "中", high: "深" };
const lifecycleLabels: Record<LifecycleStatus, string> = {
  open: "待开始",
  active: "进行中",
  awaiting_outcome: "待补结果",
  closed: "已结束",
  cancelled: "已取消"
};
const daypartLabels: Record<Daypart, string> = { morning: "上午", afternoon: "下午", evening: "晚上" };
const navItems: Array<{ id: View; label: string; icon: typeof CalendarDays }> = [
  { id: "today", label: "今日", icon: CalendarDays },
  { id: "focus", label: "专注", icon: Target },
  { id: "review", label: "复盘", icon: Sparkles },
  { id: "diary", label: "日记", icon: NotebookPen },
  { id: "growth", label: "成长", icon: BarChart3 }
];

function shanghaiDate(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function displayDate(): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    weekday: "long",
    month: "long",
    day: "numeric"
  }).format(new Date());
}

function displayTime(task: Task): string {
  if (task.scheduleKind === "daypart" && task.daypart) return daypartLabels[task.daypart];
  if (!task.startAt) return "待定";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(task.startAt));
}

function localTime(value: string | null): string {
  if (!value) return "";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(value));
}

function shanghaiIso(localDate: string, time: string): string {
  return `${localDate}T${time}:00+08:00`;
}

function timeFromSeconds(seconds: number): string {
  const value = Math.max(0, seconds);
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

export function App() {
  const today = useMemo(shanghaiDate, []);
  const [view, setView] = useState<View>("today");
  const [items, setItems] = useState<Task[]>([]);
  const [blockingConflicts, setBlockingConflicts] = useState<ConflictPair[]>([]);
  const [historicalOverlaps, setHistoricalOverlaps] = useState<ConflictPair[]>([]);
  const [entryType, setEntryType] = useState<EntryType>("task");
  const [title, setTitle] = useState("");
  const [duration, setDuration] = useState("30");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [focusRunning, setFocusRunning] = useState(false);
  const [focusSeconds, setFocusSeconds] = useState(0);
  const [focusFinished, setFocusFinished] = useState(false);
  const [satisfaction, setSatisfaction] = useState<Satisfaction | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiInput, setAiInput] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiCandidate, setAiCandidate] = useState<NaturalLanguageTaskCandidate | null>(null);
  const [reviewDraft, setReviewDraft] = useState("");
  const [reviewMessages, setReviewMessages] = useState<string[]>([]);
  const [diaryDraft, setDiaryDraft] = useState("");
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editScheduleKind, setEditScheduleKind] = useState<ScheduleKind>("none");
  const [editDate, setEditDate] = useState(today);
  const [editDaypart, setEditDaypart] = useState<Daypart>("morning");
  const [editStart, setEditStart] = useState("09:00");
  const [editEnd, setEditEnd] = useState("10:00");

  const tasks = items.filter((item) => item.entryType === "task");
  const inboxItems = items.filter((item) => item.entryType !== "task");
  const orderedTasks = [...tasks].sort((left, right) => (left.startAt ?? "99").localeCompare(right.startAt ?? "99"));
  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? null;
  const scheduledMinutes = tasks.reduce((total, task) => total + (task.estimatedMinutes ?? 0), 0);
  const plannedSeconds = (selectedTask?.estimatedMinutes ?? 25) * 60;
  const remainingSeconds = Math.max(0, plannedSeconds - focusSeconds);

  const loadTasks = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(`${apiBaseUrl}/api/v1/tasks?date=${today}`, { signal });
    if (!response.ok) throw new Error("无法读取今日任务");
    const data = await response.json() as TaskListResponse;
    setItems(data.tasks);
    setBlockingConflicts(data.blockingConflicts);
    setHistoricalOverlaps(data.historicalOverlaps);
  }, [today]);

  useEffect(() => {
    const controller = new AbortController();
    void loadTasks(controller.signal)
      .catch((loadError: Error) => {
        if (loadError.name !== "AbortError") setError("暂时无法连接任务服务，请确认本地 API 正在运行。");
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [loadTasks]);

  useEffect(() => {
    if (!focusRunning || !selectedTask) return;
    const timer = window.setInterval(() => {
      setFocusSeconds((current) => {
        if (current + 1 >= plannedSeconds) {
          window.clearInterval(timer);
          setFocusRunning(false);
          setFocusFinished(true);
          return plannedSeconds;
        }
        return current + 1;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [focusRunning, plannedSeconds, selectedTask]);

  function selectTask(taskId: string) {
    setSelectedTaskId(taskId);
    setFocusRunning(false);
    setFocusSeconds(0);
    setFocusFinished(false);
    setSatisfaction(null);
  }

  async function requestJson<T>(path: string, method: string, payload?: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${apiBaseUrl}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: payload ? JSON.stringify(payload) : undefined
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as ApiErrorBody;
      throw new ApiError(response.status, body);
    }
    return response.status === 204 ? undefined as T : await response.json() as T;
  }

  async function requestWithConflictConfirmation<T>(
    path: string,
    method: string,
    payload: Record<string, unknown>
  ): Promise<T> {
    let currentPayload = payload;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await requestJson<T>(path, method, currentPayload);
      } catch (requestError) {
        if (!(requestError instanceof ApiError)
          || !["task_time_conflict", "conflict_set_changed"].includes(requestError.body.error ?? "")
          || !requestError.body.conflictSetFingerprint) throw requestError;
        const keep = window.confirm("这个时间与现有任务重叠。数据库不会自动调整时间，是否明确保留冲突？");
        if (!keep) throw requestError;
        currentPayload = {
          ...payload,
          conflictDecision: "keep",
          expectedConflictFingerprint: requestError.body.conflictSetFingerprint
        };
      }
    }
    throw new Error("冲突集合持续变化，请刷新后重试。");
  }

  async function createTask(payload: Record<string, unknown>) {
    const result = await requestWithConflictConfirmation<{ task: Task }>("/api/v1/tasks", "POST", payload);
    return result.task;
  }

  async function addItem(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedTitle = title.trim();
    if (!trimmedTitle) return;
    setSaving(true);
    setError(null);
    try {
      if (entryType === "task") {
        const task = await createTask({
          title: trimmedTitle,
          scheduleKind: "none",
          localDate: today,
          timeZone: "Asia/Shanghai",
          plannedEffortMinutes: Number(duration),
          difficulty: "medium"
        });
        setItems((current) => [...current, task]);
      } else {
        await requestJson("/api/v1/inbox-entries", "POST", { entryKind: entryType, content: trimmedTitle });
      }
      setTitle("");
    } catch {
      setError("保存失败，内容没有丢失。请检查 API 后重试。");
    } finally {
      setSaving(false);
    }
  }

  async function parseWithAi() {
    const text = aiInput.trim();
    if (!text) return;
    setAiLoading(true);
    setError(null);
    try {
      const response = await fetch(`${apiBaseUrl}/api/v1/ai/tasks/parse`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, referenceDate: today, timeZone: "Asia/Shanghai" })
      });
      if (!response.ok) throw new Error("AI 暂时无法解析");
      const data = await response.json() as { candidate: NaturalLanguageTaskCandidate };
      setAiCandidate(data.candidate);
    } catch {
      setError("AI 暂时无法整理这条内容，原始输入仍保留在侧边层。");
    } finally {
      setAiLoading(false);
    }
  }

  async function saveAiCandidate() {
    if (!aiCandidate) return;
    setSaving(true);
    try {
      const exactSchedule = aiCandidate.entryType === "task"
        && aiCandidate.schedulePrecision === "exact"
        && aiCandidate.startAt
        && aiCandidate.endAt;
      const daypart = aiCandidate.schedulePrecision && aiCandidate.schedulePrecision !== "exact"
        ? aiCandidate.schedulePrecision
        : null;
      const task = await createTask({
        title: aiCandidate.title,
        entryType: aiCandidate.entryType,
        scheduleKind: exactSchedule ? "exact" : daypart && aiCandidate.date ? "daypart" : "none",
        ...(!exactSchedule && aiCandidate.date ? { localDate: aiCandidate.date } : {}),
        ...(exactSchedule ? { startAt: aiCandidate.startAt, endAt: aiCandidate.endAt } : {}),
        ...(daypart && aiCandidate.date ? { daypart } : {}),
        timeZone: "Asia/Shanghai",
        ...(aiCandidate.estimatedMinutes ? { estimatedMinutes: aiCandidate.estimatedMinutes } : {}),
        ...(aiCandidate.difficulty ? { difficulty: aiCandidate.difficulty } : {}),
        ...(aiCandidate.taskType ? { taskType: aiCandidate.taskType } : {}),
        ...(aiCandidate.requiresContinuousFocus !== null ? { requiresContinuousFocus: aiCandidate.requiresContinuousFocus } : {}),
        ...(aiCandidate.notes ? { notes: aiCandidate.notes } : {})
      });
      if (task.localDate === today) setItems((current) => [...current, task]);
      setAiInput("");
      setAiCandidate(null);
      setAiOpen(false);
    } catch {
      setError("确认保存失败，候选内容仍保留在 AI 侧边层。");
    } finally {
      setSaving(false);
    }
  }

  function beginEdit(task: Task) {
    setEditingTask(task);
    setEditTitle(task.title);
    setEditScheduleKind(task.scheduleKind);
    setEditDate(task.localDate ?? today);
    setEditDaypart(task.daypart ?? "morning");
    setEditStart(localTime(task.startAt) || "09:00");
    setEditEnd(localTime(task.endAt) || "10:00");
  }

  async function saveEdit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingTask || !editTitle.trim()) return;
    setSaving(true);
    setError(null);
    const schedule = editScheduleKind === "exact"
      ? {
          scheduleKind: "exact",
          localDate: null,
          daypart: null,
          startAt: shanghaiIso(editDate, editStart),
          endAt: shanghaiIso(editDate, editEnd),
          timeZone: "Asia/Shanghai"
        }
      : editScheduleKind === "daypart"
        ? { scheduleKind: "daypart", localDate: editDate, daypart: editDaypart, startAt: null, endAt: null }
        : { scheduleKind: "none", localDate: editDate || null, daypart: null, startAt: null, endAt: null };
    try {
      await requestWithConflictConfirmation(`/api/v1/tasks/${editingTask.id}`, "PATCH", {
        expectedVersion: editingTask.version,
        expectedScheduleRevision: editingTask.scheduleRevision,
        title: editTitle.trim(),
        ...schedule
      });
      setEditingTask(null);
      await loadTasks();
    } catch (saveError) {
      if (saveError instanceof ApiError && saveError.body.error === "task_version_conflict") {
        setError("任务已在别处更新，请刷新后再编辑。");
      } else if (saveError instanceof ApiError && saveError.body.error === "task_time_conflict") {
        setError("已保留原排期，没有保存这次冲突修改。");
      } else {
        setError("编辑保存失败，请检查输入后重试。");
      }
    } finally {
      setSaving(false);
    }
  }

  async function runTaskAction(task: Task, action: "cancel" | "reopen" | "delete" | "complete" | "partial") {
    setSaving(true);
    setError(null);
    try {
      if (action === "delete") {
        await requestJson(`/api/v1/tasks/${task.id}`, "DELETE", { expectedVersion: task.version });
      } else if (action === "cancel") {
        await requestJson(`/api/v1/tasks/${task.id}/cancel`, "POST", { expectedVersion: task.version });
      } else if (action === "reopen") {
        await requestWithConflictConfirmation(`/api/v1/tasks/${task.id}/reopen`, "POST", {
          expectedVersion: task.version
        });
      } else {
        const progress = action === "complete"
          ? 100
          : Number(window.prompt("请输入当前客观进度（1-99）", "50"));
        if (!Number.isInteger(progress) || progress < 1 || (action === "partial" && progress > 99)) return;
        await requestJson(`/api/v1/tasks/${task.id}/outcomes`, "POST", {
          expectedVersion: task.version,
          outcome: action === "complete" ? "complete" : "partial",
          progressPercent: progress,
          source: "app"
        });
      }
      if (selectedTaskId === task.id && (action === "delete" || action === "cancel")) setSelectedTaskId(null);
      await loadTasks();
    } catch (actionError) {
      setError(actionError instanceof ApiError && actionError.body.error === "task_version_conflict"
        ? "任务版本已变化，请刷新后重试。"
        : "操作没有完成，请稍后重试。");
    } finally {
      setSaving(false);
    }
  }

  function hasPair(taskId: string, pairs: ConflictPair[]): boolean {
    return pairs.some((pair) => pair.taskIdA === taskId || pair.taskIdB === taskId);
  }

  function addReviewMessage() {
    const message = reviewDraft.trim();
    if (!message) return;
    setReviewMessages((current) => [...current, message]);
    setReviewDraft("");
  }

  function createDiaryDraft() {
    if (reviewMessages.length === 0) return;
    const highlight = reviewMessages[reviewMessages.length - 1];
    setDiaryDraft(`夜幕降下来，今天的轨迹并没有消失。\n\n${highlight}\n\n我把这一页留给明天的自己：继续向前，但不催促。`);
  }

  const activeNavLabel = navItems.find((item) => item.id === view)?.label ?? "今日";

  return (
    <main className="app-shell">
      <aside className="app-rail" aria-label="主要导航">
        <button className="brand-mark" type="button" aria-label="回到今日" onClick={() => setView("today")}>
          <BrainCircuit aria-hidden="true" />
        </button>
        <nav className="rail-nav">
          {navItems.map(({ id, label, icon: Icon }) => (
            <button
              className={`rail-button ${view === id ? "active" : ""}`}
              type="button"
              key={id}
              aria-label={label}
              aria-current={view === id ? "page" : undefined}
              onClick={() => setView(id)}
            >
              <Icon aria-hidden="true" />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="rail-footer" title="只记录你主动输入的内容"><CircleHelp aria-hidden="true" /></div>
      </aside>

      <section className="app-canvas">
        <header className="topbar">
          <div className="context-line"><span className="live-dot" aria-hidden="true" />{displayDate()}<span>/</span>{activeNavLabel}</div>
          <div className="topbar-actions">
            <button className="quiet-icon" type="button" aria-label="更多操作"><MoreHorizontal aria-hidden="true" /></button>
            <button className="ai-trigger" type="button" onClick={() => setAiOpen(true)}>
              <Bot aria-hidden="true" /> 与 AI 一起整理
            </button>
          </div>
        </header>

        {error && <div className="error-banner" role="alert"><X aria-hidden="true" />{error}</div>}

        {view === "today" && <TodayWorkspace onFocus={(id) => { setSelectedTaskId(id); setView("focus"); }} />}
        {false && (
          <section className="page today-page" aria-labelledby="today-title">
            <div className="page-intro">
              <div>
                <p className="eyebrow">你的今日节奏</p>
                <h1 id="today-title">今天，按自己的节奏推进。</h1>
              </div>
              <div className="day-meter" aria-label={`今日已安排 ${scheduledMinutes} 分钟`}>
                <strong>{scheduledMinutes}</strong><span>分钟已安排</span>
              </div>
            </div>

            <div className="today-grid">
              <section className="timeline-area" aria-labelledby="timeline-title">
                <div className="section-heading">
                  <div><p className="section-kicker">今日时间轴</p><h2 id="timeline-title">把事情放回时间里</h2></div>
                  <button className="inline-button" type="button" onClick={() => setAiOpen(true)}><ListPlus aria-hidden="true" />添加</button>
                </div>
                {loading ? (
                  <div className="timeline-empty"><LoaderCircle className="spin" aria-hidden="true" />正在读取今天的安排</div>
                ) : orderedTasks.length === 0 ? (
                  <div className="timeline-empty empty-illustration"><Leaf aria-hidden="true" /><p>今天还留着一片空白。<br />先放进一件愿意开始的事。</p><button className="text-button" type="button" onClick={() => setAiOpen(true)}>开始安排 <ArrowRight aria-hidden="true" /></button></div>
                ) : (
                  <div className="timeline">
                    {orderedTasks.map((task) => (
                      <article className={`timeline-row ${task.id === selectedTaskId ? "selected" : ""} ${task.lifecycleStatus}`} key={task.id}>
                        <time>{displayTime(task)}</time><div className="timeline-point" aria-hidden="true" />
                        <button
                          className="timeline-task"
                          type="button"
                          disabled={task.lifecycleStatus === "closed" || task.lifecycleStatus === "cancelled"}
                          onClick={() => { selectTask(task.id); setView("focus"); }}
                        >
                          <span className={`task-tone ${task.difficulty ?? "medium"}`} aria-hidden="true" />
                          <span className="task-content">
                            <strong>{task.title}</strong>
                            <small>
                              {task.estimatedMinutes ?? 30} 分钟 <i /> {lifecycleLabels[task.lifecycleStatus]}
                              {hasPair(task.id, blockingConflicts) && <em className="conflict-label">时间冲突</em>}
                              {hasPair(task.id, historicalOverlaps) && <em className="history-label">历史重叠</em>}
                            </small>
                          </span>
                          <Play aria-hidden="true" />
                        </button>
                        <div className="task-actions" aria-label={`${task.title}的操作`}>
                          {(task.lifecycleStatus === "open" || task.lifecycleStatus === "awaiting_outcome") && <>
                            <button type="button" title="记录部分完成" aria-label="记录部分完成" disabled={saving} onClick={() => void runTaskAction(task, "partial")}><CheckCircle2 aria-hidden="true" /></button>
                            <button type="button" title="标记完成" aria-label="标记完成" disabled={saving} onClick={() => void runTaskAction(task, "complete")}><Check aria-hidden="true" /></button>
                          </>}
                          {task.lifecycleStatus === "open" && <button type="button" title="取消任务" aria-label="取消任务" disabled={saving} onClick={() => void runTaskAction(task, "cancel")}><X aria-hidden="true" /></button>}
                          {(task.lifecycleStatus === "closed" || task.lifecycleStatus === "cancelled") && <button type="button" title="重新打开" aria-label="重新打开" disabled={saving} onClick={() => void runTaskAction(task, "reopen")}><Undo2 aria-hidden="true" /></button>}
                          {task.lifecycleStatus === "open" && <button type="button" title="编辑任务" aria-label="编辑任务" disabled={saving} onClick={() => beginEdit(task)}><Pencil aria-hidden="true" /></button>}
                          {task.lifecycleStatus !== "active" && <button type="button" title="删除任务" aria-label="删除任务" disabled={saving} onClick={() => void runTaskAction(task, "delete")}><Trash2 aria-hidden="true" /></button>}
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </section>

              <aside className="today-aside">
                {editingTask && <section className="task-editor" aria-labelledby="edit-task-title">
                  <div className="section-heading compact">
                    <div><p className="section-kicker">编辑任务</p><h2 id="edit-task-title">调整这项安排</h2></div>
                    <button className="quiet-icon" type="button" aria-label="关闭编辑" onClick={() => setEditingTask(null)}><X aria-hidden="true" /></button>
                  </div>
                  <form onSubmit={saveEdit}>
                    <label><span>标题</span><input value={editTitle} onChange={(event) => setEditTitle(event.target.value)} maxLength={200} /></label>
                    <label><span>排期方式</span><select value={editScheduleKind} onChange={(event) => setEditScheduleKind(event.target.value as ScheduleKind)}><option value="none">仅指定日期</option><option value="daypart">指定时段</option><option value="exact">精确时间</option></select></label>
                    <label><span>日期</span><input type="date" value={editDate} onChange={(event) => setEditDate(event.target.value)} required={editScheduleKind !== "none"} /></label>
                    {editScheduleKind === "daypart" && <label><span>时段</span><select value={editDaypart} onChange={(event) => setEditDaypart(event.target.value as Daypart)}><option value="morning">上午</option><option value="afternoon">下午</option><option value="evening">晚上</option></select></label>}
                    {editScheduleKind === "exact" && <div className="editor-time-row"><label><span>开始</span><input type="time" value={editStart} onChange={(event) => setEditStart(event.target.value)} required /></label><label><span>结束</span><input type="time" value={editEnd} onChange={(event) => setEditEnd(event.target.value)} required /></label></div>}
                    <button className="primary-button full-width" type="submit" disabled={saving || !editTitle.trim()}>{saving ? <LoaderCircle className="spin" aria-hidden="true" /> : <Check aria-hidden="true" />}{saving ? "保存中" : "保存修改"}</button>
                  </form>
                </section>}
                <section className="quick-capture" aria-labelledby="capture-title">
                  <div className="section-heading compact"><div><p className="section-kicker">快速记录</p><h2 id="capture-title">先放进来</h2></div><Lightbulb aria-hidden="true" /></div>
                  <div className="entry-switch" aria-label="录入类型">
                    {(Object.keys(entryLabels) as EntryType[]).map((type) => <button key={type} type="button" aria-pressed={entryType === type} onClick={() => setEntryType(type)}>{entryLabels[type]}</button>)}
                  </div>
                  <form onSubmit={addItem}>
                    <label className="sr-only" htmlFor="item-title">{entryLabels[entryType]}内容</label>
                    <textarea id="item-title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder={entryType === "task" ? "例如：整理本周阅读笔记" : `写下一条${entryLabels[entryType]}`} maxLength={200} rows={3} />
                    {entryType === "task" && <label className="duration-field" htmlFor="task-duration"><span>预计时长</span><input id="task-duration" type="number" min="1" max="1440" value={duration} onChange={(event) => setDuration(event.target.value)} /><em>分钟</em></label>}
                    <button className="primary-button full-width" type="submit" disabled={saving || !title.trim()}>{saving ? <LoaderCircle className="spin" aria-hidden="true" /> : <Check aria-hidden="true" />}{saving ? "保存中" : `保存${entryLabels[entryType]}`}</button>
                  </form>
                </section>
                <section className="brief-strip"><div><span className="brief-icon"><Sparkles aria-hidden="true" /></span><p>每日复盘</p><strong>为今天留下一句话</strong></div><button className="quiet-icon" type="button" aria-label="打开复盘" onClick={() => setView("review")}><ChevronRight aria-hidden="true" /></button></section>
                {inboxItems.length > 0 && <section className="inbox-peek"><p className="section-kicker">等待整理</p>{inboxItems.slice(0, 3).map((item) => <div key={item.id}><span>{entryLabels[item.entryType]}</span>{item.title}</div>)}</section>}
              </aside>
            </div>
          </section>
        )}

        {view === "focus" && <FocusWorkspace preferredTaskId={selectedTaskId} onBack={() => setView("today")} />}

        {view === "review" && <ReviewWorkspace />}
        {false && view === "review" && (
          <section className="page review-page" aria-labelledby="review-title">
            <div className="review-heading"><div><p className="eyebrow">一天将要落幕</p><h1 id="review-title">把今天还给自己。</h1><p>完成与感受可以同时成立，不需要互相证明。</p></div><div className="review-count"><strong>{reviewMessages.length}</strong><span>条复盘片段</span></div></div>
            <div className="review-layout"><section className="review-checkin"><p className="section-kicker">今日回看</p><div className="review-stat-row"><span><CheckCircle2 aria-hidden="true" /> 已安排</span><strong>{tasks.length}</strong></div><div className="review-stat-row"><span><Clock3 aria-hidden="true" /> 计划时长</span><strong>{scheduledMinutes}m</strong></div><div className="review-stat-row"><span><Flame aria-hidden="true" /> 专注片段</span><strong>{focusSeconds > 0 ? 1 : 0}</strong></div><div className="garden-mini"><span className="garden-stem" /><span className="garden-leaf leaf-a" /><span className="garden-leaf leaf-b" /><span className="garden-bud" /></div></section>
              <section className="review-composer"><p className="section-kicker">留下一句话</p><h2>今天有什么值得被看见？</h2><textarea value={reviewDraft} onChange={(event) => setReviewDraft(event.target.value)} placeholder="可以写完成了什么、卡在哪里，或只是此刻的感受。" rows={6} maxLength={2000} /><div className="composer-footer"><span>{reviewDraft.length}/2000</span><button className="primary-button" type="button" onClick={addReviewMessage} disabled={!reviewDraft.trim()}><Send aria-hidden="true" />留在今天</button></div></section>
              <section className="review-stream"><p className="section-kicker">今日片段</p>{reviewMessages.length === 0 ? <div className="stream-empty"><MessageCircle aria-hidden="true" />第一句话会在这里亮起。</div> : reviewMessages.map((message, index) => <article key={`${message}-${index}`}><span>{String(index + 1).padStart(2, "0")}</span><p>{message}</p></article>)}<button className="text-button" type="button" disabled={reviewMessages.length === 0} onClick={() => setView("diary")}>去写赛博日记 <ArrowRight aria-hidden="true" /></button></section></div>
          </section>
        )}

        {view === "diary" && <DiaryWorkspace onOpenReview={() => setView("review")} />}

        {view === "growth" && <GrowthWorkspace />}
      </section>

      <aside className={`ai-drawer ${aiOpen ? "open" : ""}`} aria-label="AI 助手" aria-hidden={!aiOpen}>
        <div className="drawer-header"><div><span className="bot-orb"><Bot aria-hidden="true" /></span><div><p>AI 整理助手</p><strong>把一句话变得清楚</strong></div></div><button className="quiet-icon" type="button" aria-label="关闭 AI 助手" onClick={() => setAiOpen(false)}><X aria-hidden="true" /></button></div>
        {!aiCandidate ? <div className="drawer-entry"><div className="drawer-prompt"><p>说说你想记下什么。</p><small>我会整理成候选，确认后才会保存。</small></div><textarea value={aiInput} onChange={(event) => setAiInput(event.target.value)} placeholder="例如：明天上午九点用四十五分钟学习线性代数" rows={7} maxLength={4000} /><button className="primary-button full-width" type="button" disabled={aiLoading || !aiInput.trim()} onClick={parseWithAi}>{aiLoading ? <LoaderCircle className="spin" aria-hidden="true" /> : <Sparkles aria-hidden="true" />}{aiLoading ? "正在整理" : "生成候选"}</button></div> : <div className="candidate-view"><p className="section-kicker">待你确认</p><div className="candidate-title"><span>{entryLabels[aiCandidate.entryType]}</span><h2>{aiCandidate.title}</h2></div><dl><div><dt>日期</dt><dd>{aiCandidate.date ?? "尚未确定"}</dd></div><div><dt>时间</dt><dd>{aiCandidate.startAt ? new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(aiCandidate.startAt)) : "尚未确定"}</dd></div><div><dt>时长</dt><dd>{aiCandidate.estimatedMinutes ? `${aiCandidate.estimatedMinutes} 分钟` : "尚未确定"}</dd></div><div><dt>难度</dt><dd>{aiCandidate.difficulty ? `${difficultyLabels[aiCandidate.difficulty]}量` : "尚未确定"}</dd></div></dl>{aiCandidate.missingFields.length > 0 && <p className="candidate-note">仍待确定：{aiCandidate.missingFields.map((field) => ({ taskType: "类型", requiresContinuousFocus: "连续专注", notes: "备注", date: "日期", startAt: "时间", endAt: "结束时间", estimatedMinutes: "时长", difficulty: "难度" }[field] ?? field)).join("、")}</p>}<button className="primary-button full-width" type="button" disabled={saving} onClick={saveAiCandidate}><Check aria-hidden="true" />确认并保存</button><button className="text-button centered" type="button" onClick={() => setAiCandidate(null)}>返回修改原句</button></div>}
      </aside>
      {aiOpen && <button className="drawer-scrim" type="button" aria-label="关闭 AI 助手" onClick={() => setAiOpen(false)} />}
      <nav className="mobile-nav" aria-label="移动端主要导航">{navItems.slice(0, 5).map(({ id, label, icon: Icon }) => <button className={view === id ? "active" : ""} type="button" key={id} onClick={() => setView(id)}><Icon aria-hidden="true" /><span>{label}</span></button>)}</nav>
    </main>
  );
}
