import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  Clock3,
  Eye,
  Maximize2,
  Minimize2,
  PencilLine,
  Play,
  X,
  XCircle,
} from "lucide-react";
import type { FocusTheme } from "@personal-ai/domain/user-profile";
import { CyberFocusEvaluation } from "./CyberFocusEvaluation";
import { FocusStructureEditor, type FocusStructureRecord } from "./FocusStructureEditor";
import {
  FocusEvaluationForm,
  progressForOutcome,
  validFocusEvaluation,
  type FocusOutcome,
  type FocusSatisfaction,
} from "./FocusEvaluationForm";
import { formatFocusClock, type FocusSegment } from "@personal-ai/domain/focus";
import { defaultFocusSoundPreferences, playFocusCue, type FocusSoundPreferences } from "./focus-audio";
import { DecorativePlant } from "./SeasonalAtmosphere";
import { FocusThemeClock } from "./FocusThemeClock";
import { focusQuote } from "./focus-quotes";
import { invokeDesktop } from "./focus-session-client";

const IDLE_EVALUATION_TIMEOUT_MS = 60_000;

type Task = {
  id: string;
  title: string;
  recordKind: "formal" | "backfill";
  lifecycleStatus:
    | "open"
    | "active"
    | "awaiting_outcome"
    | "closed"
    | "cancelled";
  scheduleKind: "none" | "daypart" | "exact";
  startAt: string | null;
  endAt: string | null;
  timeZone: string;
  scheduleRevision: number;
  version: number;
};
type FocusState =
  | "scheduled"
  | "reminded"
  | "preparing"
  | "armed"
  | "awaiting_late_start"
  | "running"
  | "paused"
  | "ended"
  | "evaluated"
  | "stopped_no_response"
  | "stopped_for_change";
type Session = {
  id: string;
  taskId: string;
  state: FocusState;
  plannedStartAt: string | null;
  plannedEndAt: string | null;
  preparingEndsAt: string | null;
  activeSinceAt: string | null;
  pausedAt: string | null;
  endedAt: string | null;
  pausedTotalSeconds: number;
  rawActiveSeconds: number;
  effectiveFocusSeconds: number;
  focusStructureId: string | null;
  currentSegmentPosition: number | null;
  currentSegmentStartedAt: string | null;
  currentSegmentElapsedSeconds: number;
  version: number;
  stoppedReason: string | null;
};
type UserSoundProfile = {
  focusTheme?: FocusTheme;
  focusEvaluationEnabled?: boolean;
  focusFlipSoundEnabled?: boolean;
  focusStartSoundEnabled?: boolean;
  breakStartSoundEnabled?: boolean;
  breakEndSoundEnabled?: boolean;
  focusEndSoundEnabled?: boolean;
};

const DEFAULT_TIME_ZONE = "Asia/Shanghai";
const FOCUS_STATES: FocusState[] = [
  "scheduled", "reminded", "preparing", "armed", "awaiting_late_start",
  "running", "paused", "ended", "evaluated", "stopped_no_response", "stopped_for_change",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function safeTimeZone(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return value;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function nullableDateString(value: unknown): string | null {
  const text = nullableString(value);
  return text && Number.isFinite(new Date(text).getTime()) ? text : null;
}

function positiveInt(value: unknown, fallback: number): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function normalizeTask(value: unknown): Task | null {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id) return null;
  const recordKind = value.recordKind === "backfill" ? "backfill" : "formal";
  const lifecycleStatus = ["open", "active", "awaiting_outcome", "closed", "cancelled"].includes(String(value.lifecycleStatus))
    ? value.lifecycleStatus as Task["lifecycleStatus"]
    : "open";
  const scheduleKind = ["none", "daypart", "exact"].includes(String(value.scheduleKind))
    ? value.scheduleKind as Task["scheduleKind"]
    : "none";
  return {
    id: value.id,
    title: typeof value.title === "string" && value.title.trim() ? value.title : "未命名任务",
    recordKind,
    lifecycleStatus,
    scheduleKind,
    startAt: nullableDateString(value.startAt),
    endAt: nullableDateString(value.endAt),
    timeZone: safeTimeZone(value.timeZone),
    scheduleRevision: positiveInt(value.scheduleRevision, 1),
    version: positiveInt(value.version, 1),
  };
}

function normalizeSession(value: unknown): Session | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.taskId !== "string") return null;
  const state = FOCUS_STATES.includes(value.state as FocusState) ? value.state as FocusState : null;
  if (!state) return null;
  const rawSegmentPosition = value.currentSegmentPosition === null || value.currentSegmentPosition === undefined
    ? null
    : Number(value.currentSegmentPosition);
  const currentSegmentPosition = typeof rawSegmentPosition === "number" && Number.isInteger(rawSegmentPosition) && rawSegmentPosition >= 0
    ? rawSegmentPosition
    : null;
  return {
    id: value.id,
    taskId: value.taskId,
    state,
    plannedStartAt: nullableDateString(value.plannedStartAt),
    plannedEndAt: nullableDateString(value.plannedEndAt),
    preparingEndsAt: nullableDateString(value.preparingEndsAt),
    activeSinceAt: nullableDateString(value.activeSinceAt),
    pausedAt: nullableDateString(value.pausedAt),
    endedAt: nullableDateString(value.endedAt),
    pausedTotalSeconds: Math.max(0, Number(value.pausedTotalSeconds) || 0),
    rawActiveSeconds: Math.max(0, Number(value.rawActiveSeconds) || 0),
    effectiveFocusSeconds: Math.max(0, Number(value.effectiveFocusSeconds) || 0),
    focusStructureId: nullableString(value.focusStructureId),
    currentSegmentPosition,
    currentSegmentStartedAt: nullableDateString(value.currentSegmentStartedAt),
    currentSegmentElapsedSeconds: Math.max(0, Number(value.currentSegmentElapsedSeconds) || 0),
    version: positiveInt(value.version, 1),
    stoppedReason: nullableString(value.stoppedReason),
  };
}

function normalizeStructure(value: unknown): FocusStructureRecord | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.totalStartAt !== "string" || typeof value.totalEndAt !== "string") return null;
  const totalStartMs = new Date(value.totalStartAt).getTime();
  const totalEndMs = new Date(value.totalEndAt).getTime();
  if (!Number.isFinite(totalStartMs) || !Number.isFinite(totalEndMs) || totalEndMs <= totalStartMs) return null;
  const state = ["candidate", "active", "superseded", "invalidated", "cancelled"].includes(String(value.state))
    ? value.state as FocusStructureRecord["state"]
    : null;
  if (!state || !Array.isArray(value.segments)) return null;
  const segments: FocusStructureRecord["segments"] = value.segments.flatMap((segment, index) => {
    if (!isRecord(segment)) return [];
    const segmentType: FocusSegment["segmentType"] | null = segment.segmentType === "break" ? "break" : segment.segmentType === "focus" ? "focus" : null;
    const durationMinutes = Number(segment.durationMinutes);
    if (!segmentType || !Number.isFinite(durationMinutes) || durationMinutes <= 0) return [];
    const rawPosition = Number(segment.position);
    const position = Number.isInteger(rawPosition) && rawPosition >= 0 ? rawPosition : index;
    return [{ segmentType, durationMinutes, position }];
  }).map((segment, index) => ({ ...segment, position: Number.isInteger(segment.position) && segment.position >= 0 ? segment.position : index }));
  if (!segments.length) return null;
  const totalMinutes = (totalEndMs - totalStartMs) / 60_000;
  if (!Number.isInteger(totalMinutes) || segments.reduce((sum, segment) => sum + segment.durationMinutes, 0) !== totalMinutes) return null;
  return {
    id: value.id,
    state,
    source: value.source === "ai" || value.source === "template" ? value.source : "manual",
    taskScheduleRevision: positiveInt(value.taskScheduleRevision, 1),
    totalStartAt: value.totalStartAt,
    totalEndAt: value.totalEndAt,
    version: positiveInt(value.version, 1),
    segments,
  };
}

