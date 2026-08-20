import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CalendarClock, Lock, Minus, Pin, PinOff, Play, SkipForward, Unlock, X, XCircle } from "lucide-react";
import { formatFocusClock } from "@personal-ai/domain/focus";
import type { FocusTheme } from "@personal-ai/domain/user-profile";
import { CyberFocusEvaluation } from "./CyberFocusEvaluation";
import {
  FocusEvaluationForm,
  progressForOutcome,
  validFocusEvaluation,
  type FocusOutcome,
  type FocusSatisfaction,
} from "./FocusEvaluationForm";
import { FocusThemeClock } from "./FocusThemeClock";
import { focusQuote } from "./focus-quotes";
import {
  evaluateFocusSession,
  focusPhaseProgress,
  focusRemainingSeconds,
  invokeDesktop,
  loadFocusSnapshot,
  resolveFocusPreparationDecision,
  runFocusSessionAction,
  type FocusMiniSettings,
  type FocusSessionSnapshot,
} from "./focus-session-client";
import { loadUserProfile, type UserProfile } from "./user-profile-client";

const evaluationSurface = new URLSearchParams(window.location.search).get("focus-evaluation") === "1";
const preparationSurface = new URLSearchParams(window.location.search).get("focus-preparation") === "1";

function surfaceCommand(base: "hide" | "minimize" | "start_drag") {
  if (evaluationSurface) return `focus_evaluation_${base}`;
  if (preparationSurface) return `focus_preparation_${base}`;
  return `focus_mini_${base}`;
}

