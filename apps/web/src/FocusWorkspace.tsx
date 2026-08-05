import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  CheckCircle2,
  ChevronLeft,
  CircleDashed,
  Clock3,
  Compass,
  Play,
  Sparkles,
  XCircle,
} from "lucide-react";
import { FocusStructureEditor, type FocusStructureRecord } from "./FocusStructureEditor";
import { getFocusGuidance } from "./focus-guidance";
import type { FocusSegment } from "@personal-ai/domain/focus";

type Task = {
  id: string;
  title: string;
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
  | "running"
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
  rawActiveSeconds: number;
  effectiveFocusSeconds: number;
  focusStructureId: string | null;
  currentSegmentPosition: number | null;
  currentSegmentStartedAt: string | null;
  currentSegmentElapsedSeconds: number;
  version: number;
  stoppedReason: string | null;
};
type Outcome = "not_completed" | "partial" | "complete";
type Satisfaction = "satisfied" | "neutral" | "dissatisfied";

const API = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3000";
const nowDate = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
const time = (seconds: number) =>
  `${String(Math.floor(Math.max(0, seconds) / 60)).padStart(2, "0")}:${String(Math.max(0, seconds) % 60).padStart(2, "0")}`;
const clock = (value: string, timeZone: string) => new Intl.DateTimeFormat("zh-CN", {
  timeZone, hour: "2-digit", minute: "2-digit", hour12: false
}).format(new Date(value));

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

