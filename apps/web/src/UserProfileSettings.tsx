import { useEffect, useState, type FormEvent } from "react";
import { Bell, Check, CircleAlert, LoaderCircle, MonitorUp, ShieldCheck, Volume2, X } from "lucide-react";
import { invokeDesktop, type FocusMiniSettings } from "./focus-session-client";

type ResponseStyle = "concise" | "balanced" | "detailed";
type UnscheduledTaskPolicy = "carry_forward" | "delete_at_day_end";
type UserProfile = {
  id: number;
  personalContext: string;
  aiGuidance: string;
  shareWithAi: boolean;
  responseStyle: ResponseStyle;
  unscheduledTaskPolicy: UnscheduledTaskPolicy;
  recycleRetentionDays: number;
  focusFlipSoundEnabled: boolean;
  focusStartSoundEnabled: boolean;
  breakStartSoundEnabled: boolean;
  breakEndSoundEnabled: boolean;
  focusEndSoundEnabled: boolean;
  version: number;
};
type FocusSounds = { flip: boolean; focusStart: boolean; breakStart: boolean; breakEnd: boolean; focusEnd: boolean };
type Draft = Pick<UserProfile, "personalContext" | "aiGuidance" | "shareWithAi" | "responseStyle" | "unscheduledTaskPolicy" | "recycleRetentionDays"> & { focusSounds: FocusSounds };
type ApiFailure = { error?: string; profile?: UserProfile };

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3000";
const emptyDraft: Draft = { personalContext: "", aiGuidance: "", shareWithAi: true, responseStyle: "balanced", unscheduledTaskPolicy: "carry_forward", recycleRetentionDays: 3, focusSounds: { flip: true, focusStart: true, breakStart: true, breakEnd: true, focusEnd: true } };

function draftFromProfile(profile: UserProfile): Draft {
  return {
    personalContext: profile.personalContext,
    aiGuidance: profile.aiGuidance,
    shareWithAi: profile.shareWithAi,
    responseStyle: profile.responseStyle,
    unscheduledTaskPolicy: profile.unscheduledTaskPolicy,
    recycleRetentionDays: profile.recycleRetentionDays,
    focusSounds: {
      flip: profile.focusFlipSoundEnabled,
      focusStart: profile.focusStartSoundEnabled,
      breakStart: profile.breakStartSoundEnabled,
      breakEnd: profile.breakEndSoundEnabled,
      focusEnd: profile.focusEndSoundEnabled
    }
  };
}

class ProfileApiError extends Error {
  constructor(readonly body: ApiFailure) { super(body.error ?? "profile request failed"); }
}

