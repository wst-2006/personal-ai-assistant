import { useEffect, useRef, useState, type FormEvent } from "react";
import { Check, ChevronLeft, ChevronRight, ClipboardPenLine, HeartPulse, Leaf, LoaderCircle, MapPin, Sparkles, Upload, X } from "lucide-react";

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
type HealthPlan = {
  id: string;
  weekStart: string;
  state: "candidate" | "active";
  source: "template" | "ai" | "manual";
  city: string | null;
  solarTerm: string;
  overview: string;
  supplements: string[];
  version: number;
  basedOnPlanId: string | null;
  basedOnPlanVersion: number | null;
  sourceSleepAnalysisId: string | null;
  revisionReason: string | null;
  days: DayReference[];
};
type SleepAnalysis = {
  id: string;
  localDate: string;
  originalFileName: string;
  mimeType: string;
  createdAt: string;
  analysis: {
    totalSleepMinutes: number | null;
    deepSleepMinutes: number | null;
    lightSleepMinutes: number | null;
    remSleepMinutes: number | null;
    awakeCount: number | null;
    sleepStart: string | null;
    wakeTime: string | null;
    deviceScore: number | null;
    deviceNotes: string | null;
    visibleMetrics: string[];
    interpretation: string[];
    limitations: string[];
  };
};
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

function sleepMetric(label: string, value: number | string | null, suffix = "") {
  return value === null ? null : <div className="sleep-metric"><span>{label}</span><strong>{value}{suffix}</strong></div>;
}