function isFocusStartEligibleTask(task: Task | null | undefined): task is Task {
  return Boolean(
    task
    && task.recordKind === "formal"
    && task.lifecycleStatus === "open"
    && task.scheduleKind === "exact"
    && task.startAt
    && task.endAt
  );
}

const API = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3000";
const nowDate = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
const clock = (value: string, timeZone: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: safeTimeZone(timeZone), hour: "2-digit", minute: "2-digit", hour12: false
  }).format(date);
};
const taskScheduleLabel = (task: Pick<Task, "startAt" | "endAt" | "timeZone">) => {
  if (!task.startAt || !task.endAt) return "未设置精确时间";
  const timeZone = safeTimeZone(task.timeZone);
  const date = new Date(task.startAt);
  if (Number.isNaN(date.getTime())) return "未设置精确时间";
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  const weekday = new Intl.DateTimeFormat("zh-CN", { timeZone, weekday: "short" }).format(date);
  return `${part("year")}年${part("month")}月${part("day")}日（${weekday}） · ${clock(task.startAt, timeZone)}–${clock(task.endAt, timeZone)}`;
};

async function request<T>(
  path: string,
  method = "GET",
  body?: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw Object.assign(new Error(error.error ?? "request_failed"), {
      body: error,
    });
  }
  return (await response.json()) as T;
}

function InkClepsydra({ value, progress, resting, empty, compact = false }: { value: string; progress: number; resting: boolean; empty: boolean; compact?: boolean }) {
  const boundedProgress = Math.max(0, Math.min(100, progress));
  return <div
    className={`ink-clepsydra ${compact ? "compact" : ""} ${resting ? "resting" : ""}`}
    aria-label={`${resting ? "休息" : "剩余"}时间 ${value}`}
    style={{
      "--ink-progress": `${boundedProgress}%`,
    } as CSSProperties}
  >
    <strong className={empty ? "empty" : undefined}>{empty ? "·" : value.split("").map((character, index) => <span key={`${character}-${index}`} aria-hidden="true">{character}</span>)}</strong>
    <span className="ink-clepsydra-line" aria-hidden="true"><i><b /></i></span>
  </div>;
}

function ThemedFocusTimer({ theme, value, progress, resting, empty, compact = false }: { theme: FocusTheme; value: string; progress: number; resting: boolean; empty: boolean; compact?: boolean }) {
  if (theme === "ink") return <InkClepsydra value={value} progress={progress} resting={resting} empty={empty} compact={compact} />;
  const displayValue = empty ? "00:00" : value;
  return (
    <div className={`focus-themed-timer focus-themed-timer-${theme} ${compact ? "compact" : ""} ${resting ? "resting" : ""} ${empty ? "empty" : ""}`} aria-label={`${resting ? "休息" : "剩余"}时间 ${value}`}>
      <FocusThemeClock theme={theme} value={displayValue} />
      <span className="focus-themed-timer-progress" aria-hidden="true"><i style={{ width: `${Math.max(0, Math.min(100, progress))}%` }}><b /></i></span>
    </div>
  );
}