async function requestProfile<T>(method: "GET" | "PUT", body?: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${apiBaseUrl}/api/v1/user-profile`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new ProfileApiError(result as ApiFailure);
  return result as T;
}

export function UserProfileSettings({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [desktopFocusSettings, setDesktopFocusSettings] = useState<FocusMiniSettings | null>(null);
  const desktopRuntime = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true); setError(null); setSaved(false);
    void requestProfile<{ profile: UserProfile }>("GET")
      .then((result) => {
        if (cancelled) return;
        setProfile(result.profile);
        setDraft(draftFromProfile(result.profile));
      })
      .catch(() => { if (!cancelled) setError("无法读取个人设置。请确认本地 API 正在运行。"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open]);

  useEffect(() => {
    if (!open || !desktopRuntime) return;
    void invokeDesktop<FocusMiniSettings>("focus_mini_settings").then(setDesktopFocusSettings).catch(() => undefined);
  }, [desktopRuntime, open]);

  if (!open) return null;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!profile) return;
    setSaving(true); setError(null);
    try {
      const result = await requestProfile<{ profile: UserProfile }>("PUT", { ...draft, expectedVersion: profile.version });
      setProfile(result.profile);
      setDraft(draftFromProfile(result.profile));
      setSaved(true);
    } catch (requestError) {
      setError(requestError instanceof ProfileApiError && requestError.body.error === "user_profile_version_conflict"
        ? "个人设置已在另一处更新。你的草稿仍保留，请重新打开后决定如何合并。"
        : "无法保存个人设置。你的草稿仍保留。");
    } finally {
      setSaving(false);
    }
  }

  async function updateDesktopSetting(command: string, enabled: boolean, kind?: "start" | "phase" | "complete") {
    try {
      setDesktopFocusSettings(await invokeDesktop<FocusMiniSettings>(command, {
        enabled,
        ...(kind ? { kind } : {}),
      }));
    } catch {
      setError("桌面专注设置没有保存，请重新打开软件后重试。");
    }
  }

  return <div className="settings-layer" role="dialog" aria-modal="true" aria-labelledby="user-profile-title">
    <button className="settings-scrim" type="button" aria-label="关闭个人设置" onClick={onClose} />
    <section className="user-profile-panel">
      <header>
        <div><p className="section-kicker">个人设置</p><h2 id="user-profile-title">把背景留给自己，也交代给 AI。</h2></div>
        <button className="quiet-icon" type="button" aria-label="关闭个人设置" onClick={onClose}><X /></button>
      </header>
      {loading ? <div className="user-profile-loading"><LoaderCircle className="spin" />正在读取你的设置</div> : <form onSubmit={save}>
        {error && <p className="user-profile-error" role="alert"><CircleAlert />{error}</p>}
        <p className="user-profile-note"><ShieldCheck />只保存你主动填写的内容；不会根据任务、对话或使用行为更新这份画像。</p>
        <label><span>个人背景</span><textarea aria-label="个人背景" rows={10} maxLength={20_000} value={draft.personalContext} onChange={(event) => setDraft((current) => ({ ...current, personalContext: event.target.value }))} placeholder="填写希望长期保留的背景信息（可留空）。" /></label>
        <label><span>AI 协作指引</span><textarea aria-label="AI 协作指引" rows={5} maxLength={4_000} value={draft.aiGuidance} onChange={(event) => setDraft((current) => ({ ...current, aiGuidance: event.target.value }))} placeholder="例如：先给框架，再给可选方案；必要时指出风险。" /></label>
        <div className="user-profile-preferences">
          <label className="profile-checkbox"><input aria-label="允许个人背景发送给 AI" type="checkbox" checked={draft.shareWithAi} onChange={(event) => setDraft((current) => ({ ...current, shareWithAi: event.target.checked }))} /><span><strong>在调用 AI 时使用以上背景</strong><small>关闭后，背景仍保存在本地，但不会发送给模型。</small></span></label>
          <label><span>回复详略</span><select aria-label="回复详略" value={draft.responseStyle} onChange={(event) => setDraft((current) => ({ ...current, responseStyle: event.target.value as ResponseStyle }))}><option value="concise">简洁</option><option value="balanced">平衡</option><option value="detailed">详细</option></select></label>
        </div>
        <fieldset className="unscheduled-policy-field">
          <legend>未排期任务的日终处理</legend>
          <p>只处理指定了当天日期、仍处于待办状态的正式任务；想法、问题、补录和已处理任务不受影响。</p>
          <label className="profile-checkbox"><input aria-label="保留以后的未排期任务顺移到下一天" type="radio" name="unscheduled-task-policy" checked={draft.unscheduledTaskPolicy === "carry_forward"} onChange={() => setDraft((current) => ({ ...current, unscheduledTaskPolicy: "carry_forward" }))} /><span><strong>保留以后的未排期任务顺移到下一天</strong><small>到当天结束仍未排期的正式任务，会在下一天继续出现在未排期列表。</small></span></label>
          <label className="profile-checkbox"><input aria-label="今天结束后自动删除未排期任务" type="radio" name="unscheduled-task-policy" checked={draft.unscheduledTaskPolicy === "delete_at_day_end"} onChange={() => setDraft((current) => ({ ...current, unscheduledTaskPolicy: "delete_at_day_end" }))} /><span><strong>今天结束后自动删除</strong><small>当天结束后移出正常列表并进入回收站；不会删除想法或问题。</small></span></label>
        </fieldset>
        <fieldset className="sound-preferences-field">
          <legend><Volume2 />专注计时音效</legend>
          <p>每一种提示可以单独关闭；设置保存在本机数据库中，重新打开软件后仍然有效。</p>
          <div className="sound-preference-grid">
            {([
              ["flip", "计时刻度", "每分钟变化时的轻柔纸页声"],
              ["focusStart", "专注开始", "任务或下一段专注真正开始"],
              ["breakStart", "休息开始", "从专注切换到休息"],
              ["breakEnd", "休息结束", "休息结束、准备回到下一段"],
              ["focusEnd", "任务结束", "整个专注结构到达固定结束时间"]
            ] as const).map(([key, label, help]) => <label className="profile-checkbox" key={key}><input aria-label={`${label}音效`} type="checkbox" checked={draft.focusSounds[key]} onChange={(event) => setDraft((current) => ({ ...current, focusSounds: { ...current.focusSounds, [key]: event.target.checked } }))} /><span><strong>{label}</strong><small>{help}</small></span></label>)}
          </div>
        </fieldset>
        {desktopRuntime && desktopFocusSettings && <fieldset className="sound-preferences-field desktop-focus-preferences-field">
          <legend><MonitorUp />专注悬浮窗</legend>
          <p>这些是本机窗口设置，修改后立即生效；关闭主窗口不会结束正在进行的专注。</p>
          <div className="sound-preference-grid">
            <label className="profile-checkbox"><input aria-label="开始专注时自动显示悬浮窗" type="checkbox" checked={desktopFocusSettings.autoShow} onChange={(event) => void updateDesktopSetting("focus_mini_set_auto_show", event.target.checked)} /><span><strong>开始专注时自动显示</strong><small>进入准备或执行状态时，让小窗安静地出现在上次位置。</small></span></label>
            <label className="profile-checkbox"><input aria-label="专注悬浮窗始终置顶" type="checkbox" checked={desktopFocusSettings.alwaysOnTop} onChange={(event) => void updateDesktopSetting("focus_mini_set_always_on_top", event.target.checked)} /><span><strong>始终置顶</strong><small>可以随时关闭，不会影响计时。</small></span></label>
            <label className="profile-checkbox"><input aria-label="锁定专注悬浮窗位置" type="checkbox" checked={desktopFocusSettings.locked} onChange={(event) => void updateDesktopSetting("focus_mini_set_locked", event.target.checked)} /><span><strong>锁定位置</strong><small>锁定后避免误拖动，仍可隐藏或打开主界面。</small></span></label>
          </div>
          <div className="desktop-notification-heading"><Bell /><span>Windows 通知</span></div>
          <div className="sound-preference-grid">
            <label className="profile-checkbox"><input aria-label="专注开始通知" type="checkbox" checked={desktopFocusSettings.notifyStart} onChange={(event) => void updateDesktopSetting("focus_mini_set_notification", event.target.checked, "start")} /><span><strong>专注开始</strong><small>只在真正进入第一段专注时通知。</small></span></label>
            <label className="profile-checkbox"><input aria-label="专注阶段切换通知" type="checkbox" checked={desktopFocusSettings.notifyPhaseChange} onChange={(event) => void updateDesktopSetting("focus_mini_set_notification", event.target.checked, "phase")} /><span><strong>阶段切换</strong><small>进入休息或下一段专注时通知。</small></span></label>
            <label className="profile-checkbox"><input aria-label="专注完成通知" type="checkbox" checked={desktopFocusSettings.notifyComplete} onChange={(event) => void updateDesktopSetting("focus_mini_set_notification", event.target.checked, "complete")} /><span><strong>专注完成</strong><small>本次固定时间结束时通知。</small></span></label>
          </div>
        </fieldset>}
        <label className="recycle-retention-setting"><span>回收站保留时间</span><select aria-label="回收站保留时间" value={draft.recycleRetentionDays} onChange={(event) => setDraft((current) => ({ ...current, recycleRetentionDays: Number(event.target.value) }))}><option value={1}>1 天</option><option value={3}>3 天（默认）</option><option value={7}>7 天</option><option value={14}>14 天</option><option value={30}>30 天</option></select><small>超过保留时间后，本地 Worker 会永久清理，无法恢复。</small></label>
        <footer><small role="status">{saved ? "已保存" : profile ? `版本 ${profile.version}` : ""}</small><button className="primary-button" type="submit" disabled={saving || !profile}>{saving ? <LoaderCircle className="spin" /> : <Check />}{saving ? "正在保存" : "保存个人设置"}</button></footer>
      </form>}
    </section>
  </div>;
}
