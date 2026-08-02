import { useEffect, useState, type FormEvent } from "react";
import { Check, CircleAlert, LoaderCircle, ShieldCheck, X } from "lucide-react";

type ResponseStyle = "concise" | "balanced" | "detailed";
type UserProfile = {
  id: number;
  personalContext: string;
  aiGuidance: string;
  shareWithAi: boolean;
  responseStyle: ResponseStyle;
  version: number;
};
type Draft = Omit<UserProfile, "id" | "version">;
type ApiFailure = { error?: string; profile?: UserProfile };

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3000";
const emptyDraft: Draft = { personalContext: "", aiGuidance: "", shareWithAi: true, responseStyle: "balanced" };

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

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true); setError(null); setSaved(false);
    void requestProfile<{ profile: UserProfile }>("GET")
      .then((result) => {
        if (cancelled) return;
        setProfile(result.profile);
        setDraft({
          personalContext: result.profile.personalContext,
          aiGuidance: result.profile.aiGuidance,
          shareWithAi: result.profile.shareWithAi,
          responseStyle: result.profile.responseStyle
        });
      })
      .catch(() => { if (!cancelled) setError("无法读取个人设置。请确认本地 API 正在运行。"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open]);

  if (!open) return null;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!profile) return;
    setSaving(true); setError(null);
    try {
      const result = await requestProfile<{ profile: UserProfile }>("PUT", { ...draft, expectedVersion: profile.version });
      setProfile(result.profile);
      setDraft({
        personalContext: result.profile.personalContext,
        aiGuidance: result.profile.aiGuidance,
        shareWithAi: result.profile.shareWithAi,
        responseStyle: result.profile.responseStyle
      });
      setSaved(true);
    } catch (requestError) {
      setError(requestError instanceof ProfileApiError && requestError.body.error === "user_profile_version_conflict"
        ? "个人设置已在另一处更新。你的草稿仍保留，请重新打开后决定如何合并。"
        : "无法保存个人设置。你的草稿仍保留。");
    } finally {
      setSaving(false);
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
        <label><span>个人背景</span><textarea aria-label="个人背景" rows={10} maxLength={20_000} value={draft.personalContext} onChange={(event) => setDraft((current) => ({ ...current, personalContext: event.target.value }))} placeholder="例如：当前目标、学习背景、在意的边界或希望 AI 了解的长期情况。" /></label>
        <label><span>AI 协作指引</span><textarea aria-label="AI 协作指引" rows={5} maxLength={4_000} value={draft.aiGuidance} onChange={(event) => setDraft((current) => ({ ...current, aiGuidance: event.target.value }))} placeholder="例如：希望先给框架，避免替我做决定；必要时指出风险。" /></label>
        <div className="user-profile-preferences">
          <label className="profile-checkbox"><input aria-label="允许个人背景发送给 AI" type="checkbox" checked={draft.shareWithAi} onChange={(event) => setDraft((current) => ({ ...current, shareWithAi: event.target.checked }))} /><span><strong>在调用 AI 时使用以上背景</strong><small>关闭后，背景仍保存在本地，但不会发送给模型。</small></span></label>
          <label><span>回复详略</span><select aria-label="回复详略" value={draft.responseStyle} onChange={(event) => setDraft((current) => ({ ...current, responseStyle: event.target.value as ResponseStyle }))}><option value="concise">简洁</option><option value="balanced">平衡</option><option value="detailed">详细</option></select></label>
        </div>
        <footer><small role="status">{saved ? "已保存" : profile ? `版本 ${profile.version}` : ""}</small><button className="primary-button" type="submit" disabled={saving || !profile}>{saving ? <LoaderCircle className="spin" /> : <Check />}{saving ? "正在保存" : "保存个人设置"}</button></footer>
      </form>}
    </section>
  </div>;
}