function revisionChanges(previous: DayReference, next: DayReference): string[] {
  const changes: string[] = [];
  const beforeMovement = previous.content.movement;
  const nextMovement = next.content.movement;
  const beforeDuration = `${beforeMovement.durationMinutes.minimum}–${beforeMovement.durationMinutes.maximum} 分钟`;
  const nextDuration = `${nextMovement.durationMinutes.minimum}–${nextMovement.durationMinutes.maximum} 分钟`;
  if (beforeMovement.category !== nextMovement.category || beforeMovement.intensity !== nextMovement.intensity || beforeDuration !== nextDuration) {
    changes.push(`运动：${activityLabel[beforeMovement.category]} ${beforeDuration} -> ${activityLabel[nextMovement.category]} ${nextDuration}`);
  }
  if (previous.content.nutritionDirection !== next.content.nutritionDirection) changes.push("饮食方向已调整");
  if (previous.content.proteinRangeGrams.minimum !== next.content.proteinRangeGrams.minimum || previous.content.proteinRangeGrams.maximum !== next.content.proteinRangeGrams.maximum) {
    changes.push(`蛋白质：${previous.content.proteinRangeGrams.minimum}–${previous.content.proteinRangeGrams.maximum} g -> ${next.content.proteinRangeGrams.minimum}–${next.content.proteinRangeGrams.maximum} g`);
  }
  if (previous.content.plateGuidance.join("\n") !== next.content.plateGuidance.join("\n")) changes.push("餐盘提示已调整");
  if (previous.content.seasonalVegetables.join("\n") !== next.content.seasonalVegetables.join("\n")) changes.push("时令蔬菜提示已调整");
  if (beforeMovement.safetyReminder !== nextMovement.safetyReminder) changes.push("安全提醒已调整");
  return changes;
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
  const [sleepAnalyses, setSleepAnalyses] = useState<SleepAnalysis[]>([]);
  const [sleepFile, setSleepFile] = useState<File | null>(null);
  const autoCandidateRequested = useRef<string | null>(null);
  const visiblePlan = candidate ?? active;
  const selectedReference = visiblePlan?.days[selectedDay] ?? null;
  const sleepDate = selectedReference?.localDate ?? shanghaiDate();

  useEffect(() => { void reload(); }, [weekStart]);

  useEffect(() => {
    if (!loading && profile && !active && !candidate && autoCandidateRequested.current !== weekStart) {
      autoCandidateRequested.current = weekStart;
      void createCandidate("template");
    }
  }, [loading, profile, active, candidate, weekStart]);

  useEffect(() => {
    let cancelled = false;
    void request<{ analyses: SleepAnalysis[] }>(`/api/v1/health/sleep-analyses/${sleepDate}`)
      .then((result) => { if (!cancelled) setSleepAnalyses(result.analyses); })
      .catch(() => { if (!cancelled) setSleepAnalyses([]); });
    return () => { cancelled = true; };
  }, [sleepDate]);

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
    const optionalNumber = (name: string) => {
      const value = String(form.get(name) ?? "").trim();
      return value ? Number(value) : null;
    };
    const next: Profile = {
      city: String(form.get("city") ?? "").trim() || null,
      basics: {
        sex: String(form.get("sex")) as Profile["basics"]["sex"],
        age: Number(form.get("age")),
        heightCm: Number(form.get("heightCm")),
        weightKg: Number(form.get("weightKg")),
        bodyFatPercent: optionalNumber("bodyFatPercent"),
        waistCm: optionalNumber("waistCm")
      },
      goals: listText(String(form.get("goals") ?? "")),
      stageWeightGoal: { minimumKg: Number(form.get("stageWeightMinimumKg")), maximumKg: Number(form.get("stageWeightMaximumKg")) },
      considerations: listText(String(form.get("considerations") ?? "")),
      activity: {
        sessionsPerWeek: Number(form.get("sessionsPerWeek")),
        usualDurationMinutes: { minimum: Number(form.get("usualDurationMinimum")), maximum: Number(form.get("usualDurationMaximum")) },
        preferredActivities: listText(String(form.get("preferredActivities") ?? "")),
        avoidHighRisk: form.get("avoidHighRisk") === "on"
      },
      food: {
        mealContext: String(form.get("mealContext") ?? "").trim(),
        mealTimes: {
          breakfast: String(form.get("breakfastTime") ?? "").trim(),
          lunch: String(form.get("lunchTime") ?? "").trim(),
          dinner: String(form.get("dinnerTime") ?? "").trim()
        },
        dislikes: listText(String(form.get("dislikes") ?? "")),
        commonFoods: listText(String(form.get("commonFoods") ?? ""))
      },
      supplements: {
        current: listText(String(form.get("currentSupplements") ?? "")),
        considering: listText(String(form.get("consideringSupplements") ?? "")),
        avoids: listText(String(form.get("avoidsSupplements") ?? ""))
      },
      notes: String(form.get("notes") ?? "").trim() || null
    };
    setBusy(true); setError(null);
    try {
      const result = await request<{ profile: StoredProfile }>("/api/v1/health/profile", "PUT", { expectedVersion: profile.version, profile: next });
      setProfile(result.profile); setEditingProfile(false);
    } catch { setError("资料保存失败，原资料没有被覆盖。请刷新后重试。"); }
    finally { setBusy(false); }
  }

  async function analyzeSleepScreenshot() {
    if (!sleepFile) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(sleepFile.type) || sleepFile.size > 6 * 1024 * 1024) {
      setError("请选择不超过 6 MB 的 PNG、JPG 或 WebP 睡眠截图。");
      return;
    }
    setBusy(true); setError(null);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("file_read_failed"));
        reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("file_read_failed"));
        reader.readAsDataURL(sleepFile);
      });
      const result = await request<{ analysis: SleepAnalysis }>("/api/v1/health/sleep-analyses", "POST", {
        localDate: sleepDate,
        fileName: sleepFile.name,
        mimeType: sleepFile.type,
        dataUrl
      });
      setSleepAnalyses((items) => [result.analysis, ...items]);
      setSleepFile(null);
    } catch (requestError) {
      const code = requestError instanceof Error ? (requestError as ApiError).body?.error : undefined;
      setError(code === "sleep_image_analysis_unavailable" ? "视觉分析暂时不可用，原图和分析结果都没有保存。" : "这张截图无法读取，原图和分析结果都没有保存。");
    } finally { setBusy(false); }
  }

  async function createSleepRevisionCandidate(record: SleepAnalysis) {
    if (!active) return;
    setBusy(true); setError(null);
    try {
      const result = await request<{ plan: HealthPlan }>("/api/v1/health/weeks/sleep-revision-candidates", "POST", {
        weekStart,
        sleepAnalysisId: record.id
      });
      setCandidate(result.plan);
      setSelectedDay(Math.max(0, result.plan.days.findIndex((day) => day.localDate === record.localDate)));
    } catch (requestError) {
      const code = requestError instanceof Error ? (requestError as ApiError).body?.error : undefined;
      const message = code === "health_active_plan_required"
        ? "请先确认一份本周参考，再请求睡眠修订。"
        : code === "sleep_analysis_outside_week"
          ? "这次截图不属于当前周，不能用于修订本周参考。"
          : "睡眠修订候选暂时无法生成，原本周参考保持不变。";
      setError(message);
    } finally { setBusy(false); }
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
        <h3 className="wide">基础资料</h3>
        <label><span>当前城市（可留空）</span><input name="city" defaultValue={profile.profile.city ?? ""} maxLength={120} placeholder="例如：呼和浩特" /></label>
        <label><span>性别</span><select name="sex" defaultValue={profile.profile.basics.sex}><option value="male">男</option><option value="female">女</option><option value="other">其他</option></select></label>
        <label><span>年龄</span><input name="age" type="number" min="16" max="120" step="1" defaultValue={profile.profile.basics.age} required /></label>
        <label><span>身高（cm）</span><input name="heightCm" type="number" min="120" max="230" step="1" defaultValue={profile.profile.basics.heightCm} required /></label>
        <label><span>当前体重（kg）</span><input name="weightKg" type="number" min="30" max="300" step="0.1" defaultValue={profile.profile.basics.weightKg} required /></label>
        <label><span>体脂率（%）</span><input name="bodyFatPercent" type="number" min="1" max="70" step="0.1" defaultValue={profile.profile.basics.bodyFatPercent ?? ""} /></label>
        <label><span>腰围（cm）</span><input name="waistCm" type="number" min="40" max="200" step="0.1" defaultValue={profile.profile.basics.waistCm ?? ""} /></label>
        <label className="wide"><span>当前目标（逗号或换行分隔）</span><textarea name="goals" rows={2} defaultValue={profile.profile.goals.join("，")} required /></label>
        <label><span>阶段目标下限（kg）</span><input name="stageWeightMinimumKg" type="number" min="30" max="300" step="0.1" defaultValue={profile.profile.stageWeightGoal.minimumKg} required /></label>
        <label><span>阶段目标上限（kg）</span><input name="stageWeightMaximumKg" type="number" min="30" max="300" step="0.1" defaultValue={profile.profile.stageWeightGoal.maximumKg} required /></label>
        <label className="wide"><span>需要考虑的情况（逗号或换行分隔）</span><textarea name="considerations" rows={3} defaultValue={profile.profile.considerations.join("\n")} required /></label>
        <h3 className="wide">活动偏好</h3>
        <label><span>每周活动次数</span><input name="sessionsPerWeek" type="number" min="0" max="14" step="1" defaultValue={profile.profile.activity.sessionsPerWeek} required /></label>
        <label><span>单次时长下限（分钟）</span><input name="usualDurationMinimum" type="number" min="0" max="360" step="1" defaultValue={profile.profile.activity.usualDurationMinutes.minimum} required /></label>
        <label><span>单次时长上限（分钟）</span><input name="usualDurationMaximum" type="number" min="0" max="480" step="1" defaultValue={profile.profile.activity.usualDurationMinutes.maximum} required /></label>
        <label className="wide"><span>偏好的活动（逗号或换行分隔）</span><textarea name="preferredActivities" rows={2} defaultValue={profile.profile.activity.preferredActivities.join("，")} /></label>
        <label className="health-checkbox wide"><input name="avoidHighRisk" type="checkbox" defaultChecked={profile.profile.activity.avoidHighRisk} /><span>避免高风险或容易受伤的活动建议</span></label>
        <h3 className="wide">饮食与补充剂</h3>
        <label className="wide"><span>用餐场景</span><textarea name="mealContext" rows={2} defaultValue={profile.profile.food.mealContext} required /></label>
        <label><span>早餐时间</span><input name="breakfastTime" type="time" defaultValue={profile.profile.food.mealTimes.breakfast} required /></label>
        <label><span>午餐时间</span><input name="lunchTime" type="time" defaultValue={profile.profile.food.mealTimes.lunch} required /></label>
        <label><span>晚餐时间</span><input name="dinnerTime" type="time" defaultValue={profile.profile.food.mealTimes.dinner} required /></label>
        <label className="wide"><span>不喜欢或不适合的食物（逗号或换行分隔）</span><textarea name="dislikes" rows={2} defaultValue={profile.profile.food.dislikes.join("，")} /></label>
        <label className="wide"><span>常见食物（逗号或换行分隔）</span><textarea name="commonFoods" rows={3} defaultValue={profile.profile.food.commonFoods.join("，")} /></label>
        <label><span>当前补充剂</span><textarea name="currentSupplements" rows={2} defaultValue={profile.profile.supplements.current.join("，")} /></label>
        <label><span>未来考虑的补充剂</span><textarea name="consideringSupplements" rows={2} defaultValue={profile.profile.supplements.considering.join("，")} /></label>
        <label><span>不使用的补充剂</span><textarea name="avoidsSupplements" rows={2} defaultValue={profile.profile.supplements.avoids.join("，")} /></label>
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
        {candidate?.revisionReason && active && candidate.basedOnPlanId === active.id && <section className="health-revision-preview" aria-label="睡眠修订前后差异">
          <header><Sparkles /><div><p className="section-kicker">本次修订依据</p><strong>候选尚未生效</strong></div></header>
          <p>{candidate.revisionReason}</p>
          <div className="health-revision-diff">{candidate.days.map((day) => {
            const previous = active.days.find((item) => item.dayIndex === day.dayIndex);
            const changes = previous ? revisionChanges(previous, day) : [];
            return changes.length > 0 ? <div key={day.id}><strong>{weekday[day.dayIndex]}</strong><span>{changes.join("；")}</span></div> : null;
          })}{candidate.days.every((day) => {
            const previous = active.days.find((item) => item.dayIndex === day.dayIndex);
            return !previous || revisionChanges(previous, day).length === 0;
          }) && <div><strong>本周</strong><span>候选没有改变当前可显示的每日参考；确认前原计划仍保持不变。</span></div>}</div>
        </section>}
        <div className="health-days" role="tablist" aria-label="本周健康参考日期">{visiblePlan.days.map((day) => <button key={day.id} role="tab" aria-selected={selectedDay === day.dayIndex} className={selectedDay === day.dayIndex ? "active" : ""} type="button" onClick={() => setSelectedDay(day.dayIndex)}><span>{weekday[day.dayIndex]}</span><strong>{day.localDate.slice(8)}</strong></button>)}</div>
        {selectedReference && <article className="health-day-detail"><section><header><Leaf /><div><p>饮食方向</p><strong>蛋白质约 {selectedReference.content.proteinRangeGrams.minimum}–{selectedReference.content.proteinRangeGrams.maximum} g / 天</strong></div></header><p>{selectedReference.content.nutritionDirection}</p><ul>{selectedReference.content.plateGuidance.map((item) => <li key={item}>{item}</li>)}</ul><div className="vegetable-tags">{selectedReference.content.seasonalVegetables.map((item) => <span key={item}>{item}</span>)}</div></section><section><header><HeartPulse /><div><p>运动范围</p><strong>{activityLabel[selectedReference.content.movement.category]} · {intensityLabel[selectedReference.content.movement.intensity]}</strong></div></header><p>{selectedReference.content.movement.durationMinutes.maximum === 0 ? "不安排训练；保持日常轻松活动即可。" : `${selectedReference.content.movement.durationMinutes.minimum}–${selectedReference.content.movement.durationMinutes.maximum} 分钟，按当天实际状态自主决定。`}</p><aside>{selectedReference.content.movement.safetyReminder}</aside></section></article>}
        <section className="health-supplements"><p className="section-kicker">补充剂参考</p>{visiblePlan.supplements.map((item) => <p key={item}>{item}</p>)}</section>
      </section> : <div className="health-empty"><HeartPulse /><strong>健康资料已准备好后，会在这里生成一份待你确认的本周参考。</strong></div>}
      <section className="health-sleep-card">
        <header><div><p className="section-kicker">睡眠截图</p><h2>只读取你主动上传的这一张。</h2><small>只分析截图中实际出现的时间、时长、阶段、设备评分和说明；原图不会保存，也不会自动修改健康资料或本周参考。</small></div><div className="health-sleep-actions"><label className="sleep-upload-control"><Upload /><span>{sleepFile ? sleepFile.name : "选择截图"}</span><input aria-label="选择睡眠截图" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => setSleepFile(event.target.files?.[0] ?? null)} /></label><button className="primary-button" type="button" disabled={busy || !sleepFile} onClick={() => void analyzeSleepScreenshot()}>{busy ? <LoaderCircle className="spin" /> : <Sparkles />}上传并分析</button></div></header>
        {sleepAnalyses.length === 0 ? <p className="health-sleep-empty">{sleepDate} 还没有已保存的截图分析。</p> : <div className="health-sleep-results">{sleepAnalyses.map((record) => <article key={record.id}><div className="health-sleep-result-head"><strong>{record.localDate}</strong><small>{record.originalFileName} · {new Date(record.createdAt).toLocaleString("zh-CN")}</small></div><div className="sleep-metrics">{sleepMetric("总睡眠", record.analysis.totalSleepMinutes, " 分钟")}{sleepMetric("深睡", record.analysis.deepSleepMinutes, " 分钟")}{sleepMetric("浅睡", record.analysis.lightSleepMinutes, " 分钟")}{sleepMetric("快速眼动", record.analysis.remSleepMinutes, " 分钟")}{sleepMetric("清醒次数", record.analysis.awakeCount)}{sleepMetric("设备评分", record.analysis.deviceScore, " / 100")}{sleepMetric("入睡", record.analysis.sleepStart)}{sleepMetric("起床", record.analysis.wakeTime)}</div>{record.analysis.deviceNotes && <p>{record.analysis.deviceNotes}</p>}<ul>{record.analysis.interpretation.map((item) => <li key={item}>{item}</li>)}</ul>{active && !candidate && <button className="quiet-button sleep-revision-button" type="button" disabled={busy} onClick={() => void createSleepRevisionCandidate(record)}><Sparkles />根据这次睡眠生成修订候选</button>}<small className="health-sleep-limitations">{record.analysis.limitations.join(" ")}</small></article>)}</div>}
      </section>
    </>}
  </section>;
}
