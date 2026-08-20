import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { BarChart3, Bot, CalendarDays, Check, HardDriveDownload, HeartPulse, LoaderCircle, Map, NotebookPen, RefreshCw, Send, Settings2, Sparkles, Target, X } from "lucide-react";
import { DiaryWorkspace } from "./DiaryWorkspace";
import { FocusWorkspace } from "./FocusWorkspace";
import { GrowthWorkspace } from "./GrowthWorkspace";
import { HealthWorkspace } from "./HealthWorkspace";
import { LongRangePlansWorkspace } from "./LongRangePlansWorkspace";
import { PlanChangeDrawer, type PlanChangeAdjustmentReview } from "./PlanChangeDrawer";
import { PlanShiftDrawer } from "./PlanShiftDrawer";
import { ReviewWorkspace } from "./ReviewWorkspace";
import { SettingsWorkspace } from "./SettingsWorkspace";
import { InitialInkLoadingScreen } from "./SeasonalAtmosphere";
import { TodayWorkspace, type PlanChangeTaskEditRequest } from "./TodayWorkspace";
import { loadUserProfile, type UserProfile } from "./user-profile-client";
import { extractPlanInstruction, PRODUCT_SCHEDULE_END_MINUTE, PRODUCT_SCHEDULE_START_MINUTE } from "@personal-ai/domain/task";
import { Component, type ErrorInfo, type ReactNode } from "react";

type EntryType = "task" | "idea" | "question";
type ScheduleKind = "none" | "daypart" | "exact";
type Daypart = "morning" | "afternoon" | "evening";
type View = "today" | "focus" | "review" | "diary" | "growth" | "health" | "plans" | "settings";
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
type CandidateConflictDetail = { taskId: string; title: string; startAt: string; endAt: string; lifecycleStatus: "open" | "active" | "awaiting_outcome" | "closed"; scheduleRevision: number; accepted: boolean };
type CandidateConflictPrompt = { conflicts: CandidateConflictDetail[]; fingerprint: string; resolve: (decision: "return") => void };
type ApiErrorBody = { error?: string; conflictSetFingerprint?: string; earliestStartAt?: string; conflicts?: CandidateConflictDetail[] };
type Conversation = {
  id: string;
  localDate: string;
  createdAt: string;
  updatedAt: string;
};

class WorkspaceErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo) {
    // Keep a render failure recoverable instead of replacing the whole desktop shell with a blank page.
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    return <section className="workspace-render-error" role="alert"><strong>这一页暂时无法显示</strong><p>任务数据没有被删除。可以先回到今日页，或重新打开这一页。</p><div><button type="button" onClick={() => this.setState({ hasError: false })}>重试</button><button type="button" onClick={() => window.location.reload()}>重新加载软件</button></div></section>;
  }
}
type ConversationMessage = {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
};
type ConversationResponse = {
  conversation: Conversation;
  messages: ConversationMessage[];
};
type PlanChangeContext = { taskId: string; taskTitle: string };
type DesktopCommand = { id: string; kind: "open_task"; taskId: string; expiresAt: string };
type HealthTaskDraft = { requestId: string; title: string; localDate: string; notes: string };
type ViewDirection = "forward" | "backward";
const PAPER_CHANGE_DURATION_MS = 1_220;
type WorkspaceLayer = {
  view: View;
  role: "current" | "primed" | "priming-outgoing" | "incoming" | "outgoing";
  direction: ViewDirection | null;
  transitionId: number;
  scrollOffset: number;
};

class ApiError extends Error {
  constructor(readonly status: number, readonly body: ApiErrorBody) {
    super(body.error ?? `HTTP ${status}`);
  }
}
class CandidateConflictCancelledError extends Error {}

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3000";
const entryLabels: Record<EntryType, string> = { task: "任务", idea: "想法", question: "问题" };
const navItems: Array<{ id: View; label: string; icon: typeof CalendarDays }> = [
  { id: "today", label: "今日", icon: CalendarDays },
  { id: "focus", label: "专注", icon: Target },
  { id: "review", label: "复盘", icon: Sparkles },
  { id: "diary", label: "日记", icon: NotebookPen },
  { id: "growth", label: "成长", icon: BarChart3 },
  { id: "plans", label: "规划", icon: Map },
  { id: "health", label: "健康", icon: HeartPulse },
];
const viewOrder: View[] = [...navItems.map((item) => item.id), "settings"];

function isDesktopRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function desktopCommandClientId() {
  const storageKey = "personal-ai.desktop-command-client-id";
  const existing = window.localStorage.getItem(storageKey);
  if (existing) return existing;
  const created = `desktop-${crypto.randomUUID()}`;
  window.localStorage.setItem(storageKey, created);
  return created;
}

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
  if (date !== shanghaiDate()) return PRODUCT_SCHEDULE_START_MINUTE;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date());
  const nowMinute = Number(parts.find((part) => part.type === "hour")?.value ?? 0) * 60
    + Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  return Math.max(PRODUCT_SCHEDULE_START_MINUTE, Math.min(PRODUCT_SCHEDULE_END_MINUTE, (Math.floor(nowMinute / 30) + 1) * 30));
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

async function requestWithConflictConfirmation<T>(path: string, method: string, payload: Record<string, unknown>, decide: (conflicts: CandidateConflictDetail[], fingerprint: string) => Promise<"return">): Promise<T> {
  try {
    return await requestJson<T>(path, method, payload);
  } catch (requestError) {
    if (!(requestError instanceof ApiError)
      || !["task_time_conflict", "conflict_set_changed"].includes(requestError.body.error ?? "")
      || !requestError.body.conflictSetFingerprint) throw requestError;
    await decide(requestError.body.conflicts ?? [], requestError.body.conflictSetFingerprint);
    throw new CandidateConflictCancelledError();
  }
}

