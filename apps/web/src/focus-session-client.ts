export type FocusSessionState =
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

export type FocusSessionSnapshot = {
  serverNow: string;
  serverNowEpochMs: number;
  session: {
    id: string;
    taskId: string;
    state: FocusSessionState;
    version: number;
    plannedStartAt: string | null;
    plannedEndAt: string | null;
    pausedAt: string | null;
    endedAt: string | null;
    rawActiveSeconds: number;
  };
  task: {
    id: string;
    title: string;
    timeZone: string;
    startAt: string | null;
    endAt: string | null;
  };
  phase: "scheduled" | "reminder" | "preparation" | "armed" | "awaiting_late_start" | "focus" | "break" | "ended";
  phaseStartedAt: string | null;
  phaseEndsAt: string | null;
  phaseEndsAtEpochMs: number | null;
  sessionEndsAt: string | null;
  sessionEndsAtEpochMs: number | null;
  currentSegment: FocusSnapshotSegment | null;
  nextSegment: FocusSnapshotSegment | null;
  segments: FocusSnapshotSegment[];
};

export type FocusSnapshotSegment = {
  position: number;
  segmentType: "focus" | "break";
  durationMinutes: number;
  startsAt: string;
  endsAt: string;
};

export type FocusSnapshotResponse = {
  session: FocusSessionSnapshot["session"] | null;
  snapshot: FocusSessionSnapshot | null;
};

const SNAPSHOT_STATES = new Set<FocusSessionState>([
  "scheduled", "reminded", "preparing", "armed", "awaiting_late_start",
  "running", "paused", "ended", "evaluated", "stopped_no_response", "stopped_for_change",
]);
const SNAPSHOT_PHASES = new Set<FocusSessionSnapshot["phase"]>([
  "scheduled", "reminder", "preparation", "armed", "awaiting_late_start", "focus", "break", "ended",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function safeTimeZone(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "Asia/Shanghai";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return value;
  } catch {
    return "Asia/Shanghai";
  }
}

function normalizeSnapshotSegment(value: unknown): FocusSnapshotSegment | null {
  if (!isRecord(value)) return null;
  const position = Number(value.position);
  const durationMinutes = Number(value.durationMinutes);
  const segmentType = value.segmentType === "focus" || value.segmentType === "break" ? value.segmentType : null;
  if (!segmentType || !Number.isInteger(position) || position < 0 || !Number.isFinite(durationMinutes) || durationMinutes <= 0) return null;
  const startsAt = nullableString(value.startsAt);
  const endsAt = nullableString(value.endsAt);
  if (!startsAt || !endsAt) return null;
  return { position, segmentType, durationMinutes, startsAt, endsAt };
}

function normalizeSnapshot(value: unknown): FocusSessionSnapshot | null {
  if (!isRecord(value) || !isRecord(value.session) || !isRecord(value.task)) return null;
  const sessionState = value.session.state;
  const phase = value.phase;
  if (typeof value.session.id !== "string" || typeof value.session.taskId !== "string" || !SNAPSHOT_STATES.has(sessionState as FocusSessionState)) return null;
  if (!SNAPSHOT_PHASES.has(phase as FocusSessionSnapshot["phase"])) return null;
  const segments = Array.isArray(value.segments)
    ? value.segments.map(normalizeSnapshotSegment).filter((segment): segment is FocusSnapshotSegment => Boolean(segment))
    : [];
  const currentSegment = normalizeSnapshotSegment(value.currentSegment);
  const nextSegment = normalizeSnapshotSegment(value.nextSegment);
  return {
    serverNow: typeof value.serverNow === "string" ? value.serverNow : new Date().toISOString(),
    serverNowEpochMs: Number.isFinite(Number(value.serverNowEpochMs)) ? Number(value.serverNowEpochMs) : Date.now(),
    session: {
      id: value.session.id,
      taskId: value.session.taskId,
      state: sessionState as FocusSessionState,
      version: Number.isInteger(Number(value.session.version)) && Number(value.session.version) > 0 ? Number(value.session.version) : 1,
      plannedStartAt: nullableString(value.session.plannedStartAt),
      plannedEndAt: nullableString(value.session.plannedEndAt),
      pausedAt: nullableString(value.session.pausedAt),
      endedAt: nullableString(value.session.endedAt),
      rawActiveSeconds: Math.max(0, Number(value.session.rawActiveSeconds) || 0),
    },
    task: {
      id: value.task.id as string,
      title: typeof value.task.title === "string" && value.task.title.trim() ? value.task.title : "未命名任务",
      timeZone: safeTimeZone(value.task.timeZone),
      startAt: nullableString(value.task.startAt),
      endAt: nullableString(value.task.endAt),
    },
    phase: phase as FocusSessionSnapshot["phase"],
    phaseStartedAt: nullableString(value.phaseStartedAt),
    phaseEndsAt: nullableString(value.phaseEndsAt),
    phaseEndsAtEpochMs: Number.isFinite(Number(value.phaseEndsAtEpochMs)) ? Number(value.phaseEndsAtEpochMs) : null,
    sessionEndsAt: nullableString(value.sessionEndsAt),
    sessionEndsAtEpochMs: Number.isFinite(Number(value.sessionEndsAtEpochMs)) ? Number(value.sessionEndsAtEpochMs) : null,
    currentSegment,
    nextSegment,
    segments,
  };
}

export type FocusMiniPositionMode = "bottom_right" | "center" | "custom";

export type FocusMiniSettings = {
  x: number | null;
  y: number | null;
  positionMode: FocusMiniPositionMode;
  alwaysOnTop: boolean;
  locked: boolean;
  autoShow: boolean;
  notifyStart: boolean;
  notifyPhaseChange: boolean;
  notifyComplete: boolean;
};

export type FocusEvaluationPayload = {
  outcome: "not_completed" | "partial" | "complete";
  progressPercent: number;
  satisfaction: "satisfied" | "neutral" | "dissatisfied";
  note: string | null;
};

const API = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3000";

export async function loadFocusSnapshot(
  signal?: AbortSignal,
  surface: "current" | "execution" | "evaluation" | "preparation" = "current",
): Promise<FocusSessionSnapshot | null> {
  const path = surface === "execution"
    ? "/api/v1/focus-sessions/current-execution"
    : surface === "evaluation"
      ? "/api/v1/focus-sessions/pending-evaluation"
      : surface === "preparation"
        ? "/api/v1/focus-sessions/overlapping-preparation"
      : "/api/v1/focus-sessions/current";
  const response = await fetch(`${API}${path}`, { signal });
  if (!response.ok) throw new Error("focus_snapshot_unavailable");
  const payload = (await response.json()) as FocusSnapshotResponse;
  return payload.snapshot ? normalizeSnapshot(payload.snapshot) : null;
}

export async function runFocusSessionAction(
  snapshot: FocusSessionSnapshot,
  action: "skip-preparation" | "skip-final-break" | "other-arrangement",
  surface: "current" | "execution" | "evaluation" | "preparation" = "current",
): Promise<FocusSessionSnapshot | null> {
  const response = await fetch(`${API}/api/v1/focus-sessions/${snapshot.session.id}/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      expectedVersion: snapshot.session.version,
      ...(action === "other-arrangement" ? { reason: "用户选择另有安排" } : {}),
    }),
  });
  if (!response.ok) throw new Error("focus_action_failed");
  return loadFocusSnapshot(undefined, surface);
}

export async function resolveFocusPreparationDecision(
  snapshot: FocusSessionSnapshot,
  decision: "other-arrangement" | "cancel-task",
): Promise<void> {
  const response = await fetch(`${API}/api/v1/focus-sessions/${snapshot.session.id}/resolve-preparation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      expectedVersion: snapshot.session.version,
      commandId: crypto.randomUUID(),
      decision: decision === "cancel-task" ? "cancel_task" : "other_arrangement",
      reason: decision === "cancel-task" ? "用户从准备窗口取消任务" : "用户从准备窗口选择另有安排",
    }),
  });
  if (!response.ok) throw new Error("focus_preparation_decision_failed");
}

