import { useEffect, useRef, useState, type FormEvent } from "react";
import { Check, ChevronLeft, ChevronRight, ClipboardPenLine, HeartPulse, Leaf, LoaderCircle, MapPin, Sparkles, X } from "lucide-react";

type Profile = {
  city: string | null;
  basics: { sex: "male" | "female" | "other"; age: number; heightCm: number; weightKg: number; bodyFatPercent: number | null; waistCm: number | null };
  goals: string[];
  stageWeightGoal: { minimumKg: number; maximumKg: number };
  considerations: string[];
  activity: { sessionsPerWeek: number; usualDurationMinutes: { minimum: number; maximum: number }; preferredActivities: string[]; avoidHighRisk: boolean };
  food: { mealContext: string; mealTimes: { breakfast: string; lunch: string; dinner: string }; dislikes: string[]; commonFoods: string[] };
  supplements: { current: string[]; considering: string[]; avoids: string[] };
  notes: string | null;
};
type StoredProfile = { id: string; version: number; profile: Profile };
type DayReference = {
  id: string;
  localDate: string;
  dayIndex: number;
  content: {
    nutritionDirection: string;
    proteinRangeGrams: { minimum: number; maximum: number };
    plateGuidance: string[];
    seasonalVegetables: string[];
    movement: { category: "strength" | "volleyball" | "running" | "cycling" | "recovery" | "rest"; durationMinutes: { minimum: number; maximum: number }; intensity: "rest" | "low" | "moderate" | "high"; highIntensity: boolean; safetyReminder: string };
  };
};
type HealthPlan = { id: string; weekStart: string; state: "candidate" | "active"; source: "template" | "ai" | "manual"; city: string | null; solarTerm: string; overview: string; supplements: string[]; version: number; days: DayReference[] };
type ApiError = Error & { status?: number; body?: { error?: string } };

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3000";
const weekday = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const activityLabel: Record<DayReference["content"]["movement"]["category"], string> = { strength: "力量训练", volleyball: "排球", running: "跑步", cycling: "骑行", recovery: "轻量恢复", rest: "休息" };
const intensityLabel: Record<DayReference["content"]["movement"]["intensity"], string> = { rest: "休息", low: "低强度", moderate: "中等强度", high: "高强度" };

function shanghaiDate() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function weekStartFor(date: string): string {
  const current = new Date(`${date}T00:00:00.000Z`);
  current.setUTCDate(current.getUTCDate() - current.getUTCDay());
  return current.toISOString().slice(0, 10);
}

function addDays(date: string, count: number) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + count);
  return value.toISOString().slice(0, 10);
}

function listText(value: string) {
  return value.split(/[\n,，]/).map((item) => item.trim()).filter(Boolean);
}

async function request<T>(path: string, method = "GET", payload?: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, { method, headers: payload ? { "content-type": "application/json" } : undefined, body: payload ? JSON.stringify(payload) : undefined });
  const body = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error((body as { error?: string }).error ?? `HTTP ${response.status}`) as ApiError;
    error.status = response.status;
    error.body = body as { error?: string };
    throw error;
  }
  return body as T;
}