export function App() {
  const today = useMemo(shanghaiDate, []);
  const [view, setView] = useState<View>("today");
  const [workspaceLayers, setWorkspaceLayers] = useState<WorkspaceLayer[]>([
    { view: "today", role: "current", direction: null, transitionId: 0, scrollOffset: 0 },
  ]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [todayRefreshToken, setTodayRefreshToken] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiInput, setAiInput] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiParseError, setAiParseError] = useState<string | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [saving, setSaving] = useState(false);
  const [aiCandidate, setAiCandidate] = useState<CandidateDraft | null>(null);
  const [candidateConflictPrompt, setCandidateConflictPrompt] = useState<CandidateConflictPrompt | null>(null);
  const [planChange, setPlanChange] = useState<PlanChangeContext | null>(null);
  const [planShiftText, setPlanShiftText] = useState<string | null>(null);
  const [planChangeTaskEditRequest, setPlanChangeTaskEditRequest] = useState<PlanChangeTaskEditRequest | null>(null);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [conversationMessages, setConversationMessages] = useState<ConversationMessage[]>([]);
  const [conversationLoading, setConversationLoading] = useState(false);
  const [conversationSending, setConversationSending] = useState(false);
  const [pendingDesktopCommand, setPendingDesktopCommand] = useState<DesktopCommand | null>(null);
  const [desktopTaskReadyId, setDesktopTaskReadyId] = useState<string | null>(null);
  const [healthTaskDraft, setHealthTaskDraft] = useState<HealthTaskDraft | null>(null);
  const desktopCommandInFlight = useRef(false);
  const activeViewRef = useRef<View>("today");
  const viewNavigationRequestRef = useRef(0);
  const viewTransitionTimerRef = useRef<number | null>(null);
  const viewTransitionFrameRef = useRef<number | null>(null);
  const viewTransitionStartFrameRef = useRef<number | null>(null);
  const visibleNavItems = useMemo(() => navItems.filter((item) => item.id !== "health" || userProfile?.healthPageEnabled !== false), [userProfile?.healthPageEnabled]);
  const activeNavLabel = view === "settings" ? "设置" : navItems.find((item) => item.id === view)?.label ?? "今日";
  const activeNavIndex = visibleNavItems.findIndex((item) => item.id === view);

  const navigateToView = useCallback((nextView: View) => {
    const currentView = activeViewRef.current;
    if (nextView === currentView) return;

    const requestId = ++viewNavigationRequestRef.current;
    if (viewTransitionTimerRef.current !== null) window.clearTimeout(viewTransitionTimerRef.current);
    if (viewTransitionFrameRef.current !== null) window.cancelAnimationFrame(viewTransitionFrameRef.current);
    if (viewTransitionStartFrameRef.current !== null) window.cancelAnimationFrame(viewTransitionStartFrameRef.current);

    const currentIndex = Math.max(0, viewOrder.indexOf(currentView));
    const nextIndex = Math.max(0, viewOrder.indexOf(nextView));
    const direction: ViewDirection = nextIndex > currentIndex ? "forward" : "backward";
    const scrollOffset = window.scrollY;
    document.documentElement.dataset.viewDirection = direction;
    activeViewRef.current = nextView;
    setView(nextView);
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setWorkspaceLayers([{ view: nextView, role: "current", direction: null, transitionId: requestId, scrollOffset: 0 }]);
      return;
    }

    setWorkspaceLayers((current) => {
      const outgoing = current.find((layer) => layer.view === currentView);
      const incoming = current.find((layer) => layer.view === nextView);
      return [
        {
          view: currentView,
          role: "priming-outgoing",
          direction,
          transitionId: requestId,
          scrollOffset: outgoing?.role === "current" ? scrollOffset : outgoing?.scrollOffset ?? scrollOffset,
        },
        {
          view: nextView,
          role: "primed",
          direction,
          transitionId: requestId,
          scrollOffset: incoming?.role === "current" ? incoming.scrollOffset : 0,
        },
      ];
    });

    // First mount the next real workspace underneath the current sheet. The
    // second frame starts the lift, guaranteeing that both DOM trees existed
    // before the diagonal paper ridge begins to travel.
    viewTransitionFrameRef.current = window.requestAnimationFrame(() => {
      viewTransitionStartFrameRef.current = window.requestAnimationFrame(() => {
        if (requestId !== viewNavigationRequestRef.current) return;
        setWorkspaceLayers((current) => current.map((layer) => ({
          ...layer,
          role: layer.view === currentView ? "outgoing" : "incoming",
        })));
        viewTransitionFrameRef.current = null;
        viewTransitionStartFrameRef.current = null;
        viewTransitionTimerRef.current = window.setTimeout(() => {
          if (requestId !== viewNavigationRequestRef.current) return;
          setWorkspaceLayers([{ view: nextView, role: "current", direction: null, transitionId: requestId, scrollOffset: 0 }]);
          viewTransitionTimerRef.current = null;
        }, PAPER_CHANGE_DURATION_MS);
      });
    });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadUserProfile(controller.signal).then(setUserProfile).catch(() => undefined);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (userProfile?.healthPageEnabled === false && view === "health") navigateToView("today");
  }, [navigateToView, userProfile?.healthPageEnabled, view]);

  const handleProfileSaved = useCallback((profile: UserProfile) => {
    setUserProfile(profile);
  }, []);

  useEffect(() => () => {
    viewNavigationRequestRef.current += 1;
    if (viewTransitionTimerRef.current !== null) window.clearTimeout(viewTransitionTimerRef.current);
    if (viewTransitionFrameRef.current !== null) window.cancelAnimationFrame(viewTransitionFrameRef.current);
    if (viewTransitionStartFrameRef.current !== null) window.cancelAnimationFrame(viewTransitionStartFrameRef.current);
  }, []);

  useEffect(() => {
    const reflectVisibility = () => {
      document.documentElement.dataset.documentHidden = document.hidden ? "true" : "false";
    };
    reflectVisibility();
    document.addEventListener("visibilitychange", reflectVisibility);
    return () => {
      document.removeEventListener("visibilitychange", reflectVisibility);
      delete document.documentElement.dataset.documentHidden;
    };
  }, []);

  useEffect(() => {
    if (!isDesktopRuntime() || pendingDesktopCommand) return;
    const clientId = desktopCommandClientId();
    let stopped = false;

    async function pollDesktopCommand() {
      if (stopped || desktopCommandInFlight.current) return;
      desktopCommandInFlight.current = true;
      try {
        const result = await requestJson<{ command: DesktopCommand | null }>(`/api/v1/desktop-commands/pending?clientId=${encodeURIComponent(clientId)}`, "GET");
        if (!result.command || stopped) return;
        setAiOpen(false);
        setPlanChange(null);
        setDesktopTaskReadyId(null);
        setPendingDesktopCommand(result.command);
        setSelectedTaskId(result.command.taskId);
        navigateToView("focus");
      } catch {
        // The desktop API may still be starting. The next bounded poll retries
        // without turning a transient integration issue into a blocking banner.
      } finally {
        desktopCommandInFlight.current = false;
      }
    }

    void pollDesktopCommand();
    const timer = window.setInterval(() => void pollDesktopCommand(), 1_500);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [navigateToView, pendingDesktopCommand]);

  useEffect(() => {
    if (!isDesktopRuntime() || !pendingDesktopCommand || desktopTaskReadyId !== pendingDesktopCommand.taskId) return;
    const command = pendingDesktopCommand;
    const clientId = desktopCommandClientId();
    let stopped = false;
    let retryTimer: number | undefined;

    async function completeWhenReady() {
      if (stopped) return;
      if (Date.now() >= new Date(command.expiresAt).getTime()) {
        setPendingDesktopCommand(null);
        setDesktopTaskReadyId(null);
        return;
      }
      try {
        await requestJson(`/api/v1/desktop-commands/${command.id}/complete`, "POST", { clientId });
        if (!stopped) {
          setPendingDesktopCommand(null);
          setDesktopTaskReadyId(null);
        }
      } catch {
        if (!stopped) retryTimer = window.setTimeout(() => void completeWhenReady(), 1_500);
      }
    }

    void completeWhenReady();
    return () => {
      stopped = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [desktopTaskReadyId, pendingDesktopCommand]);

  const handleDesktopTaskReady = useCallback((taskId: string) => {
    setDesktopTaskReadyId(taskId);
  }, []);

  async function loadConversation() {
    setConversationLoading(true);
    try {
      const result = await requestJson<ConversationResponse>(`/api/v1/conversations/${today}`, "GET");
      setConversation(result.conversation);
      setConversationMessages(result.messages);
    } catch {
      setError("无法读取今天的软件内对话，请确认 API 正在运行。");
    } finally {
      setConversationLoading(false);
    }
  }

  function openAiDrawer() {
    setPlanChange(null);
    setPlanShiftText(null);
    setAiOpen(true);
    void loadConversation();
  }

  function openHealthQuestion(prompt: string) {
    setAiCandidate(null);
    setAiParseError(null);
    setPlanChange(null);
    setPlanShiftText(null);
    setAiInput(prompt);
    setAiOpen(true);
    void loadConversation();
  }

  function openHealthTaskDraft(draft: Omit<HealthTaskDraft, "requestId">) {
    setHealthTaskDraft({ ...draft, requestId: crypto.randomUUID() });
    navigateToView("today");
  }

  function closeAiDrawer() {
    setAiOpen(false);
    setPlanChange(null);
    setPlanShiftText(null);
  }

  function openPlanChange(task: { id: string; title: string }) {
    setAiCandidate(null);
    setPlanShiftText(null);
    setPlanChange({ taskId: task.id, taskTitle: task.title });
    setAiOpen(true);
  }

  function returnToTimelineFromPlanChange() {
    setAiOpen(false);
    setPlanChange(null);
    setSelectedTaskId(null);
    navigateToView("today");
    setTodayRefreshToken((value) => value + 1);
  }

  function reviewPlanChangeAdjustment(adjustment: PlanChangeAdjustmentReview) {
    setPlanChangeTaskEditRequest({
      requestId: crypto.randomUUID(),
      taskId: adjustment.taskId,
      expectedVersion: adjustment.expectedVersion,
      expectedScheduleRevision: adjustment.expectedScheduleRevision,
      scheduleKind: adjustment.scheduleKind,
      localDate: adjustment.localDate,
      daypart: adjustment.daypart,
      startAt: adjustment.startAt,
      endAt: adjustment.endAt,
      timeZone: adjustment.timeZone,
      reason: adjustment.reason
    });
    setAiOpen(false);
    setPlanChange(null);
    setSelectedTaskId(null);
    navigateToView("today");
    setTodayRefreshToken((value) => value + 1);
  }

  function requestCandidateConflictDecision(conflicts: CandidateConflictDetail[], fingerprint: string): Promise<"return"> {
    return new Promise((resolve) => setCandidateConflictPrompt({ conflicts, fingerprint, resolve }));
  }

  function resolveCandidateConflictPrompt(decision: "return") {
    const prompt = candidateConflictPrompt;
    setCandidateConflictPrompt(null);
    prompt?.resolve(decision);
  }

  async function parseWithAi() {
    const text = aiInput.trim();
    if (!text) return;
    if (extractPlanInstruction(text) !== null) {
      setAiLoading(false);
      setAiCandidate(null);
      setAiParseError(null);
      setPlanChange(null);
      setPlanShiftText(text);
      return;
    }
    setAiLoading(true); setError(null); setAiParseError(null);
    try {
      const result = await requestJson<{ candidate: NaturalLanguageTaskCandidate }>("/api/v1/ai/tasks/parse", "POST", { text, referenceDate: today, timeZone: "Asia/Shanghai" });
      setAiCandidate(candidateDraftFrom(result.candidate));
    } catch {
      setAiParseError("AI 暂时无法整理这条内容。原始输入仍保留，且没有创建任务、想法或问题；你可以直接重新整理。");
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
        if (startMinute < PRODUCT_SCHEDULE_START_MINUTE || endMinute > PRODUCT_SCHEDULE_END_MINUTE) {
          setError("精确任务只能安排在 07:00–23:00 之间。");
          return;
        }
        const earliest = nextAvailableMinuteForToday(candidate.localDate);
        if (candidate.localDate === shanghaiDate() && startMinute < earliest) {
          setError(earliest >= PRODUCT_SCHEDULE_END_MINUTE ? "今天已经没有可用的精确时间段，请选择其他日期。" : `今天只能从 ${timeFromMinute(earliest)} 开始安排。`);
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
        await requestWithConflictConfirmation("/api/v1/tasks", "POST", taskPayload, requestCandidateConflictDecision);
      }
      setAiInput(""); setAiCandidate(null); setAiParseError(null); setAiOpen(false);
      setTodayRefreshToken((value) => value + 1);
    } catch (requestError) {
      if (requestError instanceof CandidateConflictCancelledError) {
        return;
      } else if (requestError instanceof ApiError && requestError.body.error === "task_schedule_window_unavailable") {
        setError("这个精确时间段已经不可用，请调整候选排期后再确认。");
      } else {
        setError("确认保存失败，候选内容仍保留在 AI 侧边层。");
      }
    } finally {
      setSaving(false);
    }
  }

  async function sendConversationMessage() {
    const content = aiInput.trim();
    if (!conversation || !content) return;
    if (extractPlanInstruction(content) !== null) {
      setAiCandidate(null);
      setAiParseError(null);
      setPlanChange(null);
      setPlanShiftText(content);
      return;
    }
    setConversationSending(true);
    setError(null);
    try {
      const result = await requestJson<ConversationResponse>(`/api/v1/conversations/${conversation.id}/messages`, "POST", { content });
      setConversation(result.conversation);
      setConversationMessages(result.messages);
      setAiInput("");
    } catch (requestError) {
      await loadConversation();
      if (requestError instanceof ApiError && requestError.body.error === "ai_conversation_unavailable") {
        setError("原话已保存在今天的软件内对话中，AI 暂时未回复；可以稍后重试。");
      } else {
        setError("发送失败，已重新读取今天的软件内对话。");
      }
    } finally {
      setConversationSending(false);
    }
  }

  async function retryConversationReply() {
    if (!conversation) return;
    setConversationSending(true);
    setError(null);
    try {
      const result = await requestJson<ConversationResponse>(`/api/v1/conversations/${conversation.id}/reply-last`, "POST");
      setConversation(result.conversation);
      setConversationMessages(result.messages);
    } catch {
      await loadConversation();
      setError("原话仍保留在今天的软件内对话中，AI 暂时未回复；请稍后重试。");
    } finally {
      setConversationSending(false);
    }
  }

  function renderWorkspace(layerView: View, layerRole: WorkspaceLayer["role"]) {
    if (layerView === "today") return <TodayWorkspace
      refreshToken={todayRefreshToken}
      healthTaskDraft={healthTaskDraft}
      onHealthTaskDraftConsumed={() => setHealthTaskDraft(null)}
      planChangeTaskEditRequest={planChangeTaskEditRequest}
      onPlanChangeTaskEditRequestConsumed={() => setPlanChangeTaskEditRequest(null)}
      onOpenHealth={() => navigateToView("health")}
      onFocus={(id) => { setSelectedTaskId(id); navigateToView("focus"); }}
    />;
    if (layerView === "focus") return <FocusWorkspace isWorkspaceCurrent={layerRole === "current"} preferredTaskId={selectedTaskId} onBack={() => navigateToView("today")} onPlanChange={openPlanChange} onPreferredTaskReady={handleDesktopTaskReady} />;
    if (layerView === "review") return <ReviewWorkspace isWorkspaceCurrent={layerRole === "current"} />;
    if (layerView === "diary") return <DiaryWorkspace onOpenReview={() => navigateToView("review")} />;
    if (layerView === "growth") return <GrowthWorkspace />;
    if (layerView === "plans") return <LongRangePlansWorkspace />;
    if (layerView === "health") return <HealthWorkspace onAskHealth={openHealthQuestion} onCreateTask={openHealthTaskDraft} />;
    return <SettingsWorkspace onProfileSaved={handleProfileSaved} />;
  }

  return <main className="app-shell">
    <InitialInkLoadingScreen />
    <aside className="app-rail" aria-label="主要导航">
      <button className="brand-mark" type="button" aria-label="回到今日" onClick={() => navigateToView("today")}><span aria-hidden="true">序</span></button>
      <nav className="rail-nav"><span className="rail-ink-cursor" aria-hidden="true" data-hidden={activeNavIndex < 0 ? "true" : undefined} style={{ "--nav-index": Math.max(0, activeNavIndex) } as CSSProperties} />{visibleNavItems.map(({ id, label, icon: Icon }, index) => <button className={`rail-button ${view === id ? "active" : ""}`} type="button" key={id} data-index={String(index + 1).padStart(2, "0")} aria-label={label} aria-current={view === id ? "page" : undefined} onClick={() => navigateToView(id)}><Icon /><span>{label}</span></button>)}</nav>
      <button className={`rail-settings-button ${view === "settings" ? "active" : ""}`} type="button" aria-label="设置" aria-current={view === "settings" ? "page" : undefined} onClick={() => navigateToView("settings")}><Settings2 /><span>设置</span></button>
    </aside>
    <section className="app-canvas">
      <header className="topbar"><div className="context-line"><span className="live-dot" />{displayDate()}<span>/</span>{activeNavLabel}</div><div className="topbar-actions"><button className="quiet-icon mobile-settings-shortcut" type="button" aria-label="设置" title="设置" onClick={() => navigateToView("settings")}><Settings2 /></button><a className="quiet-icon backup-trigger" href={`${apiBaseUrl}/api/v1/backups/export`} download aria-label="备份所有数据" title="备份所有数据"><HardDriveDownload /></a><button className="ai-trigger" type="button" onClick={openAiDrawer}><Bot /> 与 AI 一起整理</button></div></header>
      {error && <div className="error-banner" role="alert"><X />{error}<button type="button" aria-label="关闭错误提示" onClick={() => setError(null)}><X /></button></div>}
      <div className={`view-transition-stage ${workspaceLayers.length > 1 ? "changing-sheet" : ""}`} data-view={view} aria-live="polite">
        {workspaceLayers.map((layer) => {
          const layerIsInteractive = layer.role === "current";
          const inertAttributes = layerIsInteractive ? {} : ({ inert: "" } as Record<string, string>);
          return <div
            {...inertAttributes}
            className={`workspace-layer ${layer.role}`}
            data-layer-view={layer.view}
            data-direction={layer.direction ?? undefined}
            aria-hidden={!layerIsInteractive ? "true" : undefined}
            key={layer.view}
            style={{ "--sheet-scroll-offset": `${layer.scrollOffset}px` } as CSSProperties}
          >
            <WorkspaceErrorBoundary>{renderWorkspace(layer.view, layer.role)}</WorkspaceErrorBoundary>
          </div>;
        })}
        {workspaceLayers.some((layer) => layer.role === "outgoing") && <span className="paper-change-ridge" aria-hidden="true" data-direction={workspaceLayers[0]?.direction ?? "forward"} />}
      </div>
    </section>
    <aside className={`ai-drawer ${aiOpen ? "open" : ""}`} aria-label={planChange ? "计划变更协商" : "AI 助手"} aria-hidden={!aiOpen}>
      <div className="drawer-header"><div><span className="bot-orb"><Bot /></span><div><p>{planChange ? "计划变更协商" : "AI 整理助手"}</p><strong>{planChange ? "建议可见，决定仍在你手上" : "把一句话变得清楚"}</strong></div></div><button className="quiet-icon" type="button" aria-label="关闭 AI 助手" onClick={closeAiDrawer}><X /></button></div>
      {planChange ? <PlanChangeDrawer taskId={planChange.taskId} taskTitle={planChange.taskTitle} onReviewAdjustment={reviewPlanChangeAdjustment} onBackToTimeline={returnToTimelineFromPlanChange} /> : planShiftText ? <PlanShiftDrawer initialText={planShiftText} onDone={() => { setPlanShiftText(null); setAiInput(""); setAiOpen(false); setTodayRefreshToken((value) => value + 1); }} /> : !aiCandidate ? <div className="drawer-entry">
        <div className="drawer-prompt"><p>说说你想记下什么。</p><small>新任务直接描述；调整已有排期请以“计划：”或“计划 ”开头。任何变更都要由你确认。</small></div>
        <section className="conversation-thread" aria-live="polite" aria-label="今天的软件内对话">
          <div className="conversation-heading"><p className="section-kicker">软件内对话</p>{conversationLoading && <LoaderCircle className="spin" aria-label="正在读取软件内对话" />}</div>
          {conversationMessages.length === 0 && !conversationLoading ? <p className="conversation-empty">从这里开始的一句话，会被保存在今天的本机对话里。</p> : conversationMessages.map((message) => <article key={message.id} className={`conversation-message ${message.role}`}><span>{message.role === "user" ? "我" : "AI"}</span><p>{message.content}</p></article>)}
          {conversationMessages.at(-1)?.role === "user" && <button className="text-button conversation-retry" type="button" disabled={conversationSending} onClick={() => void retryConversationReply()}>{conversationSending ? <LoaderCircle className="spin" /> : <RefreshCw />}{conversationSending ? "正在重试" : "重试 AI 回复"}</button>}
        </section>
        <textarea aria-label="AI 输入内容" value={aiInput} onChange={(event) => { setAiInput(event.target.value); setAiParseError(null); }} placeholder="例如：明天上午九点用六十分钟学习线性代数" rows={7} maxLength={4000} />
        {aiParseError && <div className="ai-parse-recovery" role="alert"><RefreshCw /><div><strong>这次没有生成候选</strong><p>{aiParseError}</p></div></div>}
        <div className="drawer-actions">
          <button className="primary-button full-width" type="button" disabled={conversationLoading || conversationSending || !conversation || !aiInput.trim()} onClick={() => void sendConversationMessage()}>{conversationSending ? <LoaderCircle className="spin" /> : <Send />}{conversationSending ? "正在发送" : "发送"}</button>
          <button className="quiet-button full-width" type="button" disabled={aiLoading || saving || conversationSending || !aiInput.trim()} onClick={() => void parseWithAi()}>{aiLoading ? <LoaderCircle className="spin" /> : aiParseError ? <RefreshCw /> : <Sparkles />}{aiLoading ? "正在整理" : aiParseError ? "重新整理" : "整理成候选"}</button>
        </div>
      </div> : <div className="candidate-view"><p className="section-kicker">待你确认</p><div className="candidate-title"><span>{entryLabels[aiCandidate.entryType]}</span><h2>逐项确认后再保存</h2><small>AI 只提供候选，任何内容都不会在此之前写入你的计划。</small></div><form className="candidate-form" onSubmit={saveAiCandidate}><label className="candidate-wide"><span>候选类型</span><select aria-label="候选类型" value={aiCandidate.entryType} onChange={(event) => setAiCandidate((current) => current ? { ...current, entryType: event.target.value as EntryType, scheduleKind: event.target.value === "task" ? current.scheduleKind : "none" } : current)}><option value="task">任务</option><option value="idea">想法</option><option value="question">问题</option></select></label><label className="candidate-wide"><span>{aiCandidate.entryType === "task" ? "任务标题" : aiCandidate.entryType === "idea" ? "想法内容" : "问题内容"}</span><input aria-label="候选标题" required maxLength={200} value={aiCandidate.title} onChange={(event) => setAiCandidate((current) => current ? { ...current, title: event.target.value } : current)} /></label>{aiCandidate.entryType === "task" && <><label><span>排期方式</span><select aria-label="候选排期方式" value={aiCandidate.scheduleKind} onChange={(event) => setAiCandidate((current) => current ? { ...current, scheduleKind: event.target.value as ScheduleKind, localDate: current.localDate || shanghaiDate() } : current)}><option value="none">未排期</option><option value="daypart">时间段</option><option value="exact">精确时间</option></select></label><label><span>日期{aiCandidate.scheduleKind === "none" ? "（可选）" : ""}</span><input aria-label="候选日期" type="date" required={aiCandidate.scheduleKind !== "none"} value={aiCandidate.localDate} onChange={(event) => setAiCandidate((current) => current ? { ...current, localDate: event.target.value } : current)} /></label>{aiCandidate.scheduleKind === "daypart" && <label className="candidate-wide"><span>时间段</span><select aria-label="候选时间段" value={aiCandidate.daypart} onChange={(event) => setAiCandidate((current) => current ? { ...current, daypart: event.target.value as Daypart } : current)}><option value="morning">上午</option><option value="afternoon">下午</option><option value="evening">晚上</option></select></label>}{aiCandidate.scheduleKind === "exact" && <><label><span>开始时间</span><input aria-label="候选开始时间" type="time" step="1800" min={timeFromMinute(nextAvailableMinuteForToday(aiCandidate.localDate))} max={timeFromMinute(PRODUCT_SCHEDULE_END_MINUTE - 30)} required value={aiCandidate.start} onChange={(event) => setAiCandidate((current) => current ? { ...current, start: event.target.value } : current)} /></label><label><span>结束时间</span><input aria-label="候选结束时间" type="time" step="1800" min={timeFromMinute(PRODUCT_SCHEDULE_START_MINUTE + 30)} max={timeFromMinute(PRODUCT_SCHEDULE_END_MINUTE)} required value={aiCandidate.end} onChange={(event) => setAiCandidate((current) => current ? { ...current, end: event.target.value } : current)} /></label></>}</>}<label className="candidate-wide"><span>备注（可选）</span><textarea aria-label="候选备注" rows={3} maxLength={4000} value={aiCandidate.notes} onChange={(event) => setAiCandidate((current) => current ? { ...current, notes: event.target.value } : current)} /></label>{candidateMissingFields(aiCandidate).length > 0 && <p className="candidate-note candidate-wide">仍待补充：{candidateMissingFields(aiCandidate).join("、")}</p>}<footer className="candidate-wide"><button className="primary-button full-width" type="submit" disabled={saving}>{saving ? <LoaderCircle className="spin" /> : <Check />}{candidateSaveLabel(aiCandidate)}</button><button className="text-button centered" type="button" disabled={saving} onClick={() => setAiCandidate(null)}>返回修改原句</button></footer></form></div>}
    </aside>
    {candidateConflictPrompt && <div className="task-dialog-backdrop conflict-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) resolveCandidateConflictPrompt("return"); }}><section className="conflict-dialog" role="alertdialog" aria-modal="true" aria-labelledby="candidate-conflict-title" aria-describedby="candidate-conflict-description"><header><div><p className="section-kicker">候选排期冲突</p><h2 id="candidate-conflict-title">这项候选与现有任务重叠</h2></div><button type="button" aria-label="返回调整候选排期" onClick={() => resolveCandidateConflictPrompt("return")}><X /></button></header><p id="candidate-conflict-description">正式时间表不允许保留重叠任务。候选内容会继续保留，请返回并调整时间。</p><ul aria-label="候选当前冲突任务">{candidateConflictPrompt.conflicts.map((item) => <li key={`${item.taskId}:${item.scheduleRevision}`}><span>{localTimeFromIso(item.startAt)}–{localTimeFromIso(item.endAt)}</span><strong>{item.title}</strong><small>{item.lifecycleStatus === "active" ? "正在专注" : item.lifecycleStatus === "awaiting_outcome" ? "等待结果" : item.lifecycleStatus === "closed" ? "历史重叠" : "待办任务"}</small></li>)}</ul><footer><button type="button" className="primary-button" onClick={() => resolveCandidateConflictPrompt("return")}>返回调整</button></footer></section></div>}
    {aiOpen && <button className="drawer-scrim" type="button" aria-label="关闭 AI 助手" onClick={closeAiDrawer} />}
    <nav className="mobile-nav" aria-label="移动端主要导航">{visibleNavItems.map(({ id, label, icon: Icon }) => <button className={view === id ? "active" : ""} type="button" key={id} onClick={() => navigateToView(id)}><Icon /><span>{label}</span></button>)}</nav>
  </main>;
}
