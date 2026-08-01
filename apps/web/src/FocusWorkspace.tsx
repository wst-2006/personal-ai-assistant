import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  CheckCircle2,
  ChevronLeft,
  CircleDashed,
  Clock3,
  Play,
  XCircle,
} from "lucide-react";

type Task = {
  id: string;
  title: string;
  lifecycleStatus:
    | "open"
    | "active"
    | "awaiting_outcome"
    | "closed"
    | "cancelled";
  plannedEffortMinutes: number | null;
  difficulty: "low" | "medium" | "high" | null;
  requiresContinuousFocus: boolean | null;
  scheduleKind: "none" | "daypart" | "exact";
  startAt: string | null;
  endAt: string | null;
  scheduleRevision: number;
  version: number;
};
type FocusState =
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
  preparingEndsAt: string | null;
  activeSinceAt: string | null;
  rawActiveSeconds: number;
  effectiveFocusSeconds: number;
  focusStructureId: string | null;
  currentSegmentPosition: number | null;
  currentSegmentElapsedSeconds: number;
  version: number;
  stoppedReason: string | null;
};
type FocusStructure = {
  id: string;
  state: "candidate" | "active" | "superseded" | "invalidated" | "cancelled";
  version: number;
  segments: Array<{ position: number; segmentType: "focus" | "break"; durationMinutes: number }>;
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
const difficulty = { low: "轻量", medium: "适中", high: "深度" };

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
}: {
  preferredTaskId: string | null;
  onBack: () => void;
}) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [activeStructure, setActiveStructure] = useState<FocusStructure | null>(null);
  const [breakMinutes, setBreakMinutes] = useState("5");
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
      request<{ session: Session | null }>("/api/v1/focus-sessions/current"),
    ]);
    setTasks(
      list.tasks.filter(
        (task) =>
          task.lifecycleStatus !== "closed" &&
          task.lifecycleStatus !== "cancelled",
      ),
    );
    setSession(current.session);
    if (current.session) setSelectedId(current.session.taskId);
  }, []);
  useEffect(() => {
    void load().catch(() =>
      setError("无法恢复专注会话，请确认 API 正在运行。"),
    );
  }, [load]);
  const selected = useMemo(
    () =>
      tasks.find((task) => task.id === (session?.taskId ?? selectedId)) ?? null,
    [tasks, session, selectedId],
  );
  useEffect(() => {
    if (!selected || selected.scheduleKind !== "exact") {
      setActiveStructure(null);
      return;
    }
    let cancelled = false;
    void request<{ focusStructures: FocusStructure[] }>(`/api/v1/tasks/${selected.id}/focus-structures`)
      .then((result) => {
        if (!cancelled) setActiveStructure(result.focusStructures.find((item) => item.state === "active") ?? null);
      })
      .catch(() => { if (!cancelled) setActiveStructure(null); });
    return () => { cancelled = true; };
  }, [selected]);
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
    if (session?.state !== "reminded") return;
    const timer = window.setInterval(() => void load().catch(() => undefined), 15_000);
    return () => window.clearInterval(timer);
  }, [load, session?.state]);
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

  async function ensureStructure(task: Task): Promise<void> {
    if (task.scheduleKind !== "exact" || !task.startAt || !task.endAt) return;
    if (activeStructure?.state === "active") return;
    const candidate = await request<{ focusStructure: FocusStructure }>(
      "/api/v1/focus-structures/candidates",
      "POST",
      {
        taskId: task.id,
        taskVersion: task.version,
        taskScheduleRevision: task.scheduleRevision,
        source: "manual",
        mode: "continuous",
        totalStartAt: task.startAt,
        totalEndAt: task.endAt,
        breakMinutes: Number(breakMinutes)
      }
    );
    const confirmed = await request<{ focusStructure: FocusStructure }>(
      `/api/v1/focus-structures/${candidate.focusStructure.id}/confirm`,
      "POST",
      {
        expectedVersion: candidate.focusStructure.version,
        expectedTaskVersion: task.version,
        expectedTaskScheduleRevision: task.scheduleRevision
      }
    );
    setActiveStructure(confirmed.focusStructure);
  }

  async function begin(mode: "prepare" | "remind" = "prepare") {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === "prepare") await ensureStructure(selected);
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
  const prepLeft = session?.preparingEndsAt
    ? Math.ceil(
        Math.max(0, new Date(session.preparingEndsAt).getTime() - Date.now()) /
          1000,
      )
    : 0;
  const selectedMinutes = selected?.startAt && selected.endAt
    ? Math.round((new Date(selected.endAt).getTime() - new Date(selected.startAt).getTime()) / 60_000)
    : null;
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
            {selected?.title ?? "选择一件任务，留在此刻"}
          </h1>
          <p className="focus-meta">
            {selected
              ? `${selected.plannedEffortMinutes ?? 25} 分钟预计投入 · ${difficulty[selected.difficulty ?? "medium"]}${selected.requiresContinuousFocus ? " · 连续专注" : ""}`
              : "从今日时间轴或右侧列表选择任务"}
          </p>
          {session && activeStructure && session.currentSegmentPosition !== null && (
            <p className="focus-segment-status">
              第 {session.currentSegmentPosition + 1} 段 · {activeStructure.segments[session.currentSegmentPosition]?.segmentType === "break" ? "休息" : "专注"}
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
                    stage === "preparing"
                      ? 503 - (503 * (60 - prepLeft)) / 60
                      : selected?.plannedEffortMinutes
                        ? Math.max(
                            0,
                            503 -
                              (503 * elapsed) /
                                (selected.plannedEffortMinutes * 60),
                          )
                        : 503,
                }}
              />
            </svg>
            <strong>
              {stage === "preparing"
                ? `00:${String(prepLeft).padStart(2, "0")}`
                : selected
                  ? time(elapsed)
                  : "--:--"}
            </strong>
          </div>
          {stage === "preparing" && (
            <p className="focus-prep-copy">
              整理桌面，深呼吸一次。倒计时结束后自动开始。
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
          {!session && selected?.scheduleKind === "exact" && !activeStructure && (
            <section className="focus-structure-panel" aria-label="专注结构">
              <p className="section-kicker">先确定执行结构</p>
              <strong>连续专注</strong>
              <p>
                {selectedMinutes !== null && selectedMinutes <= 30
                  ? "30 分钟任务保持连续专注，不插入休息。"
                  : "最后保留一段休息，任务总结束时间不变。"}
              </p>
              {selectedMinutes !== null && selectedMinutes > 30 && (
                <label>
                  末尾休息
                  <input
                    type="number"
                    min="5"
                    max="15"
                    step="1"
                    value={breakMinutes}
                    onChange={(event) => setBreakMinutes(event.target.value)}
                  />
                  <em>分钟</em>
                </label>
              )}
            </section>
          )}
          <div className="focus-controls">
            {stage === "running" && (
              <>
                <button
                  className="focus-main-action"
                  disabled={busy}
                  onClick={() => void transition("end")}
                >
                  <CheckCircle2 />
                  结束并记录
                </button>
              </>
            )}
            {stage === "idle" && (
              <button
                className="focus-main-action"
                disabled={!selected || busy}
                onClick={() => void begin()}
              >
                <Play />
                {selected?.scheduleKind === "exact" && !activeStructure ? "确认结构并开始" : "开始专注"}
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
                disabled={Boolean(session) && task.id !== session?.taskId}
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
                <small>{task.plannedEffortMinutes ?? 30}m</small>
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