export async function evaluateFocusSession(
  snapshot: FocusSessionSnapshot,
  evaluation: FocusEvaluationPayload,
): Promise<void> {
  const response = await fetch(`${API}/api/v1/focus-sessions/${snapshot.session.id}/evaluate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      expectedVersion: snapshot.session.version,
      commandId: crypto.randomUUID(),
      ...evaluation,
    }),
  });
  if (!response.ok) throw new Error("focus_evaluation_failed");
}

export function focusRemainingSeconds(snapshot: FocusSessionSnapshot, nowMs: number): number {
  if (!snapshot.phaseEndsAtEpochMs) return 0;
  return Math.max(0, Math.ceil((snapshot.phaseEndsAtEpochMs - nowMs) / 1000));
}

export function focusPhaseProgress(snapshot: FocusSessionSnapshot, nowMs: number): number {
  if (!snapshot.phaseStartedAt || !snapshot.phaseEndsAtEpochMs) return 0;
  const start = new Date(snapshot.phaseStartedAt).getTime();
  const total = snapshot.phaseEndsAtEpochMs - start;
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, ((nowMs - start) / total) * 100));
}

export function invokeDesktop<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const internals = (window as Window & {
    __TAURI_INTERNALS__?: { invoke: (command: string, args?: Record<string, unknown>) => Promise<T> };
  }).__TAURI_INTERNALS__;
  if (!internals) return Promise.reject(new Error("desktop_runtime_unavailable"));
  return internals.invoke(command, args);
}