export function FocusMiniWindow() {
  const [snapshot, setSnapshot] = useState<FocusSessionSnapshot | null>(null);
  const [settings, setSettings] = useState<FocusMiniSettings | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [connectionError, setConnectionError] = useState(false);
  const [evaluationError, setEvaluationError] = useState<string | null>(null);
  const [evaluationSaved, setEvaluationSaved] = useState(false);
  const [outcome, setOutcome] = useState<FocusOutcome>("complete");
  const [progress, setProgress] = useState("100");
  const [satisfaction, setSatisfaction] = useState<FocusSatisfaction>("satisfied");
  const [note, setNote] = useState("");
  const [evaluationDeadlineMs, setEvaluationDeadlineMs] = useState<number | null>(null);
  const [evaluationInteracted, setEvaluationInteracted] = useState(false);
  const [actionFeedback, setActionFeedback] = useState<string | null>(null);
  const actionFeedbackTimer = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await loadFocusSnapshot(
        undefined,
        evaluationSurface ? "evaluation" : preparationSurface ? "preparation" : "execution",
      );
      const dismissed = next?.session.state === "ended"
        && window.localStorage.getItem(`personal-ai.focus-evaluation-dismissed.${next.session.id}`) === "1";
      setSnapshot(dismissed ? null : next);
      if (dismissed && evaluationSurface) {
        void invokeDesktop("focus_evaluation_hide").catch(() => undefined);
      }
      setConnectionError(false);
    } catch {
      setConnectionError(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    void Promise.all([
      invokeDesktop<FocusMiniSettings>("focus_mini_settings").catch(() => null),
      loadUserProfile().catch(() => null),
    ]).then(([desktopSettings, loadedProfile]) => {
      if (desktopSettings) setSettings(desktopSettings);
      if (loadedProfile) setProfile(loadedProfile);
    });
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
      void refresh();
    }, 1_000);
    const resync = () => { setNowMs(Date.now()); void refresh(); };
    window.addEventListener("focus", resync);
    document.addEventListener("visibilitychange", resync);
    return () => {
      window.clearInterval(timer);
      if (actionFeedbackTimer.current) window.clearTimeout(actionFeedbackTimer.current);
      window.removeEventListener("focus", resync);
      document.removeEventListener("visibilitychange", resync);
    };
  }, [refresh]);

  const endedSessionId = snapshot?.session.state === "ended" ? snapshot.session.id : null;

  useEffect(() => {
    if (!endedSessionId) {
      setEvaluationDeadlineMs(null);
      setEvaluationInteracted(false);
      return;
    }
    setEvaluationSaved(false);
    setEvaluationError(null);
    setOutcome("complete");
    setProgress("100");
    setSatisfaction("satisfied");
    setNote("");
    const endedAt = snapshot?.session.endedAt ? new Date(snapshot.session.endedAt).getTime() : Date.now();
    setEvaluationDeadlineMs(endedAt + 90_000);
    setEvaluationInteracted(false);
  }, [endedSessionId, snapshot?.session.endedAt]);

  useEffect(() => {
    if (!endedSessionId || !evaluationDeadlineMs || evaluationInteracted) return;
    const delay = Math.max(0, evaluationDeadlineMs - Date.now());
    const timer = window.setTimeout(() => {
      window.localStorage.setItem(`personal-ai.focus-evaluation-dismissed.${endedSessionId}`, "1");
      setSnapshot(null);
      setEvaluationDeadlineMs(null);
      void invokeDesktop(surfaceCommand("hide")).catch(() => undefined);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [endedSessionId, evaluationDeadlineMs, evaluationInteracted]);

  const remaining = snapshot ? focusRemainingSeconds(snapshot, nowMs) : 0;
  const phaseProgress = snapshot ? focusPhaseProgress(snapshot, nowMs) : 0;
  const theme = useMemo<FocusTheme>(() => profile?.focusTheme ?? "ink", [profile?.focusTheme]);
  const resting = snapshot?.phase === "break";
  const phaseLabel = snapshot?.phase === "break"
      ? "休息"
      : snapshot?.phase === "preparation"
        ? "准备"
        : snapshot?.phase === "armed"
          ? "已确认"
          : snapshot?.phase === "awaiting_late_start"
            ? "等待开始"
        : snapshot?.phase === "scheduled"
          ? "等待开始"
          : "专注";
  const phaseEnd = useMemo(() => {
    if (!snapshot?.phaseEndsAt) return null;
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: snapshot.task.timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(snapshot.phaseEndsAt));
  }, [snapshot?.phaseEndsAt, snapshot?.task.timeZone]);

  async function act(action: "skip-preparation" | "skip-final-break" | "other-arrangement") {
    if (!snapshot || busy) return;
    setBusy(true);
    try {
      const next = await runFocusSessionAction(snapshot, action);
      setSnapshot(next);
      // Clicking "开始任务" ends the preparation/countdown surface immediately.
      // The execution surface will be shown separately when the fixed start is reached.
      if (action === "skip-preparation") {
        await invokeDesktop(surfaceCommand("hide")).catch(() => undefined);
      }
      if (action === "other-arrangement") {
        await invokeDesktop("focus_mini_open_main").catch(() => undefined);
        await invokeDesktop(surfaceCommand("hide")).catch(() => undefined);
      }
      setEvaluationError(null);
    } catch {
      setEvaluationError("操作没有保存，请重试。");
    } finally {
      setBusy(false);
    }
  }

  async function decidePreparation(decision: "other-arrangement" | "cancel-task") {
    if (!snapshot || busy) return;
    setBusy(true);
    setEvaluationError(null);
    try {
      await resolveFocusPreparationDecision(snapshot, decision);
      setSnapshot(null);
      setActionFeedback(decision === "cancel-task" ? "任务已经取消并移入回收站" : "任务已经挪到未排期");
      if (actionFeedbackTimer.current) window.clearTimeout(actionFeedbackTimer.current);
      actionFeedbackTimer.current = window.setTimeout(() => {
        setActionFeedback(null);
        void invokeDesktop(surfaceCommand("hide")).catch(() => undefined);
      }, 2_000);
    } catch {
      setEvaluationError("操作没有完整保存，请打开主界面查看任务当前状态。");
    } finally {
      setBusy(false);
    }
  }

  function markEvaluationInteraction() {
    setEvaluationInteracted(true);
    setEvaluationError(null);
  }

  async function updateSetting(command: string, enabled: boolean) {
    try {
      setSettings(await invokeDesktop<FocusMiniSettings>(command, { enabled }));
    } catch {
      setConnectionError(true);
    }
  }

  function chooseOutcome(value: FocusOutcome) {
    setOutcome(value);
    setProgress(progressForOutcome(value));
    setEvaluationError(null);
  }

  async function saveEvaluation() {
    if (!snapshot || snapshot.session.state !== "ended" || busy) return;
    setEvaluationInteracted(true);
    if (!validFocusEvaluation(outcome, progress)) {
      setEvaluationError("请填写与完成情况一致的客观进度。");
      return;
    }
    setBusy(true);
    setEvaluationError(null);
    try {
      await evaluateFocusSession(snapshot, {
        outcome,
        progressPercent: Number(progress),
        satisfaction,
        note: note.trim() || null,
      });
      window.localStorage.removeItem(`personal-ai.focus-evaluation-dismissed.${snapshot.session.id}`);
      setEvaluationSaved(true);
      setSnapshot(null);
      await invokeDesktop("focus_mini_open_main").catch(() => undefined);
      await invokeDesktop(surfaceCommand("hide")).catch(() => undefined);
    } catch {
      setEvaluationError("结果尚未保存，请重试。");
    } finally {
      setBusy(false);
    }
  }

  function startDrag(event: React.PointerEvent<HTMLElement>) {
    if ((!evaluationSurface && settings?.locked) || (event.target as HTMLElement).closest("button")) return;
    void invokeDesktop(surfaceCommand("start_drag"));
  }

  const ended = snapshot?.session.state === "ended";
  const evaluationSecondsLeft = evaluationDeadlineMs
    ? Math.max(0, Math.ceil((evaluationDeadlineMs - nowMs) / 1_000))
    : 90;

  const finalBreak = snapshot?.phase === "break"
    && snapshot.currentSegment?.position === (snapshot.segments.at(-1)?.position ?? -1);
  const quote = snapshot?.session.state === "running" ? focusQuote(snapshot.session.id, resting) : null;

  return <main className={`focus-mini focus-theme-${theme} focus-phase-${snapshot?.phase ?? "idle"} ${ended ? "focus-mini-evaluation" : ""}`}>
    <div className="focus-mini-grain" aria-hidden="true" />
    <header className="focus-mini-titlebar" onPointerDown={startDrag}>
      <span>{ended ? "专注回看" : preparationSurface ? "任务准备" : "专注伴随"}</span>
      <div className="focus-mini-window-controls">
        {!evaluationSurface && !preparationSurface ? <>
          <button
            type="button"
            className={settings?.alwaysOnTop ? "active" : ""}
            aria-label={settings?.alwaysOnTop ? "取消始终置顶" : "始终置顶"}
            title={settings?.alwaysOnTop ? "取消始终置顶" : "始终置顶"}
            onClick={() => void updateSetting("focus_mini_set_always_on_top", !settings?.alwaysOnTop)}
          >{settings?.alwaysOnTop ? <PinOff /> : <Pin />}</button>
          <button
            type="button"
            className={settings?.locked ? "active" : ""}
            aria-label={settings?.locked ? "解锁窗口位置" : "锁定窗口位置"}
            title={settings?.locked ? "解锁窗口位置" : "锁定窗口位置"}
            onClick={() => void updateSetting("focus_mini_set_locked", !settings?.locked)}
          >{settings?.locked ? <Lock /> : <Unlock />}</button>
        </> : null}
        <button type="button" aria-label={evaluationSurface ? "最小化评价窗口" : preparationSurface ? "最小化准备窗口" : "最小化专注窗口"} title="最小化" onClick={() => void invokeDesktop(surfaceCommand("minimize"))}><Minus /></button>
        <button type="button" aria-label={evaluationSurface ? "关闭评价窗口" : preparationSurface ? "关闭准备窗口" : "关闭专注窗口"} title={evaluationSurface ? "关闭评价窗口，保留待评价" : "关闭窗口，计时状态不变"} onClick={() => { if (evaluationSurface && snapshot) window.localStorage.setItem(`personal-ai.focus-evaluation-dismissed.${snapshot.session.id}`, "1"); void invokeDesktop(surfaceCommand("hide")); }}><X /></button>
      </div>
    </header>
    {actionFeedback ? <div className="focus-mini-action-feedback" role="status"><strong>{actionFeedback}</strong><small>窗口即将自动关闭</small></div> : ended && snapshot ? (
      <div className="focus-mini-evaluation-body">
        {!evaluationInteracted ? <p className="focus-evaluation-timeout" role="status">尚未操作，{evaluationSecondsLeft} 秒后自动关闭并保留为待评价</p> : null}
        {theme === "cyber" ? <CyberFocusEvaluation
          taskTitle={snapshot.task.title}
          outcome={outcome}
          progress={progress}
          satisfaction={satisfaction}
          note={note}
          busy={busy}
          error={evaluationError}
          onOutcomeChange={(value) => { markEvaluationInteraction(); chooseOutcome(value); }}
          onProgressChange={(value) => { markEvaluationInteraction(); setProgress(value); }}
          onSatisfactionChange={(value) => { markEvaluationInteraction(); setSatisfaction(value); }}
          onNoteChange={(value) => { markEvaluationInteraction(); setNote(value); }}
          onSubmit={() => void saveEvaluation()}
        /> : <FocusEvaluationForm
          headingId="focus-mini-evaluation-title"
          taskTitle={snapshot.task.title}
          outcome={outcome}
          progress={progress}
          satisfaction={satisfaction}
          note={note}
          busy={busy}
          error={evaluationError}
          onOutcomeChange={(value) => { markEvaluationInteraction(); chooseOutcome(value); }}
          onProgressChange={(value) => { markEvaluationInteraction(); setProgress(value); }}
          onSatisfactionChange={(value) => { markEvaluationInteraction(); setSatisfaction(value); }}
          onNoteChange={(value) => { markEvaluationInteraction(); setNote(value); }}
          onSubmit={() => void saveEvaluation()}
        />}
      </div>
    ) : snapshot ? <div className="focus-mini-body">
      {theme === "cyber" ? <div className="focus-cyber-telemetry" aria-hidden="true">STATE {snapshot.session.state.toUpperCase()}<br />SYNC 01<br />FLOW {Math.round(phaseProgress)}%</div> : null}
      <header className="focus-mini-heading">
        <span>{phaseLabel}</span>
        <strong>{snapshot.task.title}</strong>
      </header>
      <section className="focus-mini-clock" aria-label={`${phaseLabel}剩余 ${formatFocusClock(remaining)}`}>
        <FocusThemeClock theme={theme} value={formatFocusClock(remaining)} />
        <span className="focus-mini-progress" aria-hidden="true"><i style={{ width: `${phaseProgress}%` }}><b /></i></span>
        <small>{phaseEnd ? `${phaseLabel}至 ${phaseEnd}` : phaseLabel}</small>
      </section>
      {quote ? <div className="focus-mini-quote" aria-label="专注提示名言">
        <q>{quote.text}</q>
        <cite>{quote.source}</cite>
      </div> : null}
      <div className="focus-mini-controls" aria-label="专注悬浮窗操作">
        {snapshot.session.state === "preparing" || snapshot.session.state === "awaiting_late_start"
          ? <>
            <button className="primary" type="button" disabled={busy} title="确认开始任务" onClick={() => void act("skip-preparation")}><Play />{snapshot.session.state === "preparing" ? "开始任务" : "现在开始"}</button>
            <button type="button" disabled={busy} title="停止本次准备并退回未排期" onClick={() => void decidePreparation("other-arrangement")}><CalendarClock />另有安排</button>
            <button className="danger" type="button" disabled={busy} title="直接取消这项任务" onClick={() => void decidePreparation("cancel-task")}><XCircle />取消任务</button>
          </>
          : null}
        {finalBreak ? <button type="button" disabled={busy} title="跳过最后休息并进入评价" onClick={() => void act("skip-final-break")}><SkipForward />跳过休息</button> : null}
      </div>
      {!preparationSurface && (snapshot.session.state === "preparing" || snapshot.session.state === "armed" || snapshot.session.state === "awaiting_late_start")
        ? <p className="focus-mini-confirm-hint">桌面或飞书确认一次即可</p>
        : null}
      {!preparationSurface && !["preparing", "armed", "awaiting_late_start"].includes(snapshot.session.state)
        ? <button className={`focus-mini-auto ${settings?.autoShow ? "active" : ""}`} type="button" onClick={() => void updateSetting("focus_mini_set_auto_show", !settings?.autoShow)}>开始时自动出现</button>
        : null}
    </div> : <div className="focus-mini-empty"><strong>{evaluationSaved ? "记录已经保存" : connectionError ? "正在重新连接" : "此刻没有专注"}</strong><button type="button" onClick={() => void invokeDesktop("focus_mini_open_main")}>回到主界面</button></div>}
  </main>;
}