export function HealthWorkspace() {
  const [weekStart, setWeekStart] = useState(() => weekStartFor(shanghaiDate()));
  const [profile, setProfile] = useState<StoredProfile | null>(null);
  const [active, setActive] = useState<HealthPlan | null>(null);
  const [candidate, setCandidate] = useState<HealthPlan | null>(null);
  const [selectedDay, setSelectedDay] = useState(0);
  const [specialContext, setSpecialContext] = useState("");
  const [editingProfile, setEditingProfile] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoCandidateRequested = useRef<string | null>(null);
  const visiblePlan = candidate ?? active;
  const selectedReference = visiblePlan?.days[selectedDay] ?? null;

  useEffect(() => { void reload(); }, [weekStart]);

  useEffect(() => {
    if (!loading && profile && !active && !candidate && autoCandidateRequested.current !== weekStart) {
      autoCandidateRequested.current = weekStart;
      void createCandidate("template");
    }
  }, [loading, profile, active, candidate, weekStart]);

  async function reload() {
    setLoading(true);
    try {
      const [profileResult, weekResult] = await Promise.all([
        request<{ profile: StoredProfile | null }>("/api/v1/health/profile"),
        request<{ active: HealthPlan | null; candidate: HealthPlan | null }>(`/api/v1/health/weeks/${weekStart}`)
      ]);
      setProfile(profileResult.profile);
      setActive(weekResult.active);
      setCandidate(weekResult.candidate);
      setSelectedDay(0);
      setError(null);
    } catch {
      setError("健康参考暂时无法读取，请确认本机 API 正在运行。");
    } finally {
      setLoading(false);
    }
  }

  async function createCandidate(kind: "template" | "ai") {
    setBusy(true); setError(null);
    try {
      const result = await request<{ plan: HealthPlan }>(`/api/v1/health/weeks/${kind === "ai" ? "ai-" : "template-"}candidates`, "POST", {
        weekStart, ...(specialContext.trim() ? { specialContext: specialContext.trim() } : {})
      });
      setCandidate(result.plan); setSelectedDay(0);
    } catch (requestError) {
      const code = requestError instanceof Error ? (requestError as ApiError).body?.error : undefined;
      setError(code === "health_profile_required" ? "请先保存健康资料，再生成本周参考。" : kind === "ai" ? "AI 暂时无法生成候选，现有参考保持不变。" : "基础候选生成失败，现有参考保持不变。");
    } finally { setBusy(false); }
  }

  async function confirmCandidate() {
    if (!candidate) return;
    setBusy(true); setError(null);
    try {
      const result = await request<{ plan: HealthPlan }>(`/api/v1/health/weeks/${candidate.id}/confirm`, "POST", { expectedVersion: candidate.version });
      setActive(result.plan); setCandidate(null);
    } catch { setError("确认失败，候选仍保留。请刷新后重试。"); }
    finally { setBusy(false); }
  }

  async function discardCandidate() {
    if (!candidate) return;
    setBusy(true); setError(null);
    try {
      await request(`/api/v1/health/weeks/${candidate.id}/cancel`, "POST", { expectedVersion: candidate.version });
      setCandidate(null);
    } catch { setError("放弃候选失败，候选仍保留。请刷新后重试。"); }
    finally { setBusy(false); }
  }

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!profile) return;
    const form = new FormData(event.currentTarget);
    const weightKg = Number(form.get("weightKg"));
    const bodyFat = String(form.get("bodyFatPercent") ?? "").trim();
    const city = String(form.get("city") ?? "").trim();
    const next: Profile = {
      ...profile.profile,
      city: city || null,
      basics: { ...profile.profile.basics, weightKg, bodyFatPercent: bodyFat ? Number(bodyFat) : null },
      goals: listText(String(form.get("goals") ?? "")),
      considerations: listText(String(form.get("considerations") ?? "")),
      notes: String(form.get("notes") ?? "").trim() || null
    };
    setBusy(true); setError(null);
    try {
      const result = await request<{ profile: StoredProfile }>("/api/v1/health/profile", "PUT", { expectedVersion: profile.version, profile: next });
      setProfile(result.profile); setEditingProfile(false);
    } catch { setError("资料保存失败，原资料没有被覆盖。请刷新后重试。"); }
    finally { setBusy(false); }
  }

  return <section className="health-workspace">
    <header className="health-heading">
      <div><p className="section-kicker">健康参考</p><h1>把身体照顾在计划之外。</h1><p>只给出本周可查看的饮食与运动范围，不安排任务、不要求打卡。</p></div>
      <div className="health-week-switcher"><button type="button" aria-label="上一周健康参考" onClick={() => setWeekStart(addDays(weekStart, -7))}><ChevronLeft /></button><div><strong>{weekStart} 起</strong><small>周日到周六</small></div><button type="button" aria-label="下一周健康参考" onClick={() => setWeekStart(addDays(weekStart, 7))}><ChevronRight /></button></div>
    </header>
    {error && <div className="error-banner" role="alert"><X />{error}<button type="button" aria-label="关闭错误提示" onClick={() => setError(null)}><X /></button></div>}
    {loading ? <div className="health-loading"><LoaderCircle className="spin" /><span>正在读取本周健康参考</span></div> : <>
      <section className="health-context-card">
        <div className="health-context-icon"><HeartPulse /></div>
        <div><p className="section-kicker">你的资料</p><strong>{profile ? `${profile.profile.basics.heightCm} cm · ${profile.profile.basics.weightKg} kg · ${profile.profile.goals.slice(0, 2).join(" / ")}` : "尚未建立健康资料"}</strong><small><MapPin />{profile?.profile.city ?? "未设置城市，不会自动定位"}</small></div>
        <button className="quiet-button" type="button" onClick={() => setEditingProfile((value) => !value)}><ClipboardPenLine />{editingProfile ? "收起资料" : "查看或修改资料"}</button>
      </section>
      {editingProfile && profile && <form className="health-profile-form" onSubmit={saveProfile}>
        <label><span>当前城市（可留空）</span><input name="city" defaultValue={profile.profile.city ?? ""} maxLength={120} placeholder="例如：呼和浩特" /></label>
        <label><span>当前体重（kg）</span><input name="weightKg" type="number" min="30" max="300" step="0.1" defaultValue={profile.profile.basics.weightKg} required /></label>
        <label><span>体脂率（%）</span><input name="bodyFatPercent" type="number" min="1" max="70" step="0.1" defaultValue={profile.profile.basics.bodyFatPercent ?? ""} /></label>
        <label className="wide"><span>当前目标（逗号或换行分隔）</span><textarea name="goals" rows={2} defaultValue={profile.profile.goals.join("，")} required /></label>
        <label className="wide"><span>需要考虑的情况（逗号或换行分隔）</span><textarea name="considerations" rows={3} defaultValue={profile.profile.considerations.join("\n")} required /></label>
        <label className="wide"><span>补充说明（可选）</span><textarea name="notes" rows={2} defaultValue={profile.profile.notes ?? ""} maxLength={2000} /></label>
        <footer className="wide"><button className="primary-button" disabled={busy} type="submit">{busy ? <LoaderCircle className="spin" /> : <Check />}保存我主动填写的资料</button></footer>
      </form>}
      <section className="health-generation">
        <div><p className="section-kicker">本周候选</p><h2>{candidate ? "候选尚未生效" : active ? "当前参考保持稳定" : "先生成一份本周参考"}</h2><small>最多补充一句本周的运动、外出、身体不适或饮食场景；跳过也能生成。</small></div>
        <textarea aria-label="本周健康特殊情况" rows={3} maxLength={1000} value={specialContext} onChange={(event) => setSpecialContext(event.target.value)} placeholder="可选，例如：周三有排球，周末需要外出" />
        <div className="health-generation-actions"><button className="quiet-button" type="button" disabled={busy || !profile} onClick={() => void createCandidate("template")}><Leaf />生成基础候选</button><button className="primary-button" type="button" disabled={busy || !profile} onClick={() => void createCandidate("ai")}><Sparkles />让 AI 细化候选</button></div>
      </section>
      {visiblePlan ? <section className="health-plan">
        <header className="health-plan-header"><div><p className="section-kicker">{candidate ? "待确认版本" : "本周生效版本"}</p><h2>{visiblePlan.solarTerm} · {visiblePlan.city ?? "通用时令参考"}</h2><small>{candidate ? (visiblePlan.source === "ai" ? "AI 只生成候选，确认后才会替换本周参考。" : "基础候选需经你确认后才会生效。") : "本周参考不会因一天睡眠或运动变化自动改写。"}</small></div>{candidate && <div className="candidate-actions"><button className="quiet-button" type="button" disabled={busy} onClick={() => void discardCandidate()}>放弃候选</button><button className="primary-button" type="button" disabled={busy} onClick={() => void confirmCandidate()}>{busy ? <LoaderCircle className="spin" /> : <Check />}确认并使用</button></div>}</header>
        <p className="health-overview">{visiblePlan.overview}</p>
        <div className="health-days" role="tablist" aria-label="本周健康参考日期">{visiblePlan.days.map((day) => <button key={day.id} role="tab" aria-selected={selectedDay === day.dayIndex} className={selectedDay === day.dayIndex ? "active" : ""} type="button" onClick={() => setSelectedDay(day.dayIndex)}><span>{weekday[day.dayIndex]}</span><strong>{day.localDate.slice(8)}</strong></button>)}</div>
        {selectedReference && <article className="health-day-detail"><section><header><Leaf /><div><p>饮食方向</p><strong>蛋白质约 {selectedReference.content.proteinRangeGrams.minimum}–{selectedReference.content.proteinRangeGrams.maximum} g / 天</strong></div></header><p>{selectedReference.content.nutritionDirection}</p><ul>{selectedReference.content.plateGuidance.map((item) => <li key={item}>{item}</li>)}</ul><div className="vegetable-tags">{selectedReference.content.seasonalVegetables.map((item) => <span key={item}>{item}</span>)}</div></section><section><header><HeartPulse /><div><p>运动范围</p><strong>{activityLabel[selectedReference.content.movement.category]} · {intensityLabel[selectedReference.content.movement.intensity]}</strong></div></header><p>{selectedReference.content.movement.durationMinutes.maximum === 0 ? "不安排训练；保持日常轻松活动即可。" : `${selectedReference.content.movement.durationMinutes.minimum}–${selectedReference.content.movement.durationMinutes.maximum} 分钟，按当天实际状态自主决定。`}</p><aside>{selectedReference.content.movement.safetyReminder}</aside></section></article>}
        <section className="health-supplements"><p className="section-kicker">补充剂参考</p>{visiblePlan.supplements.map((item) => <p key={item}>{item}</p>)}</section>
      </section> : <div className="health-empty"><HeartPulse /><strong>健康资料已准备好后，会在这里生成一份待你确认的本周参考。</strong></div>}
    </>}
  </section>;
}
