import { useEffect, useMemo, useState } from "react";
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
  PanelRightOpen,
  Pause,
  Play,
  Send,
  Sparkles,
  Target,
  TimerReset,
  X
} from "lucide-react";

type EntryType = "task" | "idea" | "question";
type View = "today" | "focus" | "review" | "diary" | "growth";
type Satisfaction = "satisfied" | "neutral" | "dissatisfied";

type Task = {
  id: string;
  title: string;
  entryType: EntryType;
  lifecycleStatus: string;
  localDate: string | null;
  startAt: string | null;
  estimatedMinutes: number | null;
  difficulty: "low" | "medium" | "high" | null;
};

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
  if (!task.startAt) return "待定";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(task.startAt));
}

function timeFromSeconds(seconds: number): string {
  const value = Math.max(0, seconds);
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

export function App() {
  const today = useMemo(shanghaiDate, []);
  const [view, setView] = useState<View>("today");
  const [items, setItems] = useState<Task[]>([]);
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

  const tasks = items.filter((item) => item.entryType === "task");
  const inboxItems = items.filter((item) => item.entryType !== "task");
  const orderedTasks = [...tasks].sort((left, right) => (left.startAt ?? "99").localeCompare(right.startAt ?? "99"));
  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? null;
  const scheduledMinutes = tasks.reduce((total, task) => total + (task.estimatedMinutes ?? 0), 0);
  const plannedSeconds = (selectedTask?.estimatedMinutes ?? 25) * 60;
  const remainingSeconds = Math.max(0, plannedSeconds - focusSeconds);

  useEffect(() => {
    const controller = new AbortController();
    async function loadTasks() {
      try {
        const response = await fetch(`${apiBaseUrl}/api/v1/tasks?date=${today}`, { signal: controller.signal });
        if (!response.ok) throw new Error("无法读取今日任务");
        const data = await response.json() as { tasks: Task[] };
        setItems(data.tasks);
      } catch (loadError) {
        if ((loadError as Error).name !== "AbortError") {
          setError("暂时无法连接任务服务，请确认本地 API 正在运行。");
        }
      } finally {
        setLoading(false);
      }
    }
    void loadTasks();
    return () => controller.abort();
  }, [today]);

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

  async function createTask(payload: Record<string, unknown>) {
    const response = await fetch(`${apiBaseUrl}/api/v1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!response.ok) throw new Error("保存失败");
    return (await response.json() as { task: Task }).task;
  }

  async function addItem(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedTitle = title.trim();
    if (!trimmedTitle) return;
    setSaving(true);
    setError(null);
    try {
      const task = await createTask({
        title: trimmedTitle,
        entryType,
        date: today,
        ...(entryType === "task" ? { estimatedMinutes: Number(duration), difficulty: "medium" } : {})
      });
      setItems((current) => [...current, task]);
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
      const task = await createTask({
        title: aiCandidate.title,
        entryType: aiCandidate.entryType,
        ...(aiCandidate.date ? { date: aiCandidate.date } : {}),
        ...(aiCandidate.startAt ? { startAt: aiCandidate.startAt } : {}),
        ...(aiCandidate.endAt ? { endAt: aiCandidate.endAt } : {}),
        ...(aiCandidate.estimatedMinutes ? { estimatedMinutes: aiCandidate.estimatedMinutes } : {}),
        ...(aiCandidate.difficulty ? { difficulty: aiCandidate.difficulty } : {}),
        ...(aiCandidate.taskType ? { taskType: aiCandidate.taskType } : {}),
        ...(aiCandidate.requiresContinuousFocus !== null ? { requiresContinuousFocus: aiCandidate.requiresContinuousFocus } : {}),
        ...(aiCandidate.schedulePrecision ? { schedulePrecision: aiCandidate.schedulePrecision } : {}),
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

        {view === "today" && (
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
                      <article className={`timeline-row ${task.id === selectedTaskId ? "selected" : ""}`} key={task.id}>
                        <time>{displayTime(task)}</time><div className="timeline-point" aria-hidden="true" />
                        <button className="timeline-task" type="button" onClick={() => { selectTask(task.id); setView("focus"); }}>
                          <span className={`task-tone ${task.difficulty ?? "medium"}`} aria-hidden="true" />
                          <span className="task-content"><strong>{task.title}</strong><small>{task.estimatedMinutes ?? 30} 分钟 <i /> {task.difficulty ? difficultyLabels[task.difficulty] : "待定"}量</small></span>
                          <Play aria-hidden="true" />
                        </button>
                      </article>
                    ))}
                  </div>
                )}
              </section>

              <aside className="today-aside">
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

        {view === "focus" && (
          <section className="page focus-page" aria-labelledby="focus-title">
            <div className="focus-stage">
              <div className="focus-orbit orbit-one" aria-hidden="true" /><div className="focus-orbit orbit-two" aria-hidden="true" />
              <div className="focus-stage-header"><button className="back-button" type="button" onClick={() => setView("today")}><ChevronLeft aria-hidden="true" />回到时间轴</button><span>{focusRunning ? "正在专注" : focusFinished ? "本次完成" : "准备开始"}</span></div>
              <div className="focus-center">
                <p className="section-kicker">当前意图</p>
                <h1 id="focus-title">{selectedTask?.title ?? "选择一件事，留在此刻"}</h1>
                <p className="focus-meta">{selectedTask ? `${selectedTask.estimatedMinutes ?? 25} 分钟 · ${selectedTask.difficulty ? difficultyLabels[selectedTask.difficulty] : "适中"}量专注` : "从今日时间轴选择一个任务开始"}</p>
                <div className={`focus-timer ${focusRunning ? "running" : ""}`}><svg viewBox="0 0 180 180" aria-hidden="true"><circle cx="90" cy="90" r="80" /><circle className="timer-progress" cx="90" cy="90" r="80" style={{ strokeDashoffset: 503 - (503 * (plannedSeconds - remainingSeconds)) / plannedSeconds }} /></svg><strong>{selectedTask ? timeFromSeconds(remainingSeconds) : "--:--"}</strong></div>
                <div className="focus-controls">
                  <button className="round-control" type="button" aria-label="重置计时" disabled={!selectedTask} onClick={() => { setFocusRunning(false); setFocusSeconds(0); setFocusFinished(false); }}><TimerReset aria-hidden="true" /></button>
                  <button className="focus-main-action" type="button" disabled={!selectedTask} onClick={() => { if (focusFinished) { setFocusFinished(false); setFocusSeconds(0); } else { setFocusRunning((value) => !value); } }}>
                    {focusRunning ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}{focusRunning ? "暂停" : focusFinished ? "再来一次" : "开始专注"}
                  </button>
                  <button className="round-control" type="button" aria-label="结束专注" disabled={!selectedTask} onClick={() => { setFocusRunning(false); if (focusSeconds > 0) setFocusFinished(true); }}><CheckCircle2 aria-hidden="true" /></button>
                </div>
              </div>
              {focusFinished && <div className="focus-reflection"><span>这段时间感觉如何？</span><div>{(["satisfied", "neutral", "dissatisfied"] as Satisfaction[]).map((item) => <button className={satisfaction === item ? "chosen" : ""} type="button" onClick={() => setSatisfaction(item)} key={item}>{item === "satisfied" ? "顺畅" : item === "neutral" ? "平稳" : "费力"}</button>)}</div></div>}
            </div>
            <section className="focus-picker" aria-label="今日任务"><p className="section-kicker">今日可选</p><div>{orderedTasks.length === 0 ? <p>还没有任务</p> : orderedTasks.map((task) => <button className={task.id === selectedTaskId ? "selected" : ""} type="button" onClick={() => selectTask(task.id)} key={task.id}><span>{displayTime(task)}</span><strong>{task.title}</strong><small>{task.estimatedMinutes ?? 30}m</small></button>)}</div></section>
          </section>
        )}

        {view === "review" && (
          <section className="page review-page" aria-labelledby="review-title">
            <div className="review-heading"><div><p className="eyebrow">一天将要落幕</p><h1 id="review-title">把今天还给自己。</h1><p>完成与感受可以同时成立，不需要互相证明。</p></div><div className="review-count"><strong>{reviewMessages.length}</strong><span>条复盘片段</span></div></div>
            <div className="review-layout"><section className="review-checkin"><p className="section-kicker">今日回看</p><div className="review-stat-row"><span><CheckCircle2 aria-hidden="true" /> 已安排</span><strong>{tasks.length}</strong></div><div className="review-stat-row"><span><Clock3 aria-hidden="true" /> 计划时长</span><strong>{scheduledMinutes}m</strong></div><div className="review-stat-row"><span><Flame aria-hidden="true" /> 专注片段</span><strong>{focusSeconds > 0 ? 1 : 0}</strong></div><div className="garden-mini"><span className="garden-stem" /><span className="garden-leaf leaf-a" /><span className="garden-leaf leaf-b" /><span className="garden-bud" /></div></section>
              <section className="review-composer"><p className="section-kicker">留下一句话</p><h2>今天有什么值得被看见？</h2><textarea value={reviewDraft} onChange={(event) => setReviewDraft(event.target.value)} placeholder="可以写完成了什么、卡在哪里，或只是此刻的感受。" rows={6} maxLength={2000} /><div className="composer-footer"><span>{reviewDraft.length}/2000</span><button className="primary-button" type="button" onClick={addReviewMessage} disabled={!reviewDraft.trim()}><Send aria-hidden="true" />留在今天</button></div></section>
              <section className="review-stream"><p className="section-kicker">今日片段</p>{reviewMessages.length === 0 ? <div className="stream-empty"><MessageCircle aria-hidden="true" />第一句话会在这里亮起。</div> : reviewMessages.map((message, index) => <article key={`${message}-${index}`}><span>{String(index + 1).padStart(2, "0")}</span><p>{message}</p></article>)}<button className="text-button" type="button" disabled={reviewMessages.length === 0} onClick={() => setView("diary")}>去写赛博日记 <ArrowRight aria-hidden="true" /></button></section></div>
          </section>
        )}

        {view === "diary" && (
          <section className="page diary-page" aria-labelledby="diary-title">
            <div className="diary-toolbar"><button className="quiet-icon" type="button" aria-label="前一天"><ChevronLeft aria-hidden="true" /></button><div><p className="eyebrow">赛博日记</p><h1 id="diary-title">{displayDate()}</h1></div><button className="quiet-icon" type="button" aria-label="后一天"><ChevronRight aria-hidden="true" /></button></div>
            {reviewMessages.length === 0 ? <div className="diary-lock"><NotebookPen aria-hidden="true" /><h2>先留下一条复盘</h2><p>赛博日记从今天真实写下的一句话开始。</p><button className="primary-button" type="button" onClick={() => setView("review")}>去复盘 <ArrowRight aria-hidden="true" /></button></div> : <div className="diary-sheet"><header><div className="diary-mood"><span /><span /><span className="active" /><span /><span /></div><p>今天的坐标</p><strong>专注 {Math.round(focusSeconds / 60)} 分钟</strong></header>{!diaryDraft ? <div className="diary-ready"><Leaf aria-hidden="true" /><h2>今天已经有材料了。</h2><p>把复盘片段整理成一页可继续编辑的日记草稿。</p><button className="primary-button" type="button" onClick={createDiaryDraft}><Sparkles aria-hidden="true" />整理为草稿</button></div> : <><textarea className="diary-editor" value={diaryDraft} onChange={(event) => setDiaryDraft(event.target.value)} rows={11} /><footer><span>草稿</span><button className="primary-button" type="button"><Check aria-hidden="true" />保存日记</button></footer></>}</div>}
          </section>
        )}

        {view === "growth" && (
          <section className="page growth-page" aria-labelledby="growth-title"><div className="growth-heading"><div><p className="eyebrow">成长花园</p><h1 id="growth-title">每一次回到自己，都会留下生长。</h1></div><span className="growth-week">本周</span></div><div className="garden-field"><div className="field-grid" aria-hidden="true" />{["moss", "mint", "sun", "coral", "moss", "mint", "sun"].map((tone, index) => <div className={`plant plant-${index + 1} ${tone}`} key={index}><span className="plant-stem" /><i /><b /></div>)}<div className="garden-copy"><p>有效专注</p><strong>{Math.round(focusSeconds / 60)}<small>分钟</small></strong><span>从今天的第一段开始</span></div></div><div className="growth-notes"><div><Leaf aria-hidden="true" /><span>任务完成与主观感受分开记录</span></div><div><Clock3 aria-hidden="true" /><span>只有真实专注时段进入成长反馈</span></div></div></section>
        )}
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
