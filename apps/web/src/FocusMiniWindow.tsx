import { useCallback, useEffect, useMemo, useState } from "react";
import { Lock, Minus, Pin, PinOff, Play, SkipForward, Unlock, X } from "lucide-react";
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
  runFocusSessionAction,
  type FocusMiniSettings,
  type FocusSessionSnapshot,
} from "./focus-session-client";
import { loadUserProfile, type UserProfile } from "./user-profile-client";

const focusThemeValues = new Set<FocusTheme>(["ink", "flip", "nixie", "vapor", "cyber"]);

function lockedFocusTheme(sessionId: string | undefined, preferred: FocusTheme) {
  if (!sessionId) return preferred;
  const key = `personal-ai.focus-theme-lock.${sessionId}`;
  const stored = window.localStorage.getItem(key) as FocusTheme | null;
  if (stored && focusThemeValues.has(stored)) return stored;
  window.localStorage.setItem(key, preferred);
  return preferred;
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

  const refresh = useCallback(async () => {
    try {
      setSnapshot(await loadFocusSnapshot());
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
      window.removeEventListener("focus", resync);
      document.removeEventListener("visibilitychange", resync);
    };
  }, [refresh]);

  useEffect(() => {
    if (snapshot?.session.state !== "ended") return;
    setEvaluationSaved(false);
    setEvaluationError(null);
    setOutcome("complete");
    setProgress("100");
    setSatisfaction("satisfied");
    setNote("");
  }, [snapshot?.session.id]);

  const remaining = snapshot ? focusRemainingSeconds(snapshot, nowMs) : 0;
  const phaseProgress = snapshot ? focusPhaseProgress(snapshot, nowMs) : 0;
  const theme = useMemo<FocusTheme>(() => profile
    ? lockedFocusTheme(snapshot?.session.id, profile.focusTheme ?? "ink")
    : "ink", [profile?.focusTheme, snapshot?.session.id]);
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

  async function act(action: "skip-preparation" | "skip-final-break") {
    if (!snapshot || busy) return;
    setBusy(true);
    try {
      setSnapshot(await runFocusSessionAction(snapshot, action));
      setEvaluationError(null);
    } catch {
      setEvaluationError("操作没有保存，请重试。");
    } finally {
      setBusy(false);
    }
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
      window.localStorage.removeItem(`personal-ai.focus-theme-lock.${snapshot.session.id}`);
      setEvaluationSaved(true);
      setSnapshot(null);
      await invokeDesktop("focus_mini_open_main").catch(() => undefined);
      await invokeDesktop("focus_mini_hide").catch(() => undefined);
    } catch {
      setEvaluationError("结果尚未保存，请重试。");
    } finally {
      setBusy(false);
    }
  }

  function startDrag(event: React.PointerEvent<HTMLElement>) {
    if (settings?.locked || (event.target as HTMLElement).closest("button")) return;
    void invokeDesktop("focus_mini_start_drag");
  }

  const ended = snapshot?.session.state === "ended";

  const finalBreak = snapshot?.phase === "break"
    && snapshot.currentSegment?.position === (snapshot.segments.at(-1)?.position ?? -1);
  const quote = snapshot ? focusQuote(snapshot.session.id, resting) : null;

  return <main className={`focus-mini focus-theme-${theme} focus-phase-${snapshot?.phase ?? "idle"} ${ended ? "focus-mini-evaluation" : ""}`}>
    <div className="focus-mini-grain" aria-hidden="true" />
    <header className="focus-mini-titlebar" onPointerDown={startDrag}>
      <span>{ended ? "专注回看" : "专注伴随"}</span>
      <div className="focus-mini-window-controls">
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
        <button type="button" aria-label="最小化专注窗口" title="最小化" onClick={() => void invokeDesktop("focus_mini_minimize")}><Minus /></button>
        <button type="button" aria-label="关闭专注窗口" title="关闭窗口，专注继续" onClick={() => void invokeDesktop("focus_mini_hide")}><X /></button>
      </div>
    </header>
    {ended && snapshot ? (
      <div className="focus-mini-evaluation-body">
        {theme === "cyber" ? <CyberFocusEvaluation
          taskTitle={snapshot.task.title}
          outcome={outcome}
          progress={progress}
          satisfaction={satisfaction}
          note={note}
          busy={busy}
          error={evaluationError}
          onOutcomeChange={chooseOutcome}
          onProgressChange={(value) => { setProgress(value); setEvaluationError(null); }}
          onSatisfactionChange={(value) => { setSatisfaction(value); setEvaluationError(null); }}
          onNoteChange={setNote}
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
          onOutcomeChange={chooseOutcome}
          onProgressChange={(value) => { setProgress(value); setEvaluationError(null); }}
          onSatisfactionChange={(value) => { setSatisfaction(value); setEvaluationError(null); }}
          onNoteChange={setNote}
          onSubmit={() => void saveEvaluation()}
        />}
      </div>
    ) : snapshot ? <>
      {theme === "cyber" ? <div className="focus-cyber-telemetry" aria-hidden="true">STATE {snapshot.session.state.toUpperCase()}<br />SYNC 01<br />FLOW {Math.round(phaseProgress)}%</div> : null}
      <header className="focus-mini-heading">
        <span>{phaseLabel}</span>
        <strong>{snapshot.task.title}</strong>
      </header>
      <section className="focus-mini-clock" aria-label={`${phaseLabel}剩余 ${formatFocusClock(remaining)}`}>
        <FocusThemeClock theme={theme} value={formatFocusClock(remaining)} />
        <span className="focus-mini-progress" aria-hidden="true"><i style={{ width: `${phaseProgress}%` }}><b /></i></span>
        <small>{phaseEnd ? `${phaseLabel}至 ${phaseEnd}` : phaseLabel}</small>
        {quote ? <p className="focus-mini-quote"><q>{quote.text}</q><cite>{quote.source}</cite></p> : null}
      </section>
      <div className="focus-mini-controls" aria-label="专注悬浮窗操作">
        {snapshot.session.state === "preparing" || snapshot.session.state === "awaiting_late_start"
          ? <button className="primary" type="button" disabled={busy} title="确认开始任务" onClick={() => void act("skip-preparation")}><Play />{snapshot.session.state === "preparing" ? "开始任务" : "现在开始"}</button>
          : null}
        {finalBreak ? <button type="button" disabled={busy} title="跳过最后休息并进入评价" onClick={() => void act("skip-final-break")}><SkipForward />跳过休息</button> : null}
      </div>
      {snapshot.session.state === "preparing" || snapshot.session.state === "armed" || snapshot.session.state === "awaiting_late_start"
        ? <p className="focus-mini-confirm-hint">桌面或飞书确认一次即可</p>
        : null}
      <button className={`focus-mini-auto ${settings?.autoShow ? "active" : ""}`} type="button" onClick={() => void updateSetting("focus_mini_set_auto_show", !settings?.autoShow)}>开始时自动出现</button>
    </> : <div className="focus-mini-empty"><strong>{evaluationSaved ? "记录已经保存" : connectionError ? "正在重新连接" : "此刻没有专注"}</strong><button type="button" onClick={() => void invokeDesktop("focus_mini_open_main")}>回到主界面</button></div>}
  </main>;
}