export function FocusWorkspace({
  preferredTaskId,
  onBack,
  onPlanChange,
  onPreferredTaskReady,
}: {
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
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>("complete");
  const [progress, setProgress] = useState("100");
  const [satisfaction, setSatisfaction] = useState<Satisfaction>("satisfied");
  const [note, setNote] = useState("");
  const load = useCallback(async () => {
    const [list, current] = await Promise.all([
      request<{ tasks: Task[] }>(`/api/v1/tasks?date=${nowDate()}`),
      request<{ session: Session | null }>("/api/v1/focus-sessions/current")
    ]);
    const additionalTaskIds = [...new Set([
      current.session?.taskId,
      preferredTaskId
    ].filter((id): id is string => Boolean(id)))];
    const additionalTasks = await Promise.all(additionalTaskIds.map((id) =>
      request<{ task: Task }>(`/api/v1/tasks/${id}`)
        .then((result) => result.task)
        .catch(() => null)
    ));
    const visible = list.tasks.filter(
        (task) =>
          task.lifecycleStatus !== "closed" &&
          task.lifecycleStatus !== "cancelled",
      );
    for (const task of additionalTasks) {
      if (task && !visible.some((visibleTask) => visibleTask.id === task.id)) visible.push(task);
    }
    setTasks(visible);
    setSession(current.session);
    setSelectedId((currentId) => currentId ?? current.session?.taskId ?? visible[0]?.id ?? null);
  }, [preferredTaskId]);
  useEffect(() => {
    void load().catch(() =>
      setError("无法恢复专注会话，请确认 API 正在运行。"),
    );
  }, [load]);
  useEffect(() => {
    if (preferredTaskId) setSelectedId(preferredTaskId);
  }, [preferredTaskId]);
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
        const current = result.focusStructures.filter((item) =>
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
        if (!cancelled) setSessionStructure(result.focusStructures.find((item) => item.id === session.focusStructureId) ?? null);
      })
      .catch(() => { if (!cancelled) setSessionStructure(null); });
    return () => { cancelled = true; };
  }, [session?.focusStructureId, session?.taskId]);
  useEffect(() => {
    if (!session) return;
    const update = () => {
      if (session.state === "running" && session.activeSinceAt)
        setElapsed(
          session.rawActiveSeconds +
            Math.max(
              0,
              Math.floor(
                (Date.now() - new Date(session.activeSinceAt).getTime()) / 1000,
              ),
            ),
        );
      else setElapsed(session.rawActiveSeconds);
    };
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [session]);
  useEffect(() => {
    if (!session || session.state !== "preparing" || !session.preparingEndsAt)
      return;
    const left = new Date(session.preparingEndsAt).getTime() - Date.now();
    if (left <= 0) {
      void transition("begin");
      return;
    }
    const timer = window.setTimeout(() => void transition("begin"), left + 30);
    return () => window.clearTimeout(timer);
  }, [session]);
  useEffect(() => {
    if (session?.state !== "reminded" && session?.state !== "scheduled" && session?.state !== "running") return;
    const timer = window.setInterval(() => void load().catch(() => undefined), 15_000);
    return () => window.clearInterval(timer);
  }, [load, session?.state]);
  useEffect(() => {
    if (session?.state !== "scheduled" || !session.plannedStartAt) return;
    const left = Math.max(0, new Date(session.plannedStartAt).getTime() - Date.now());
    const timer = window.setTimeout(() => void load().catch(() => undefined), left + 50);
    return () => window.clearTimeout(timer);
  }, [load, session?.plannedStartAt, session?.state]);
  useEffect(() => {
    if (session) return;
    const now = Date.now();
    const candidate = tasks
      .filter((task) => task.lifecycleStatus === "open" && task.startAt)
      .sort((left, right) => (left.startAt ?? "").localeCompare(right.startAt ?? ""))
      .find((task) => {
        const delta = new Date(task.startAt!).getTime() - now;
        return delta >= 0 && delta <= 15 * 60_000;
      });
    if (!candidate) return;
    let cancelled = false;
    void request<{ session: Session }>("/api/v1/focus-sessions", "POST", {
      taskId: candidate.id,
      expectedTaskVersion: candidate.version,
      mode: "remind"
    }).then((result) => { if (!cancelled) setSession(result.session); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [session, tasks]);

  async function saveStructure(segments: FocusSegment[], source: "manual" | "template"): Promise<void> {
    if (!selected || selected.scheduleKind !== "exact" || !selected.startAt || !selected.endAt) return;
    setBusy(true);
    setError(null);
    try {
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
      setCandidateStructure(candidate.focusStructure);
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
      setCandidateStructure(candidate.focusStructure);
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
      setActiveStructure(confirmed.focusStructure);
      setCandidateStructure(null);
    } catch (error: any) {
      setError(error.body?.error?.includes("conflict")
        ? "候选或任务已在其他位置更新，请刷新后重新确认。"
        : "候选结构没有确认，请重试。");
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
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      if (selected.scheduleKind === "exact" && !activeStructure) {
        setError("请先保存候选并明确确认专注结构。");
        return;
      }
      const result = await request<{ session: Session }>(
        "/api/v1/focus-sessions",
        "POST",
        { taskId: selected.id, expectedTaskVersion: selected.version, mode },
      );
      setSession(result.session);
      await load();
    } catch (error: any) {
      setError(
        error.body?.error === "focus_session_already_active"
          ? "已有一段专注正在进行。"
          : "无法开始专注，请刷新后重试。",
      );
    } finally {
      setBusy(false);
    }
  }
  async function transition(
    action:
      | "begin"
      | "end"
      | "skip-preparation"
      | "skip-final-break"
      | "other-arrangement"
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
          { expectedVersion: session.version, decision: "start" },
        );
      else if (action === "other-arrangement")
        result = await request(
          `/api/v1/focus-sessions/${session.id}/respond`,
          "POST",
          { expectedVersion: session.version, decision: "other_arrangement" },
        );
      else
        result = await request(
          `/api/v1/focus-sessions/${session.id}/${action}`,
          "POST",
          { expectedVersion: session.version },
        );
      setSession(result.session);
      await load();
      if (action === "other-arrangement") {
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
  function chooseOutcome(value: Outcome) {
    setOutcome(value);
    setProgress(
      value === "complete" ? "100" : value === "not_completed" ? "0" : "50",
    );
  }
  async function evaluate() {
    if (!session) return;
    const value = Number(progress);
    if (
      (outcome === "complete" && value !== 100) ||
      (outcome === "not_completed" && value !== 0) ||
      (outcome === "partial" && (value < 1 || value > 99))
    ) {
      setError("请填写与完成情况一致的客观进度。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await request(`/api/v1/focus-sessions/${session.id}/evaluate`, "POST", {
        expectedVersion: session.version,
        outcome,
        progressPercent: value,
        satisfaction,
        note: note.trim() || null,
      });
      setSession(null);
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
  const displayStructure = session ? sessionStructure : activeStructure;
  const prepLeft = session?.preparingEndsAt
    ? Math.ceil(
        Math.max(0, new Date(session.preparingEndsAt).getTime() - Date.now()) /
          1000,
      )
    : 0;
  const scheduledLeft = session?.state === "scheduled" && session.plannedStartAt
    ? Math.ceil(Math.max(0, new Date(session.plannedStartAt).getTime() - Date.now()) / 1000)
    : 0;
  const selectedMinutes = displayTask?.startAt && displayTask.endAt
    ? Math.round((new Date(displayTask.endAt).getTime() - new Date(displayTask.startAt).getTime()) / 60_000)
    : null;
  const currentSegment = displayStructure && session && session.currentSegmentPosition !== null
    ? displayStructure.segments[session.currentSegmentPosition] ?? null
    : null;
  const currentSegmentElapsed = stage === "running" && session?.currentSegmentStartedAt
    ? Math.max(0, Math.floor((Date.now() - new Date(session.currentSegmentStartedAt).getTime()) / 1000))
    : session?.currentSegmentElapsedSeconds ?? 0;
  const currentSegmentRemaining = currentSegment
    ? Math.max(0, currentSegment.durationMinutes * 60 - currentSegmentElapsed)
    : 0;
  const timerTotal = stage === "preparing"
    ? 60
    : stage === "scheduled"
      ? Math.max(1, scheduledLeft)
      : currentSegment
        ? currentSegment.durationMinutes * 60
        : Math.max(1, (selectedMinutes ?? 0) * 60);
  const timerElapsed = stage === "preparing"
    ? 60 - prepLeft
    : stage === "scheduled"
      ? 0
      : currentSegment
        ? timerTotal - currentSegmentRemaining
        : elapsed;
  const isFinalBreak = stage === "running"
    && currentSegment?.segmentType === "break"
    && session?.currentSegmentPosition === (displayStructure?.segments.length ?? 0) - 1;
  const locksSelectedStructure = Boolean(
    session
    && selected?.id === session.taskId
    && ["preparing", "running", "ended"].includes(session.state)
  );
  const guidance = useMemo(
    () => displayTask ? getFocusGuidance({ id: displayTask.id, title: displayTask.title }) : null,
    [displayTask?.id, displayTask?.title],
  );
  const showsGuidance = Boolean(
    guidance
    && session
    && ["reminded", "scheduled", "preparing", "running"].includes(stage)
    && currentSegment?.segmentType !== "break",
  );
  return (
    <section className="focus-workspace page" aria-labelledby="focus-title">
      <div className="focus-stage">
        <div className="focus-orbit orbit-one" />
        <div className="focus-orbit orbit-two" />
        <div className="focus-stage-header">
          <button className="back-button" onClick={onBack}>
            <ChevronLeft />
            回到时间轴
          </button>
          <span>
            {stage === "running"
              ? "正在专注"
              : stage === "scheduled"
                ? "等待任务时间"
              : stage === "preparing"
                  ? "准备开始"
                  : stage === "ended"
                    ? "记录结果"
                    : "专注一件事"}
          </span>
        </div>
        <div className="focus-center">
          <p className="section-kicker">当前意图</p>
          <h1 id="focus-title">
            {displayTask?.title ?? "选择一件任务，留在此刻"}
          </h1>
          <p className="focus-meta">
            {displayTask
              ? displayTask.startAt && displayTask.endAt
                ? `${clock(displayTask.startAt, displayTask.timeZone)}–${clock(displayTask.endAt, displayTask.timeZone)} · ${selectedMinutes} 分钟固定时间块`
                : "这项任务尚未设置精确起止时间"
              : "从今日时间轴或右侧列表选择任务"}
          </p>
          {session && displayStructure && session.currentSegmentPosition !== null && (
            <p className="focus-segment-status">
              第 {session.currentSegmentPosition + 1} 段 · {currentSegment?.segmentType === "break" ? "休息" : "专注"}
              {isFinalBreak ? " · 最后一次休息" : ""}
            </p>
          )}
          <div
            className={`focus-timer ${stage === "running" ? "running" : ""}`}
          >
            <svg viewBox="0 0 180 180">
              <circle cx="90" cy="90" r="80" />
              <circle
                className="timer-progress"
                cx="90"
                cy="90"
                r="80"
                style={{
                  strokeDashoffset:
                    Math.max(0, 503 - (503 * timerElapsed) / timerTotal),
                }}
              />
            </svg>
            <strong>
              {stage === "preparing"
                ? `00:${String(prepLeft).padStart(2, "0")}`
                : stage === "scheduled"
                  ? time(scheduledLeft)
                : currentSegment
                  ? time(currentSegmentRemaining)
                  : displayTask
                    ? time(elapsed)
                  : "--:--"}
            </strong>
          </div>
          {stage === "preparing" && (
            <div className="focus-reminder">
              <strong>整理桌面，深呼吸一次。倒计时结束后自动开始。</strong>
              <button className="focus-secondary" disabled={busy} onClick={() => void transition("skip-preparation")}>
                <Play />
                跳过准备，立即开始
              </button>
            </div>
          )}
          {stage === "scheduled" && (
            <p className="focus-prep-copy">
              已确认开始。到任务时间后进入 1 分钟准备；准备时可以手动跳过倒计时。
            </p>
          )}
          {stage === "reminded" && (
            <div className="focus-reminder">
              <strong>现在准备开始这项安排吗？</strong>
              <div>
                <button
                  className="primary-button"
                  disabled={busy}
                  onClick={() => void transition("respond-start")}
                >
                  <Play />
                  开始
                </button>
                <button
                  className="focus-secondary"
                  disabled={busy}
                  onClick={() => void transition("other-arrangement")}
                >
                  另有安排
                </button>
              </div>
            </div>
          )}
          {showsGuidance && guidance && (
            <aside className="focus-guidance" aria-label="本次专注提示">
              <article>
                <Compass aria-hidden="true" />
                <div>
                  <span>方法提示 · {guidance.label}</span>
                  <p>{guidance.method}</p>
                </div>
              </article>
              <article>
                <Sparkles aria-hidden="true" />
                <div>
                  <span>一句鼓励</span>
                  <p>{guidance.encouragement}</p>
                </div>
              </article>
            </aside>
          )}
          {selected?.scheduleKind === "exact" && selected.startAt && selected.endAt && !locksSelectedStructure && (
            loadedStructureKey !== structureKey
              ? <p className="focus-structure-loading">正在恢复已保存的专注结构…</p>
              : <FocusStructureEditor
                  task={{ id: selected.id, startAt: selected.startAt, endAt: selected.endAt, timeZone: selected.timeZone }}
                  active={activeStructure}
                  candidate={candidateStructure}
                  busy={busy}
                  onSave={saveStructure}
                  onPlanAi={planAiStructure}
                  onConfirm={confirmStructure}
                  onDiscard={discardCandidate}
                />
          )}
          <div className="focus-controls">
            {stage === "running" && (
              <>
                <button
                  className="focus-main-action"
                  disabled={busy}
                  onClick={() => void transition(isFinalBreak ? "skip-final-break" : "end")}
                >
                  <CheckCircle2 />
                  {isFinalBreak ? "跳过休息并记录" : "结束并记录"}
                </button>
              </>
            )}
            {stage === "idle" && (
              <button
                className="focus-main-action"
                disabled={!selected || busy || (selected.scheduleKind === "exact" && !activeStructure)}
                onClick={() => void begin()}
              >
                <Play />
                {selected?.scheduleKind === "exact" && !activeStructure ? "先确认专注结构" : candidateStructure && activeStructure ? "按已确认结构开始" : "开始专注"}
              </button>
            )}
            {stage === "ended" && (
              <p className="focus-stopped">专注已结束，请记录本次结果。</p>
            )}
          </div>
        </div>
        {(stage === "stopped_for_change" || stage === "stopped_no_response") && (
          <p className="focus-stopped">{session?.stoppedReason ?? "这次提醒已停止。"}，任务仍保留在你的安排中。</p>
        )}
        {stage === "ended" && (
          <section className="focus-evaluation">
            <p className="section-kicker">结束这一段</p>
            <h2>完成情况与体验，都值得被记录。</h2>
            <div className="focus-outcome-options">
              {(["complete", "partial", "not_completed"] as Outcome[]).map(
                (value) => (
                  <button
                    key={value}
                    className={outcome === value ? "selected" : ""}
                    onClick={() => chooseOutcome(value)}
                  >
                    {value === "complete" ? (
                      <CheckCircle2 />
                    ) : value === "partial" ? (
                      <CircleDashed />
                    ) : (
                      <XCircle />
                    )}
                    {value === "complete"
                      ? "完成"
                      : value === "partial"
                        ? "部分完成"
                        : "未完成"}
                  </button>
                ),
              )}
            </div>
            <label>
              客观进度
              <input
                type="number"
                min="0"
                max="100"
                disabled={outcome !== "partial"}
                value={progress}
                onChange={(event) => setProgress(event.target.value)}
              />
              <em>%</em>
            </label>
            <div className="satisfaction-options">
              {(["satisfied", "neutral", "dissatisfied"] as Satisfaction[]).map(
                (value) => (
                  <button
                    key={value}
                    className={satisfaction === value ? "chosen" : ""}
                    onClick={() => setSatisfaction(value)}
                  >
                    {value === "satisfied"
                      ? "满意"
                      : value === "neutral"
                        ? "一般"
                        : "不满意"}
                  </button>
                ),
              )}
            </div>
            <textarea
              aria-label="专注过程备注"
              placeholder="过程反馈（可选）"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={3}
            />
            <button
              className="primary-button"
              disabled={busy}
              onClick={() => void evaluate()}
            >
              <Check />
              保存本次专注
            </button>
          </section>
        )}
      </div>
      <aside className="focus-picker" aria-label="今日任务">
        <p className="section-kicker">今日任务</p>
        <div>
          {tasks.length === 0 ? (
            <p>今天还没有可开始的任务。</p>
          ) : (
            tasks.map((task) => (
              <button
                className={task.id === selected?.id ? "selected" : ""}
                onClick={() => setSelectedId(task.id)}
                key={task.id}
              >
                <span>
                  {task.lifecycleStatus === "awaiting_outcome"
                    ? "待补结果"
                    : task.lifecycleStatus === "active"
                      ? "进行中"
                      : "待开始"}
                </span>
                <strong>{task.title}</strong>
                <small>{task.startAt && task.endAt ? `${clock(task.startAt, task.timeZone)}–${clock(task.endAt, task.timeZone)}` : "未设置精确时间"}</small>
              </button>
            ))
          )}
        </div>
      </aside>
      {error && (
        <div className="focus-error" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}