export function FocusWorkspace({
  isWorkspaceCurrent,
  preferredTaskId,
  onBack,
  onPlanChange,
  onPreferredTaskReady,
}: {
  isWorkspaceCurrent: boolean;
  preferredTaskId: string | null;
  onBack: () => void;
  onPlanChange: (task: { id: string; title: string }) => void;
  onPreferredTaskReady?: (taskId: string) => void;
}) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [activeStructure, setActiveStructure] = useState<FocusStructureRecord | null>(null);
  const [sessionStructure, setSessionStructure] = useState<FocusStructureRecord | null>(null);
  const [candidateStructure, setCandidateStructure] = useState<FocusStructureRecord | null>(null);
  const [loadedStructureKey, setLoadedStructureKey] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(preferredTaskId);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<FocusOutcome>("complete");
  const [progress, setProgress] = useState("100");
  const [satisfaction, setSatisfaction] = useState<FocusSatisfaction>("satisfied");
  const [note, setNote] = useState("");
  const [waitingExpanded, setWaitingExpanded] = useState(false);
  const [pendingExpanded, setPendingExpanded] = useState(false);
  const [evaluationSession, setEvaluationSession] = useState<Session | null>(null);
  const [evaluationTask, setEvaluationTask] = useState<Task | null>(null);
  const [evaluationDeadlineMs, setEvaluationDeadlineMs] = useState<number | null>(null);
  const evaluationTimerRef = useRef<number | null>(null);
  const evaluationTimerVersionRef = useRef(0);
  const [focusTheme, setFocusTheme] = useState<FocusTheme>("ink");
  const [arrangementOpen, setArrangementOpen] = useState(false);
  const [editArrangementOpen, setEditArrangementOpen] = useState(false);
  const [executionMinimized, setExecutionMinimized] = useState(false);
  const [soundPreferences, setSoundPreferences] = useState<FocusSoundPreferences>(defaultFocusSoundPreferences);
  const loadRequestRef = useRef(0);
  const previousCueState = useRef<{ sessionId: string; state: FocusState; segmentPosition: number | null; segmentType: FocusSegment["segmentType"] | null } | null>(null);
  const previousFlipMinute = useRef<number | null>(null);
  const sessionIdentityRef = useRef<string | null>(null);
  const evaluationIdentityRef = useRef<string | null>(null);

  function scheduleEvaluationTimeout(sessionId: string, deadlineMs: number) {
    evaluationTimerVersionRef.current += 1;
    const version = evaluationTimerVersionRef.current;
    if (evaluationTimerRef.current) window.clearTimeout(evaluationTimerRef.current);
    evaluationTimerRef.current = window.setTimeout(() => {
      if (evaluationTimerVersionRef.current !== version) return;
      window.localStorage.setItem(`personal-ai.focus-evaluation-dismissed.${sessionId}`, "1");
      evaluationIdentityRef.current = null;
      setEvaluationSession(null);
      setEvaluationTask(null);
      setEvaluationDeadlineMs(null);
      evaluationTimerRef.current = null;
    }, Math.max(0, deadlineMs - Date.now()));
  }
  const load = useCallback(async () => {
    const requestId = ++loadRequestRef.current;
    const [list, current, execution, profileResult] = await Promise.all([
      request<{ tasks?: unknown }>(`/api/v1/tasks?date=${nowDate()}`),
      request<{ session?: unknown }>("/api/v1/focus-sessions/current"),
      request<{ session?: unknown }>("/api/v1/focus-sessions/current-execution"),
      request<{ profile: UserSoundProfile }>("/api/v1/user-profile").catch(() => ({ profile: {} as UserSoundProfile }))
    ]);
    if (requestId !== loadRequestRef.current) return;
    const profile = isRecord(profileResult.profile) ? profileResult.profile : {} as UserSoundProfile;
    setSoundPreferences({
      flip: profile.focusFlipSoundEnabled ?? true,
      focusStart: profile.focusStartSoundEnabled ?? true,
      breakStart: profile.breakStartSoundEnabled ?? true,
      breakEnd: profile.breakEndSoundEnabled ?? true,
      focusEnd: profile.focusEndSoundEnabled ?? true
    });
    setFocusTheme(profile.focusTheme ?? "ink");
    const evaluationSessionCandidate = normalizeSession(current.session);
    const currentSession = normalizeSession(execution.session) ?? evaluationSessionCandidate;
    const listTasks = Array.isArray(list.tasks)
      ? list.tasks.map(normalizeTask).filter((task): task is Task => Boolean(task))
      : [];
    const additionalTaskIds = [...new Set([
      currentSession?.taskId,
      evaluationSessionCandidate?.taskId,
      preferredTaskId
    ].filter((id): id is string => Boolean(id)))];
    const additionalTasks = await Promise.all(additionalTaskIds.map((id) =>
      request<{ task?: unknown }>(`/api/v1/tasks/${id}`)
        .then((result) => normalizeTask(result.task))
        .catch(() => null)
    ));
    if (requestId !== loadRequestRef.current) return;
    const currentSessionTask = currentSession
      ? additionalTasks.find((task) => task?.id === currentSession.taskId) ?? listTasks.find((task) => task.id === currentSession.taskId) ?? null
      : null;
    const evaluationSessionTask = evaluationSessionCandidate
      ? additionalTasks.find((task) => task?.id === evaluationSessionCandidate.taskId) ?? listTasks.find((task) => task.id === evaluationSessionCandidate.taskId) ?? null
      : null;
    const preferredTask = preferredTaskId
      ? additionalTasks.find((task) => task?.id === preferredTaskId) ?? null
      : null;
    const visible = listTasks.filter((task) => task.lifecycleStatus === "awaiting_outcome" || isFocusStartEligibleTask(task));
    if (currentSessionTask?.recordKind === "formal" && !visible.some((task) => task.id === currentSessionTask.id)) {
      visible.push(currentSessionTask);
    }
    if (isFocusStartEligibleTask(preferredTask) && !visible.some((task) => task.id === preferredTask.id)) {
      visible.push(preferredTask);
    }
    visible.sort((left, right) => {
      const leftTime = left.startAt ? new Date(left.startAt).getTime() : Number.MAX_SAFE_INTEGER;
      const rightTime = right.startAt ? new Date(right.startAt).getTime() : Number.MAX_SAFE_INTEGER;
      return leftTime - rightTime || left.title.localeCompare(right.title, "zh-CN");
    });
    setTasks(visible);
    const nextExecutionSession = currentSession && ["scheduled", "reminded", "preparing", "armed", "awaiting_late_start", "running", "paused"].includes(currentSession.state)
      ? currentSession
      : null;
    const automaticEvaluationDeadline = evaluationSessionCandidate?.endedAt
      ? new Date(evaluationSessionCandidate.endedAt).getTime() + IDLE_EVALUATION_TIMEOUT_MS
      : Number.NaN;
    const evaluationDismissed = evaluationSessionCandidate?.state === "ended"
      && window.localStorage.getItem(`personal-ai.focus-evaluation-dismissed.${evaluationSessionCandidate.id}`) === "1";
    if (
      (profile.focusEvaluationEnabled ?? true)
      && evaluationSessionCandidate?.state === "ended"
      && evaluationSessionTask
      && !evaluationDismissed
      && (evaluationIdentityRef.current === evaluationSessionCandidate.id || automaticEvaluationDeadline > Date.now())
    ) {
      if (evaluationIdentityRef.current !== evaluationSessionCandidate.id) {
        evaluationIdentityRef.current = evaluationSessionCandidate.id;
        setEvaluationSession(evaluationSessionCandidate);
        setEvaluationTask(evaluationSessionTask);
        const deadline = Date.now() + IDLE_EVALUATION_TIMEOUT_MS;
        setEvaluationDeadlineMs(deadline);
        scheduleEvaluationTimeout(evaluationSessionCandidate.id, deadline);
        setOutcome("complete");
        setProgress("100");
        setSatisfaction("satisfied");
        setNote("");
      }
    }
    setSession(nextExecutionSession);
    const visibleIds = new Set(visible.map((task) => task.id));
    const startableIds = new Set(visible.filter(isFocusStartEligibleTask).map((task) => task.id));
    const sessionTaskId = nextExecutionSession?.taskId && visibleIds.has(nextExecutionSession.taskId)
      ? nextExecutionSession.taskId
      : null;
    const preferredEligibleId = isFocusStartEligibleTask(preferredTask) && visibleIds.has(preferredTask.id)
      ? preferredTask.id
      : null;
    const sessionChanged = sessionIdentityRef.current !== (nextExecutionSession?.id ?? null);
    sessionIdentityRef.current = nextExecutionSession?.id ?? null;
    setSelectedId((currentId) => {
      if (!sessionChanged && currentId && visibleIds.has(currentId)) return currentId;
      return sessionTaskId
        ?? preferredEligibleId
        ?? (currentId && startableIds.has(currentId) ? currentId : null)
        ?? visible.find(isFocusStartEligibleTask)?.id
        ?? null;
    });
  }, [preferredTaskId]);
  useEffect(() => {
    void load().catch(() =>
      setError("无法恢复专注会话，请确认 API 正在运行。"),
    );
  }, [load]);
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") void load().catch(() => undefined);
    };
    window.addEventListener("focus", refresh);
    window.addEventListener("pageshow", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("pageshow", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [load]);
  const selected = useMemo(
    () => tasks.find((task) => task.id === selectedId) ?? null,
    [tasks, selectedId],
  );
  const sessionTask = useMemo(
    () => tasks.find((task) => task.id === session?.taskId) ?? null,
    [tasks, session?.taskId]
  );
  useEffect(() => {
    if (preferredTaskId && selected?.id === preferredTaskId) onPreferredTaskReady?.(selected.id);
  }, [onPreferredTaskReady, preferredTaskId, selected?.id]);
  const structureKey = selected?.scheduleKind === "exact" && selected.startAt && selected.endAt
    ? `${selected.id}:${selected.scheduleRevision}:${selected.startAt}:${selected.endAt}`
    : null;
  useEffect(() => {
    if (!selected || selected.scheduleKind !== "exact" || !structureKey) {
      setActiveStructure(null);
      setCandidateStructure(null);
      setLoadedStructureKey(null);
      return;
    }
    let cancelled = false;
    void request<{ focusStructures: FocusStructureRecord[] }>(`/api/v1/tasks/${selected.id}/focus-structures`)
      .then((result) => {
        if (cancelled) return;
        const structures = Array.isArray(result.focusStructures)
          ? result.focusStructures.map(normalizeStructure).filter((item): item is FocusStructureRecord => Boolean(item))
          : [];
        const current = structures.filter((item) =>
          item.taskScheduleRevision === selected.scheduleRevision &&
          new Date(item.totalStartAt).getTime() === new Date(selected.startAt!).getTime() &&
          new Date(item.totalEndAt).getTime() === new Date(selected.endAt!).getTime()
        );
        setActiveStructure(current.find((item) => item.state === "active") ?? null);
        setCandidateStructure(current.find((item) => item.state === "candidate") ?? null);
      })
      .catch(() => {
        if (!cancelled) {
          setActiveStructure(null);
          setCandidateStructure(null);
          setError("无法读取已保存的专注结构，请刷新后重试。");
        }
      })
      .finally(() => { if (!cancelled) setLoadedStructureKey(structureKey); });
    return () => { cancelled = true; };
  }, [structureKey]);
  useEffect(() => {
    if (!session?.focusStructureId) {
      setSessionStructure(null);
      return;
    }
    let cancelled = false;
    void request<{ focusStructures: FocusStructureRecord[] }>(`/api/v1/tasks/${session.taskId}/focus-structures`)
      .then((result) => {
        if (cancelled) return;
        const structures = Array.isArray(result.focusStructures)
          ? result.focusStructures.map(normalizeStructure).filter((item): item is FocusStructureRecord => Boolean(item))
          : [];
        setSessionStructure(structures.find((item) => item.id === session.focusStructureId) ?? null);
      })
      .catch(() => { if (!cancelled) setSessionStructure(null); });
    return () => { cancelled = true; };
  }, [session?.focusStructureId, session?.taskId]);
  useEffect(() => {
    if (!session && !evaluationSession) return;
    const update = () => {
      setNowMs(Date.now());
    };
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [evaluationSession, session]);
  useEffect(() => () => {
    if (evaluationTimerRef.current) window.clearTimeout(evaluationTimerRef.current);
    evaluationTimerRef.current = null;
  }, []);
  useEffect(() => {
    if (!session || !["reminded", "scheduled", "preparing", "armed", "awaiting_late_start", "running"].includes(session.state)) return;
    const timer = window.setInterval(() => void load().catch(() => undefined), 15_000);
    return () => window.clearInterval(timer);
  }, [load, session?.state]);
  useEffect(() => {
    if (session?.state !== "scheduled" || !session.plannedStartAt) return;
    const left = Math.max(0, new Date(session.plannedStartAt).getTime() - 60_000 - Date.now());
    const timer = window.setTimeout(() => void load().catch(() => undefined), left + 50);
    return () => window.clearTimeout(timer);
  }, [load, session?.plannedStartAt, session?.state]);
  async function createStructureCandidate(
    segments: FocusSegment[],
    source: "manual" | "template"
  ): Promise<FocusStructureRecord> {
    if (!selected || selected.scheduleKind !== "exact" || !selected.startAt || !selected.endAt) {
      throw new Error("focus_structure_task_unavailable");
    }
    const breakMinutes = segments.find((segment) => segment.segmentType === "break")?.durationMinutes ?? 0;
    const continuous = segments.filter((segment) => segment.segmentType === "focus").length === 1;
    const candidate = await request<{ focusStructure: FocusStructureRecord }>(
      "/api/v1/focus-structures/candidates",
      "POST",
      {
        taskId: selected.id,
        taskVersion: selected.version,
        taskScheduleRevision: selected.scheduleRevision,
        source,
        mode: continuous ? "continuous" : "segmented",
        totalStartAt: selected.startAt,
        totalEndAt: selected.endAt,
        breakMinutes,
        ...(continuous ? {} : { segments })
      }
    );
    const normalized = normalizeStructure(candidate.focusStructure);
    if (!normalized) throw new Error("focus_structure_invalid_response");
    return normalized;
  }

  async function saveStructure(segments: FocusSegment[], source: "manual" | "template"): Promise<void> {
    if (!selected || selected.scheduleKind !== "exact" || !selected.startAt || !selected.endAt) return;
    setBusy(true);
    setError(null);
    try {
      setCandidateStructure(await createStructureCandidate(segments, source));
    } catch (error: any) {
      setError(error.body?.error === "focus_structure_task_conflict"
        ? "任务排期已经变化，请刷新后重新安排结构。"
        : "候选结构没有保存，请检查各段时间后重试。");
    } finally {
      setBusy(false);
    }
  }

  async function planAiStructure(instructions: string | null): Promise<void> {
    if (!selected || selected.scheduleKind !== "exact") return;
    setBusy(true);
    setError(null);
    try {
      const candidate = await request<{ focusStructure: FocusStructureRecord }>(
        "/api/v1/focus-structures/ai-candidates", "POST", {
          taskId: selected.id,
          taskVersion: selected.version,
          taskScheduleRevision: selected.scheduleRevision,
          instructions
        });
      const normalized = normalizeStructure(candidate.focusStructure);
      if (!normalized) throw new Error("focus_structure_invalid_response");
      setCandidateStructure(normalized);
    } catch (error: any) {
      setError(error.body?.error === "focus_structure_task_conflict"
        ? "任务排期已经变化，请刷新后再让 AI 安排。"
        : error.body?.message ?? "AI 暂时无法安排，现有结构没有变化。");
    } finally {
      setBusy(false);
    }
  }

  async function confirmStructure(): Promise<void> {
    if (!selected || !candidateStructure) return;
    setBusy(true);
    setError(null);
    try {
      const confirmed = await request<{ focusStructure: FocusStructureRecord }>(
        `/api/v1/focus-structures/${candidateStructure.id}/confirm`, "POST", {
          expectedVersion: candidateStructure.version,
          expectedTaskVersion: selected.version,
          expectedTaskScheduleRevision: selected.scheduleRevision
        });
      const normalized = normalizeStructure(confirmed.focusStructure);
      if (!normalized) throw new Error("focus_structure_invalid_response");
      setActiveStructure(normalized);
      setCandidateStructure(null);
    } catch (error: any) {
      setError(error.body?.error?.includes("conflict")
        ? "候选或任务已在其他位置更新，请刷新后重新确认。"
        : "候选结构没有确认，请重试。");
    } finally {
      setBusy(false);
    }
  }

  async function confirmStructureDraft(segments: FocusSegment[]): Promise<void> {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const candidate = await createStructureCandidate(segments, "manual");
      const confirmed = await request<{ focusStructure: FocusStructureRecord }>(
        `/api/v1/focus-structures/${candidate.id}/confirm`, "POST", {
          expectedVersion: candidate.version,
          expectedTaskVersion: selected.version,
          expectedTaskScheduleRevision: selected.scheduleRevision
        });
      const normalized = normalizeStructure(confirmed.focusStructure);
      if (!normalized) throw new Error("focus_structure_invalid_response");
      setActiveStructure(normalized);
      setCandidateStructure(null);
    } catch (error: any) {
      setError(error.body?.error?.includes("conflict")
        ? "任务排期已经变化，请刷新后重新确认。"
        : "这份结构没有确认成功，请重试。");
    } finally {
      setBusy(false);
    }
  }

  async function discardCandidate(): Promise<void> {
    if (!candidateStructure) return;
    setBusy(true);
    setError(null);
    try {
      await request(`/api/v1/focus-structures/${candidateStructure.id}/cancel`, "POST", {
        expectedVersion: candidateStructure.version
      });
      setCandidateStructure(null);
    } catch {
      setError("候选结构没有放弃，请刷新后重试。");
    } finally {
      setBusy(false);
    }
  }

  async function begin(mode: "prepare" | "remind" = "prepare") {
    if (!isFocusStartEligibleTask(selected)) {
      setError("请先把任务拖入时间轴，设置精确的开始和结束时间。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (!activeStructure) {
        setError("请先保存候选并明确确认专注结构。");
        return;
      }
      const result = await request<{ session: Session }>(
        "/api/v1/focus-sessions",
        "POST",
        { taskId: selected.id, expectedTaskVersion: selected.version, mode, commandId: crypto.randomUUID() },
      );
      setSession(result.session);
      await load();
    } catch (error: any) {
      setError(
        error.body?.error === "focus_session_already_active"
          ? "已有一段专注正在进行。"
          : error.body?.error === "focus_task_not_scheduled"
            ? "请先把任务拖入时间轴，设置精确的开始和结束时间。"
          : "无法开始专注，请刷新后重试。",
      );
    } finally {
      setBusy(false);
    }
  }

  async function armSelectedDuringExecution(): Promise<void> {
    if (!isFocusStartEligibleTask(selected) || busy) return;
    if (!nextSequentialTaskId || selected.id !== nextSequentialTaskId) {
      setError("当前执行期间只能提前确认紧接着的下一项任务。其他后续任务不能提前开始。");
      return;
    }
    if (!activeStructure) {
      setError("请先保存候选并明确确认专注结构。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await request<{ session: Session }>(
        "/api/v1/focus-sessions",
        "POST",
        {
          taskId: selected.id,
          expectedTaskVersion: selected.version,
          mode: "prepare",
          commandId: crypto.randomUUID(),
        },
      );
      let armed = created.session;
      if (["scheduled", "preparing", "reminded"].includes(armed.state)) {
        const confirmed = await request<{ session: Session }>(
          `/api/v1/focus-sessions/${armed.id}/begin`,
          "POST",
          { expectedVersion: armed.version, commandId: crypto.randomUUID() },
        );
        armed = confirmed.session;
      }
      setExecutionMinimized(true);
      await load();
    } catch (error: any) {
      setError(
        error.body?.error === "focus_session_already_active"
          ? "这项任务的开始时间与当前专注重叠，暂时不能同时计时。"
          : error.body?.error === "focus_task_not_scheduled"
            ? "请先把任务拖入时间轴，设置精确的开始和结束时间。"
            : "后续任务没有确认成功，请刷新后重试。",
      );
    } finally {
      setBusy(false);
    }
  }
  async function transition(
    action:
      | "skip-preparation"
      | "skip-final-break"
      | "other-arrangement"
      | "cancel-task"
      | "respond-start",
  ) {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      let result: { session: Session };
      if (action === "respond-start")
        result = await request(
          `/api/v1/focus-sessions/${session.id}/respond`,
          "POST",
          { expectedVersion: session.version, decision: "start", commandId: crypto.randomUUID() },
        );
      else if (action === "cancel-task")
        result = await request(
          `/api/v1/focus-sessions/${session.id}/resolve-preparation`,
          "POST",
          { expectedVersion: session.version, decision: "cancel_task", reason: "用户从专注页面取消任务", commandId: crypto.randomUUID() },
        );
      else if (action === "other-arrangement" && session.state === "reminded")
        result = await request(
          `/api/v1/focus-sessions/${session.id}/respond`,
          "POST",
          { expectedVersion: session.version, decision: "other_arrangement", commandId: crypto.randomUUID() },
        );
      else
        result = await request(
          `/api/v1/focus-sessions/${session.id}/${action}`,
          "POST",
          { expectedVersion: session.version, commandId: crypto.randomUUID() },
        );
      setSession(result.session);
      await load();
      if (action === "other-arrangement" || action === "cancel-task") {
        onPlanChange({ id: result.session.taskId, title: sessionTask?.title ?? "这项任务" });
      }
    } catch (error: any) {
      setError(
        error.body?.error === "focus_session_version_conflict"
          ? "会话已在其他位置更新，已恢复最新状态。"
          : "操作没有保存，请重试。",
      );
      await load().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }
  function chooseOutcome(value: FocusOutcome) {
    const deadline = Date.now() + IDLE_EVALUATION_TIMEOUT_MS;
    setEvaluationDeadlineMs(deadline);
    if (evaluationSession) scheduleEvaluationTimeout(evaluationSession.id, deadline);
    setOutcome(value);
    setProgress(progressForOutcome(value));
    setError(null);
  }
  function markEvaluationInteraction() {
    const deadline = Date.now() + IDLE_EVALUATION_TIMEOUT_MS;
    setEvaluationDeadlineMs(deadline);
    if (evaluationSession) scheduleEvaluationTimeout(evaluationSession.id, deadline);
    setError(null);
  }
  async function openPendingEvaluation(task: Task) {
    setBusy(true);
    setError(null);
    try {
      const result = await request<{ session: Session | null }>(`/api/v1/focus-sessions/tasks/${task.id}/current`);
      if (!result.session || result.session.state !== "ended") {
        setError("这项任务没有可填写的待评价专注记录。");
        return;
      }
      evaluationIdentityRef.current = result.session.id;
      setEvaluationSession(result.session);
      setEvaluationTask(task);
      const deadline = Date.now() + IDLE_EVALUATION_TIMEOUT_MS;
      setEvaluationDeadlineMs(deadline);
      scheduleEvaluationTimeout(result.session.id, deadline);
      setOutcome("complete");
      setProgress("100");
      setSatisfaction("satisfied");
      setNote("");
    } catch {
      setError("无法读取这项任务的待评价记录，请刷新后重试。");
    } finally {
      setBusy(false);
    }
  }
  async function evaluate() {
    if (!evaluationSession) return;
    const value = Number(progress);
    if (!validFocusEvaluation(outcome, progress)) {
      setError("请填写与完成情况一致的客观进度。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await request(`/api/v1/focus-sessions/${evaluationSession.id}/evaluate`, "POST", {
        expectedVersion: evaluationSession.version,
        commandId: crypto.randomUUID(),
        outcome,
        progressPercent: value,
        satisfaction,
        note: note.trim() || null,
      });
      window.localStorage.removeItem(`personal-ai.focus-evaluation-dismissed.${evaluationSession.id}`);
      evaluationIdentityRef.current = null;
      if (evaluationTimerRef.current) window.clearTimeout(evaluationTimerRef.current);
      evaluationTimerRef.current = null;
      setEvaluationSession(null);
      setEvaluationTask(null);
      setEvaluationDeadlineMs(null);
      setNote("");
      await load();
    } catch {
      setError("结果尚未保存，请刷新后重试。");
    } finally {
      setBusy(false);
    }
  }
  const stage = session?.state ?? "idle";
  const displayTask = session ? sessionTask : selected;
  const selectedIsSessionTask = Boolean(session && selected?.id === session.taskId);
  const displayStructure = session
    ? (sessionStructure ?? (selectedIsSessionTask ? activeStructure : null))
    : activeStructure;
  const safeSegments = displayStructure?.segments ?? [];
  const prepLeft = session?.preparingEndsAt
    ? Math.ceil(
        Math.max(0, new Date(session.preparingEndsAt).getTime() - nowMs) /
          1000,
      )
    : 0;
  const scheduledLeft = session?.state === "scheduled" && session.plannedStartAt
    ? Math.ceil(Math.max(0, new Date(session.plannedStartAt).getTime() - nowMs) / 1000)
    : 0;
  const armedLeft = session?.state === "armed" && session.plannedStartAt
    ? Math.ceil(Math.max(0, new Date(session.plannedStartAt).getTime() - nowMs) / 1000)
    : 0;
  const selectedMinutes = displayTask?.startAt && displayTask.endAt
    ? Math.round((new Date(displayTask.endAt).getTime() - new Date(displayTask.startAt).getTime()) / 60_000)
    : null;
  const fixedWindowTotal = session?.plannedStartAt && session.plannedEndAt
    ? Math.max(0, Math.round((new Date(session.plannedEndAt).getTime() - new Date(session.plannedStartAt).getTime()) / 1000))
    : Math.max(0, (selectedMinutes ?? 0) * 60);
  const fixedWindowRemaining = session?.plannedEndAt && (stage === "running" || stage === "awaiting_late_start")
    ? Math.ceil(Math.max(0, new Date(session.plannedEndAt).getTime() - nowMs) / 1000)
    : fixedWindowTotal;
  const currentSegment = displayStructure && session && session.currentSegmentPosition !== null
    ? safeSegments[session.currentSegmentPosition] ?? null
    : null;
  const currentSegmentElapsed = stage === "running" && session?.currentSegmentStartedAt
    ? Math.max(0, Math.floor((nowMs - new Date(session.currentSegmentStartedAt).getTime()) / 1000))
    : session?.currentSegmentElapsedSeconds ?? 0;
  const currentSegmentRemaining = currentSegment
    ? Math.max(0, currentSegment.durationMinutes * 60 - currentSegmentElapsed)
    : 0;
  const timerTotal = stage === "preparing"
    ? 60
    : stage === "armed"
      ? Math.max(1, armedLeft)
      : stage === "awaiting_late_start"
        ? Math.max(1, fixedWindowTotal)
    : stage === "scheduled"
      ? Math.max(1, scheduledLeft)
      : currentSegment
        ? currentSegment.durationMinutes * 60
        : Math.max(1, fixedWindowTotal);
  const timerElapsed = stage === "preparing"
    ? 60 - prepLeft
    : stage === "armed"
      ? Math.max(0, timerTotal - armedLeft)
      : stage === "awaiting_late_start"
        ? Math.max(0, fixedWindowTotal - fixedWindowRemaining)
    : stage === "scheduled"
      ? 0
      : currentSegment
        ? timerTotal - currentSegmentRemaining
        : fixedWindowTotal > 0
          ? Math.max(0, timerTotal - fixedWindowRemaining)
          : 0;
  const isFinalBreak = stage === "running"
    && currentSegment?.segmentType === "break"
    && session?.currentSegmentPosition === safeSegments.length - 1;
  const focusScene = stage === "ended"
    ? "ended"
    : stage === "running" && currentSegment?.segmentType === "break"
      ? "break"
      : stage === "running"
        ? "focus"
        : ["scheduled", "reminded", "preparing", "armed", "awaiting_late_start"].includes(stage)
          ? "ready"
          : "idle";
  const clockValue = stage === "preparing"
    ? `00:${String(prepLeft).padStart(2, "0")}`
    : stage === "armed"
      ? formatFocusClock(armedLeft)
      : stage === "awaiting_late_start"
        ? formatFocusClock(fixedWindowRemaining)
    : stage === "scheduled"
      ? formatFocusClock(scheduledLeft)
      : stage === "reminded"
        ? "·"
      : currentSegment
        ? formatFocusClock(currentSegmentRemaining)
        : displayTask
          ? formatFocusClock(fixedWindowRemaining)
          : "";
  const timerProgress = displayTask || session
    ? Math.max(0, Math.min(100, timerElapsed / Math.max(1, timerTotal) * 100))
    : 0;
  const fixedEndLabel = displayTask?.endAt ? clock(displayTask.endAt, displayTask.timeZone) : null;
  const segmentTimings = useMemo(() => {
    if (!displayStructure) return [];
    let cursor = new Date(displayStructure.totalStartAt).getTime();
    return safeSegments.map((segment) => {
      const startsAt = cursor;
      cursor += segment.durationMinutes * 60_000;
      return { ...segment, startsAt, endsAt: cursor };
    });
  }, [displayStructure, safeSegments]);
  const currentSegmentTiming = session?.currentSegmentPosition === null || session?.currentSegmentPosition === undefined
    ? null
    : segmentTimings[session.currentSegmentPosition] ?? null;
  const nextSegmentTiming = session?.currentSegmentPosition === null || session?.currentSegmentPosition === undefined
    ? segmentTimings[0] ?? null
    : segmentTimings[session.currentSegmentPosition + 1] ?? null;
  const phaseEndLabel = currentSegmentTiming && displayTask
    ? clock(new Date(currentSegmentTiming.endsAt).toISOString(), displayTask.timeZone)
    : fixedEndLabel;
  const executionStage = ["reminded", "scheduled", "preparing", "armed", "awaiting_late_start", "running"].includes(stage);
  const executionQuote = executionStage && (session?.id || displayTask?.id)
    ? focusQuote(session?.id ?? displayTask!.id, currentSegment?.segmentType === "break")
    : null;
  const startButtonLabel = stage === "awaiting_late_start" ? "现在开始计时" : "我会准时开始";
  function selectWaitingTask(taskId: string) {
    setSelectedId(taskId);
    if (executionStage && session?.taskId !== taskId) setExecutionMinimized(true);
  }
  const waitingTasks = tasks.filter(isFocusStartEligibleTask);
  const currentBreakEndMs = session?.state === "running"
    && currentSegment?.segmentType === "break"
    && session.plannedEndAt
    ? new Date(session.plannedEndAt).getTime()
    : null;
  const nextSequentialTaskId = currentBreakEndMs !== null
    ? waitingTasks
      .filter((task) => task.id !== session?.taskId && task.startAt && new Date(task.startAt).getTime() === currentBreakEndMs)
      .sort((left, right) => {
        const leftStart = left.startAt ? new Date(left.startAt).getTime() : Number.MAX_SAFE_INTEGER;
        const rightStart = right.startAt ? new Date(right.startAt).getTime() : Number.MAX_SAFE_INTEGER;
        return leftStart - rightStart || left.title.localeCompare(right.title, "zh-CN");
      })[0]?.id ?? null
    : null;
  const pendingEvaluationTasks = tasks.filter((task) => task.lifecycleStatus === "awaiting_outcome");
  const displayedWaitingTasks = waitingExpanded ? waitingTasks : waitingTasks.slice(0, 3);
  const displayedPendingTasks = pendingExpanded ? pendingEvaluationTasks : pendingEvaluationTasks.slice(0, 3);
  const evaluationSecondsLeft = evaluationDeadlineMs
    ? Math.max(0, Math.ceil((evaluationDeadlineMs - nowMs) / 1_000))
    : null;

  useEffect(() => {
    const immersive = isWorkspaceCurrent && executionStage;
    if (immersive) document.documentElement.dataset.focusImmersive = "true";
    else delete document.documentElement.dataset.focusImmersive;
    return () => { delete document.documentElement.dataset.focusImmersive; };
  }, [executionStage, isWorkspaceCurrent]);

  useEffect(() => {
    if (!session) {
      previousCueState.current = null;
      previousFlipMinute.current = null;
      return;
    }
    const next = {
      sessionId: session.id,
      state: session.state,
      segmentPosition: session.currentSegmentPosition,
      segmentType: currentSegment?.segmentType ?? null
    };
    const previous = previousCueState.current;
    previousCueState.current = next;
    if (!previous || previous.sessionId !== next.sessionId) return;
    if (previous.state === next.state && previous.segmentPosition === next.segmentPosition) return;
    previousFlipMinute.current = null;
    if (next.state === "ended") void playFocusCue("focusEnd", soundPreferences.focusEnd);
    else if (next.state === "running" && next.segmentType === "break") void playFocusCue("breakStart", soundPreferences.breakStart);
    else if (next.state === "running" && previous.segmentType === "break") void playFocusCue("breakEnd", soundPreferences.breakEnd);
    else if (next.state === "running" && previous.state !== "running") void playFocusCue("focusStart", soundPreferences.focusStart);
  }, [currentSegment?.segmentType, session?.currentSegmentPosition, session?.id, session?.state, soundPreferences]);

  useEffect(() => {
    if (stage !== "running" || !currentSegment) {
      previousFlipMinute.current = null;
      return;
    }
    const minute = Math.ceil(currentSegmentRemaining / 60);
    const previous = previousFlipMinute.current;
    previousFlipMinute.current = minute;
    if (previous !== null && previous !== minute) void playFocusCue("flip", soundPreferences.flip);
  }, [currentSegment?.position, currentSegmentRemaining, soundPreferences.flip, stage]);
  const locksSelectedStructure = Boolean(
    session
    && selected?.id === session.taskId
    && ["preparing", "armed", "awaiting_late_start", "running", "ended"].includes(session.state)
  );
  const stageHeaderLabel = stage === "running"
    ? "正在专注"
    : stage === "awaiting_late_start" || stage === "reminded"
      ? "等待开始"
      : stage === "armed"
        ? "即将开始"
        : stage === "scheduled"
          ? "等待任务时间"
          : stage === "preparing"
            ? "准备开始"
            : stage === "ended"
              ? "记录结果"
              : null;

  useEffect(() => {
    if (!executionStage) setExecutionMinimized(false);
  }, [executionStage]);

  return (
    <section className={`focus-workspace page focus-theme-${focusTheme} ${executionStage ? "focus-workspace-executing" : ""}`} aria-labelledby="focus-title">
      <div className={`focus-stage focus-stage-${stage} focus-scene-${focusScene}`}>
        <DecorativePlant kind="orchid" note="幽兰自守" accent="rain" className="focus-page-plant" />
        <svg className="focus-ink-landscape" viewBox="0 0 1200 760" preserveAspectRatio="none" aria-hidden="true"><path className="focus-mountain-far" d="M-40 558C94 515 169 389 286 426C378 455 406 529 506 486C601 446 638 302 754 338C856 369 902 496 1017 449C1084 421 1140 353 1240 346V760H-40Z"/><path className="focus-mountain-near" d="M-60 644C102 586 188 522 296 552C394 579 442 642 552 593C656 547 739 463 846 508C944 549 1020 628 1260 530V760H-60Z"/><path className="focus-water-line" d="M44 684C248 658 397 690 587 672C781 654 925 681 1154 653"/></svg>
        <div className="focus-mist mist-one" />
        <div className="focus-mist mist-two" />
        <div className="focus-water-ripples" aria-hidden="true"><i/><i/><i/></div>
        <div className="focus-completion-seal" aria-hidden="true"><span>成</span></div>
        <div className="focus-stage-header">
          <button className="back-button" onClick={onBack}>
            <ChevronLeft />
            回到时间轴
          </button>
          {stageHeaderLabel && <span>{stageHeaderLabel}</span>}
        </div>
        <div className={`focus-center ${executionStage ? "focus-center-executing" : ""}`}>
          {executionStage ? executionMinimized ? (
            <div
              className="focus-execution-minimized"
              aria-label="已收起的当前专注计时"
              role="button"
              tabIndex={0}
              onClick={() => void invokeDesktop(
                ["scheduled", "reminded", "preparing", "armed"].includes(stage)
                  ? "focus_preparation_show"
                  : "focus_mini_show",
              )}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  void invokeDesktop(
                    ["scheduled", "reminded", "preparing", "armed"].includes(stage)
                      ? "focus_preparation_show"
                      : "focus_mini_show",
                  );
                }
              }}
            >
              <div className="focus-execution-minimized-copy">
                <span>{stage === "armed" ? "已确认准时开始" : stage === "awaiting_late_start" ? "等待开始" : currentSegment?.segmentType === "break" ? "休息中" : stage === "preparing" ? "准备开始" : "正在专注"}</span>
                <strong>{displayTask?.title ?? "当前任务"}</strong>
                <ThemedFocusTimer
                  theme={focusTheme}
                  value={clockValue}
                  progress={timerProgress}
                  resting={currentSegment?.segmentType === "break"}
                  empty={false}
                  compact
                />
              </div>
              <button type="button" className="focus-execution-quiet" onClick={(event) => { event.stopPropagation(); setExecutionMinimized(false); }}>
                <Maximize2 />展开计时
              </button>
            </div>
          ) : (
            <div className="focus-execution" aria-label="当前专注执行状态">
              <div className="focus-execution-context">
                <span>{stage === "reminded" ? "等待确认" : stage === "scheduled" ? "等待准备" : stage === "preparing" ? "准备" : stage === "armed" ? "已确认准时开始" : stage === "awaiting_late_start" ? "等待开始" : currentSegment?.segmentType === "break" ? "休息" : "正在专注"}</span>
                <h1 id="focus-title">{displayTask?.title ?? "留在此刻"}</h1>
              </div>
              <div
                className={`focus-timepiece focus-timepiece-execution ${stage === "running" ? "running" : ""} ${currentSegment?.segmentType === "break" ? "resting" : ""}`}
                role="button"
                tabIndex={0}
                title="重新打开当前专注窗口"
                onClick={() => void invokeDesktop(
                  ["scheduled", "reminded", "preparing", "armed"].includes(stage)
                    ? "focus_preparation_show"
                    : "focus_mini_show",
                )}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    void invokeDesktop(
                      ["scheduled", "reminded", "preparing", "armed"].includes(stage)
                        ? "focus_preparation_show"
                        : "focus_mini_show",
                    );
                  }
                }}
              >
                <span className="focus-timepiece-label">{stage === "reminded" ? "等待开始" : stage === "scheduled" ? "距离准备" : stage === "armed" ? "距离开始" : stage === "awaiting_late_start" ? "可用余时" : currentSegment?.segmentType === "break" ? "休息余时" : stage === "preparing" ? "准备倒计时" : "专注余时"}</span>
                <ThemedFocusTimer theme={focusTheme} value={clockValue} progress={timerProgress} resting={currentSegment?.segmentType === "break"} empty={false} />
              </div>
              {executionQuote ? <p className="focus-workspace-quote"><q>{executionQuote.text}</q><cite>{executionQuote.source}</cite></p> : null}
              <p className="focus-phase-line">
                {stage === "reminded"
                  ? "确认后会在原定时间准时进入专注计时"
                  : stage === "scheduled"
                    ? `将在 ${displayTask?.startAt ? clock(displayTask.startAt, displayTask.timeZone) : "任务时间"} 前 1 分钟进入准备`
                  : stage === "preparing"
                  ? "点击“我会准时开始”后，倒计时结束时自动进入专注计时"
                  : stage === "armed"
                    ? "已确认会在原定时间开始；到点自动进入专注计时"
                  : stage === "awaiting_late_start"
                    ? "已错过原定开始时间；点击“现在开始计时”只记录实际时长"
                  : `${currentSegment?.segmentType === "break" ? "休息" : "专注"}${phaseEndLabel ? `至 ${phaseEndLabel}` : ""}`}
              </p>
              <p className="focus-next-phase">
                {stage === "reminded"
                  ? "确认后不再需要重复点击，正式计时从原定开始时间进入"
                  : stage === "scheduled"
                    ? "准备阶段会出现“我会准时开始”确认"
                  : stage === "preparing"
                  ? "未确认会进入等待开始，并记为未完成；确认后到点自动开始"
                  : stage === "armed"
                    ? "正式开始后不可暂停或取消"
                  : stage === "awaiting_late_start"
                    ? "截止时间前仍可开始；未开始将记为未完成"
                  : nextSegmentTiming
                    ? `随后${nextSegmentTiming.segmentType === "break" ? `休息 ${nextSegmentTiming.durationMinutes} 分钟` : `专注 ${nextSegmentTiming.durationMinutes} 分钟`}`
                    : "这是本次安排的最后一段"}
              </p>

              <div className="focus-execution-actions">
                <button className="focus-execution-quiet" disabled={busy} onClick={() => setExecutionMinimized(true)}><Minimize2 />收起计时</button>
                {stage === "reminded" || stage === "scheduled" || stage === "preparing" || stage === "awaiting_late_start" ? (
                  <>
                    <button className="focus-execution-primary" disabled={busy} onClick={() => void transition(stage === "reminded" ? "respond-start" : "skip-preparation")}><Play />{startButtonLabel}</button>
                    <button className="focus-execution-quiet" disabled={busy} onClick={() => void transition("other-arrangement")}><PencilLine />另有安排</button>
                    <button className="focus-execution-danger" disabled={busy} onClick={() => void transition("cancel-task")}><XCircle />取消任务</button>
                  </>
                ) : stage === "armed" ? (
                  <span className="focus-execution-locked">已确认准时开始，等待原定时间自动计时</span>
                ) : (
                  isFinalBreak
                    ? <button className="focus-execution-quiet" disabled={busy} onClick={() => void transition("skip-final-break")}><CheckCircle2 />跳过最后休息并记录</button>
                    : <span className="focus-execution-locked">专注进行中，不可暂停或提前结束</span>
                )}
              </div>

              {displayStructure && (
                <div className="focus-execution-disclosure">
                  <button type="button" aria-expanded={arrangementOpen} onClick={() => { setArrangementOpen((value) => !value); setEditArrangementOpen(false); }}><Eye />查看专注安排</button>
                  {stage !== "running" ? <button type="button" aria-expanded={editArrangementOpen} onClick={() => { setEditArrangementOpen((value) => !value); setArrangementOpen(false); }}><PencilLine />编辑安排</button> : null}
                </div>
              )}
              {arrangementOpen && displayStructure && (
                <aside className="focus-arrangement-sheet" aria-label="完整专注安排">
                  {segmentTimings.map((segment) => <div className={segment.position === session?.currentSegmentPosition ? "current" : ""} key={segment.position}><span>{clock(new Date(segment.startsAt).toISOString(), displayTask?.timeZone ?? "Asia/Shanghai")}–{clock(new Date(segment.endsAt).toISOString(), displayTask?.timeZone ?? "Asia/Shanghai")}</span><strong>{segment.segmentType === "break" ? "休息" : "专注"}</strong><small>{segment.durationMinutes} 分钟</small></div>)}
                </aside>
              )}
              {editArrangementOpen && displayTask && (
                <aside className="focus-arrangement-edit" aria-label="编辑专注安排确认">
                  <p>正式开始前可以退回计划调整；开始后结构锁定且不可修改。</p>
                  <button type="button" disabled={busy} onClick={() => void transition("other-arrangement")}><PencilLine />退回计划调整</button>
                </aside>
              )}
            </div>
          ) : (
            <>
              <p className="section-kicker">当前意图</p>
              <h1 id="focus-title">{displayTask?.title ?? "选择一件任务，留在此刻"}</h1>
              <p className="focus-meta">{displayTask ? displayTask.startAt && displayTask.endAt ? `${clock(displayTask.startAt, displayTask.timeZone)}–${clock(displayTask.endAt, displayTask.timeZone)} · ${selectedMinutes} 分钟固定时间块` : "这项任务尚未设置精确起止时间" : "从今日时间轴或右侧列表选择任务"}</p>
              <div className={`focus-timepiece ${currentSegment?.segmentType === "break" ? "resting" : ""}`}>
                <span className="focus-timepiece-label">专注余时</span>
                <ThemedFocusTimer theme={focusTheme} value={clockValue} progress={timerProgress} resting={currentSegment?.segmentType === "break"} empty={!displayTask} />
                <small>{fixedEndLabel ? `固定结束于 ${fixedEndLabel}` : "选择任务后显示固定结束时间。"}</small>
              </div>
              {selected?.scheduleKind === "exact" && selected.startAt && selected.endAt && !locksSelectedStructure && (loadedStructureKey !== structureKey ? <p className="focus-structure-loading">正在恢复已保存的专注结构…</p> : <FocusStructureEditor task={{ id: selected.id, startAt: selected.startAt, endAt: selected.endAt, timeZone: selected.timeZone }} active={activeStructure} candidate={candidateStructure} busy={busy} onSave={saveStructure} onPlanAi={planAiStructure} onConfirm={confirmStructure} onConfirmDraft={confirmStructureDraft} onDiscard={discardCandidate} />)}
              <div className="focus-controls">
                {stage === "idle" && <button className="focus-main-action" disabled={!isFocusStartEligibleTask(selected) || busy || !activeStructure} onClick={() => void begin()}><Play />{selected && !activeStructure ? "先确认专注结构" : "我会准时开始"}</button>}
              </div>
            </>
          )}
          {executionStage && executionMinimized && !selectedIsSessionTask && selected?.scheduleKind === "exact" && selected.startAt && selected.endAt && (
            <section className="focus-secondary-editor" aria-label="调整其他任务的专注结构">
              <div className="focus-secondary-editor-heading">
                <span className="section-kicker">调整另一项任务</span>
                <strong>{selected.title}</strong>
                <small>{clock(selected.startAt, selected.timeZone)}–{clock(selected.endAt, selected.timeZone)}</small>
              </div>
              {loadedStructureKey !== structureKey
                ? <p className="focus-structure-loading">正在恢复已保存的专注结构…</p>
                : <FocusStructureEditor task={{ id: selected.id, startAt: selected.startAt, endAt: selected.endAt, timeZone: selected.timeZone }} active={activeStructure} candidate={candidateStructure} busy={busy} onSave={saveStructure} onPlanAi={planAiStructure} onConfirm={confirmStructure} onConfirmDraft={confirmStructureDraft} onDiscard={discardCandidate} />}
              <div className="focus-secondary-actions">
                {selected.id === nextSequentialTaskId
                  ? <button type="button" className="focus-execution-primary" disabled={busy || !activeStructure} onClick={() => void armSelectedDuringExecution()}><Play />我会准时开始</button>
                  : <p className="focus-secondary-editor-note">当前执行期间只能提前确认紧接着的下一项任务。</p>}
              </div>
            </section>
          )}
        </div>
        {(stage === "stopped_for_change" || stage === "stopped_no_response") && (
          <p className="focus-stopped">{session?.stoppedReason ?? "这次提醒已停止。"}，任务仍保留在你的安排中。</p>
        )}
      </div>
      <aside className="focus-picker focus-picker-split" aria-label="今日专注任务">
        <section className="focus-picker-section" aria-labelledby="waiting-focus-heading">
          <div className="focus-picker-heading"><p className="section-kicker" id="waiting-focus-heading">等待专注的任务</p><span>{waitingTasks.length} 项</span></div>
          <div className="focus-task-slips">
            {displayedWaitingTasks.length === 0 ? <p>今天没有等待专注的已排期任务。</p> : displayedWaitingTasks.map((task) => (
              <button type="button" className={`focus-task-slip ${task.id === selected?.id ? "selected" : ""}`} aria-pressed={task.id === selected?.id} onClick={() => selectWaitingTask(task.id)} key={task.id}>
                <span>待开始</span>
                <strong>{task.title}</strong>
                <small className="focus-task-slip-schedule">{taskScheduleLabel(task)}</small>
              </button>
            ))}
          </div>
          {waitingTasks.length > 3 && <button className="focus-picker-toggle" type="button" onClick={() => setWaitingExpanded((value) => !value)}>{waitingExpanded ? "收起等待任务" : `查看其他 ${waitingTasks.length - 3} 项`}<ChevronDown className={waitingExpanded ? "expanded" : ""} /></button>}
        </section>
        <section className="focus-picker-section pending" aria-labelledby="pending-evaluation-heading">
          <div className="focus-picker-heading"><p className="section-kicker" id="pending-evaluation-heading">没有完成评价的任务</p><span>{pendingEvaluationTasks.length} 项</span></div>
          <div className="focus-task-slips">
            {displayedPendingTasks.length === 0 ? <p>目前没有待评价任务。</p> : displayedPendingTasks.map((task) => (
              <button className="focus-task-slip pending" disabled={busy} onClick={() => void openPendingEvaluation(task)} key={task.id}>
                <span>待评价</span>
                <strong>{task.title}</strong>
                <small className="focus-task-slip-schedule">{taskScheduleLabel(task)}</small>
                <small>打开对应主题评价</small>
              </button>
            ))}
          </div>
          {pendingEvaluationTasks.length > 3 && <button className="focus-picker-toggle" type="button" onClick={() => setPendingExpanded((value) => !value)}>{pendingExpanded ? "收起待评价任务" : `查看其他 ${pendingEvaluationTasks.length - 3} 项`}<ChevronDown className={pendingExpanded ? "expanded" : ""} /></button>}
        </section>
      </aside>
      {evaluationSession && evaluationTask ? <div className="task-dialog-backdrop focus-evaluation-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) { window.localStorage.setItem(`personal-ai.focus-evaluation-dismissed.${evaluationSession.id}`, "1"); evaluationIdentityRef.current = null; if (evaluationTimerRef.current) window.clearTimeout(evaluationTimerRef.current); evaluationTimerRef.current = null; setEvaluationSession(null); setEvaluationTask(null); setEvaluationDeadlineMs(null); } }}>
        <section className={`themed-outcome-dialog focus-page-evaluation-dialog focus-theme-${focusTheme}`} role="dialog" aria-modal="true" aria-labelledby="focus-page-evaluation-title">
          <header className="themed-outcome-titlebar"><span>评价任务：{evaluationTask.title}</span><button type="button" aria-label="关闭评价" onClick={() => { window.localStorage.setItem(`personal-ai.focus-evaluation-dismissed.${evaluationSession.id}`, "1"); evaluationIdentityRef.current = null; if (evaluationTimerRef.current) window.clearTimeout(evaluationTimerRef.current); evaluationTimerRef.current = null; setEvaluationSession(null); setEvaluationTask(null); setEvaluationDeadlineMs(null); }}><X /></button></header>
          <div className="themed-outcome-body" onFocusCapture={markEvaluationInteraction} onScrollCapture={markEvaluationInteraction}>
            {evaluationSecondsLeft !== null ? <p className="focus-evaluation-timeout" role="status">无操作，{evaluationSecondsLeft} 秒后自动关闭并保留为待评价</p> : null}
            {focusTheme === "cyber" ? <CyberFocusEvaluation taskTitle={evaluationTask.title} outcome={outcome} progress={progress} satisfaction={satisfaction} note={note} busy={busy} error={error} onOutcomeChange={chooseOutcome} onProgressChange={(value) => { markEvaluationInteraction(); setProgress(value); }} onSatisfactionChange={(value) => { markEvaluationInteraction(); setSatisfaction(value); }} onNoteChange={(value) => { markEvaluationInteraction(); setNote(value); }} onSubmit={() => void evaluate()} /> : <FocusEvaluationForm headingId="focus-page-evaluation-title" taskTitle={evaluationTask.title} outcome={outcome} progress={progress} satisfaction={satisfaction} note={note} busy={busy} error={error} onOutcomeChange={chooseOutcome} onProgressChange={(value) => { markEvaluationInteraction(); setProgress(value); }} onSatisfactionChange={(value) => { markEvaluationInteraction(); setSatisfaction(value); }} onNoteChange={(value) => { markEvaluationInteraction(); setNote(value); }} onSubmit={() => void evaluate()} />}
          </div>
        </section>
      </div> : null}
      {error && (
        <div className="focus-error" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}
