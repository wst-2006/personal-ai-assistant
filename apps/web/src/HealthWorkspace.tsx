import { useEffect, useRef, useState, type ClipboardEvent, type CSSProperties, type DragEvent, type FormEvent } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight, ClipboardPenLine, Droplets, HeartPulse, Leaf, LoaderCircle, MapPin, MessageCircleQuestion, Quote, RefreshCcw, Save, Send, Sparkles, Upload, X } from "lucide-react";

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
    nutritionTargets?: {
      carbohydrateGrams: { minimum: number; maximum: number };
      fatGrams: { minimum: number; maximum: number };
      fiberGrams: { minimum: number; maximum: number };
      hydrationLiters: { minimum: number; maximum: number };
      macroRatioPercent: { protein: number; carbohydrate: number; fat: number };
    };
    hydrationGuidance?: string[];
    mealExamples?: { breakfast: string[]; lunch: string[]; dinner: string[]; snack: string[] };
    proteinRotationSources?: string[];
    foodReference?: { proteinOptions: string[]; fiberOptions: string[]; carbOptions: string[] };
    plateGuidance: string[];
    seasonalVegetables: string[];
    seasonalGuidance?: string | null;
    seasonalPoem?: { title: string; author: string; excerpt: string; relevance: string } | null;
    movement: { category: "strength" | "volleyball" | "running" | "walking" | "cycling" | "recovery" | "rest"; durationMinutes: { minimum: number; maximum: number }; intensity: "rest" | "low" | "moderate" | "high"; highIntensity: boolean; safetyReminder: string; focus?: string[]; safetyNotes?: string[] };
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
type ManualNumber = number | "";
type ManualNutritionTargets = {
  carbohydrateGrams: { minimum: ManualNumber; maximum: ManualNumber };
  fatGrams: { minimum: ManualNumber; maximum: ManualNumber };
  fiberGrams: { minimum: ManualNumber; maximum: ManualNumber };
  hydrationLiters: { minimum: ManualNumber; maximum: ManualNumber };
  macroRatioPercent: { protein: ManualNumber; carbohydrate: ManualNumber; fat: ManualNumber };
};
type ManualDayDraft = Omit<DayReference["content"], "nutritionTargets"> & { nutritionTargets?: ManualNutritionTargets };
type ManualPlanDraft = { overview: string; supplements: string; days: ManualDayDraft[] };
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
type HealthConversationMessage = {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  source: "app" | "feishu" | "ai";
  content: string;
  needsClarification: boolean | null;
  externalMessageId: string | null;
  createdAt: string;
};
type HealthConversationState = {
  conversation: { id: string; weekStart: string; createdAt: string; updatedAt: string };
  messages: HealthConversationMessage[];
};
type DailyActual = {
  localDate: string;
  proteinGrams: number | null;
  fiberGrams: number | null;
  waterMilliliters: number | null;
  createdAt: string;
  updatedAt: string;
};
type DailyActualDraft = { proteinGrams: string; fiberGrams: string; waterLiters: string };
type HealthAiStage = "idle" | "saving_message" | "replying" | "reply_failed" | "ready" | "preparing_candidate" | "generating_candidate" | "waiting_candidate" | "candidate_ready" | "candidate_failed";
type ApiError = Error & { status?: number; body?: { error?: string; message?: string } };

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3000";
const weekday = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const activityLabel: Record<DayReference["content"]["movement"]["category"], string> = { strength: "力量训练", volleyball: "排球", running: "跑步", walking: "步行", cycling: "骑行", recovery: "轻量恢复", rest: "休息" };
const intensityLabel: Record<DayReference["content"]["movement"]["intensity"], string> = { rest: "休息", low: "低强度", moderate: "中等强度", high: "高强度" };
const healthDraftStoragePrefix = "personal-ai.health-collaboration-draft.v1";

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

function draftLines(value: string) {
  return value.split("\n");
}

function sleepMetric(label: string, value: number | string | null, suffix = "") {
  return value === null ? null : <div className="sleep-metric"><span>{label}</span><strong>{value}{suffix}</strong></div>;
}

function rangeText(range: { minimum: number; maximum: number } | undefined, suffix = "g") {
  return range ? `${range.minimum}–${range.maximum}${suffix}` : "当前参考未提供";
}

const REFERENCE_SCALE_LIMITS:Record<string,{minimum:number;maximum:number}> = {
  protein:{minimum:0,maximum:200}, carb:{minimum:0,maximum:500}, fat:{minimum:0,maximum:150}, fiber:{minimum:0,maximum:60}, water:{minimum:0,maximum:5}
};
function referenceScale(label: string, range: { minimum: number; maximum: number } | undefined, tone: string, suffix = "g") {
  const limits=REFERENCE_SCALE_LIMITS[tone]??{minimum:0,maximum:100};
  const span=Math.max(1,limits.maximum-limits.minimum);
  const start=range?Math.max(0,Math.min(100,(range.minimum-limits.minimum)/span*100)):0;
  const end=range?Math.max(start,Math.min(100,(range.maximum-limits.minimum)/span*100)):0;
  const midpoint=(start+end)/2;
  return <div className="health-target-row" data-tone={tone} data-has-range={range?"true":"false"} style={{"--range-start":`${start}%`,"--range-width":`${end-start}%`,"--range-mid":`${midpoint}%`} as CSSProperties}><span>{label}</span><strong>{rangeText(range, suffix)}</strong><i aria-hidden="true"><b /></i><small>{range?"AI 参考范围":"未提供"}</small></div>;
}

function actualProgress(label: string, actual: number | null, range: { minimum: number; maximum: number } | undefined, tone: string, suffix: string, fallbackMaximum: number) {
  const scaleMaximum = Math.max(range?.maximum ?? fallbackMaximum, 1);
  const fill = actual === null ? 0 : Math.min(100, actual / scaleMaximum * 100);
  const targetMinimum = range ? Math.min(100, range.minimum / scaleMaximum * 100) : 0;
  const status = actual === null
    ? "尚未记录"
    : !range
      ? "已记录实际值"
      : actual < range.minimum
        ? `距参考下限 ${formatActualValue(range.minimum - actual)}${suffix}`
        : actual <= range.maximum
          ? "已进入参考范围"
          : `高于参考上限 ${formatActualValue(actual - range.maximum)}${suffix}`;
  return <article className="health-actual-progress" data-tone={tone} style={{ "--actual-fill": `${fill}%`, "--target-min": `${targetMinimum}%` } as CSSProperties}>
    <header><span>{label}</span><strong>{actual === null ? "未记录" : `${formatActualValue(actual)}${suffix}`}</strong></header>
    <div aria-hidden="true"><i />{range ? <b /> : null}</div>
    <footer><span>{range ? `参考 ${rangeText(range, suffix)}` : "当前参考未提供范围"}</span><em>{status}</em></footer>
  </article>;
}

function formatActualValue(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
}

function actualDraftFrom(record: DailyActual | null): DailyActualDraft {
  return {
    proteinGrams: record?.proteinGrams === null || record?.proteinGrams === undefined ? "" : String(record.proteinGrams),
    fiberGrams: record?.fiberGrams === null || record?.fiberGrams === undefined ? "" : String(record.fiberGrams),
    waterLiters: record?.waterMilliliters === null || record?.waterMilliliters === undefined ? "" : formatActualValue(record.waterMilliliters / 1000)
  };
}

function listOrMissing(items: string[] | undefined, className?: string) {
  return items?.length ? <ul className={className}>{items.map((item)=><li key={item}>{item}</li>)}</ul> : <p className="health-field-missing">当前参考未提供；重新请求 DeepSeek 候选后可补齐。</p>;
}

function conversationTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(date);
}

function healthAiStatusCopy(stage: HealthAiStage) {
  switch (stage) {
    case "saving_message": return "正在保存你的健康说明…";
    case "replying": return "内容已保存，DeepSeek 正在回应…";
    case "reply_failed": return "内容已经保存，但 DeepSeek 尚未回应；可直接重试，不要重复输入。";
    case "ready": return "DeepSeek 已回应。信息足够时，可以根据本页交流生成候选。";
    case "preparing_candidate": return "正在整理本页交流、健康资料与本周日程…";
    case "generating_candidate": return "DeepSeek 正在生成完整的七日健康候选，返回前会经过结构校验…";
    case "waiting_candidate": return "完整七日候选仍在生成，请不要重复点击；本次请求不会因超时自动重复扣费重试。";
    case "candidate_ready": return "候选已经生成并通过结构校验，已放入下方的待确认区。";
    case "candidate_failed": return "本次候选没有写入；现有生效参考保持不变。";
    default: return "交流只保存在当前健康周，不会进入复盘或普通对话。";
  }
}

function healthCollaborationSummaryCopy(input: {
  stage: HealthAiStage;
  hasDraft: boolean;
  replyPending: boolean;
  needsClarification: boolean;
  userMessageCount: number;
  hasReadError: boolean;
}) {
  if (input.hasReadError) return "交流暂时无法读取，现有参考不受影响";
  if (input.hasDraft) return "有一份尚未发送的健康说明";
  if (input.replyPending) return "说明已保存，等待 DeepSeek 回应";
  if (input.needsClarification) return "DeepSeek 等待你补充这一周的情况";
  if (["saving_message", "replying", "preparing_candidate", "generating_candidate", "waiting_candidate", "candidate_ready", "candidate_failed", "reply_failed"].includes(input.stage)) return healthAiStatusCopy(input.stage);
  if (input.userMessageCount > 0) return "本周交流已保存，需要时可展开查看或补充";
  return "尚未交流，需要时展开说明本周情况";
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
  if (JSON.stringify(previous.content.nutritionTargets ?? null) !== JSON.stringify(next.content.nutritionTargets ?? null)) changes.push("营养目标范围已调整");
  if (JSON.stringify(previous.content.mealExamples ?? null) !== JSON.stringify(next.content.mealExamples ?? null)) changes.push("三餐示例已调整");
  if (JSON.stringify(previous.content.proteinRotationSources ?? null) !== JSON.stringify(next.content.proteinRotationSources ?? null)) changes.push("蛋白轮换已调整");
  if (JSON.stringify(previous.content.foodReference ?? null) !== JSON.stringify(next.content.foodReference ?? null)) changes.push("替代食材参考已调整");
  if (previous.content.seasonalVegetables.join("\n") !== next.content.seasonalVegetables.join("\n")) changes.push("时令蔬菜提示已调整");
  if ((previous.content.seasonalGuidance ?? null) !== (next.content.seasonalGuidance ?? null)) changes.push("时令生活提示已调整");
  if (JSON.stringify(previous.content.seasonalPoem ?? null) !== JSON.stringify(next.content.seasonalPoem ?? null)) changes.push("时令诗词已调整");
  if (beforeMovement.safetyReminder !== nextMovement.safetyReminder) changes.push("安全提醒已调整");
  if (JSON.stringify(beforeMovement.focus ?? null) !== JSON.stringify(nextMovement.focus ?? null)) changes.push("训练重点已调整");
  if (JSON.stringify(beforeMovement.safetyNotes ?? null) !== JSON.stringify(nextMovement.safetyNotes ?? null)) changes.push("分条注意事项已调整");
  if (beforeMovement.highIntensity !== nextMovement.highIntensity) changes.push(nextMovement.highIntensity ? "调整为高强度日" : "不再标记为高强度日");
  return changes;
}

function planRevisionChanges(previous: HealthPlan, next: HealthPlan): string[] {
  const changes: string[] = [];
  if (previous.overview !== next.overview) changes.push("本周概览已调整");
  if (previous.supplements.join("\n") !== next.supplements.join("\n")) changes.push("补充剂参考已调整");
  if (previous.city !== next.city) changes.push(`城市参考：${previous.city ?? "未设置"} -> ${next.city ?? "未设置"}`);
  if (previous.solarTerm !== next.solarTerm) changes.push(`节气参考：${previous.solarTerm} -> ${next.solarTerm}`);
  return changes;
}

function manualDraftFromPlan(plan: HealthPlan): ManualPlanDraft {
  return {
    overview: plan.overview,
    supplements: plan.supplements.join("\n"),
    days: plan.days.map((day) => ({
      ...day.content,
      proteinRangeGrams: { ...day.content.proteinRangeGrams },
      nutritionTargets: day.content.nutritionTargets ? {
        carbohydrateGrams: { ...day.content.nutritionTargets.carbohydrateGrams },
        fatGrams: { ...day.content.nutritionTargets.fatGrams },
        fiberGrams: { ...day.content.nutritionTargets.fiberGrams },
        hydrationLiters: { ...day.content.nutritionTargets.hydrationLiters },
        macroRatioPercent: { ...day.content.nutritionTargets.macroRatioPercent }
      } : undefined,
      hydrationGuidance: day.content.hydrationGuidance ? [...day.content.hydrationGuidance] : undefined,
      mealExamples: day.content.mealExamples ? {
        breakfast: [...day.content.mealExamples.breakfast], lunch: [...day.content.mealExamples.lunch], dinner: [...day.content.mealExamples.dinner], snack: [...day.content.mealExamples.snack]
      } : undefined,
      proteinRotationSources: day.content.proteinRotationSources ? [...day.content.proteinRotationSources] : undefined,
      foodReference: day.content.foodReference ? {
        proteinOptions: [...day.content.foodReference.proteinOptions], fiberOptions: [...day.content.foodReference.fiberOptions], carbOptions: [...day.content.foodReference.carbOptions]
      } : undefined,
      plateGuidance: [...day.content.plateGuidance],
      seasonalVegetables: [...day.content.seasonalVegetables],
      seasonalGuidance: day.content.seasonalGuidance ?? null,
      seasonalPoem: day.content.seasonalPoem ? { ...day.content.seasonalPoem } : null,
      movement: { ...day.content.movement, durationMinutes: { ...day.content.movement.durationMinutes }, focus: day.content.movement.focus ? [...day.content.movement.focus] : undefined, safetyNotes: day.content.movement.safetyNotes ? [...day.content.movement.safetyNotes] : undefined }
    }))
  };
}

function emptyManualNutritionTargets(): ManualNutritionTargets {
  return {
    carbohydrateGrams: { minimum: "", maximum: "" },
    fatGrams: { minimum: "", maximum: "" },
    fiberGrams: { minimum: "", maximum: "" },
    hydrationLiters: { minimum: "", maximum: "" },
    macroRatioPercent: { protein: "", carbohydrate: "", fat: "" }
  };
}

function manualNumber(value: string): ManualNumber {
  return value === "" ? "" : Number(value);
}

function completeManualNutritionTargets(targets: ManualNutritionTargets | undefined) {
  if (!targets) return undefined;
  const values = [
    targets.carbohydrateGrams.minimum, targets.carbohydrateGrams.maximum,
    targets.fatGrams.minimum, targets.fatGrams.maximum,
    targets.fiberGrams.minimum, targets.fiberGrams.maximum,
    targets.hydrationLiters.minimum, targets.hydrationLiters.maximum,
    targets.macroRatioPercent.protein, targets.macroRatioPercent.carbohydrate, targets.macroRatioPercent.fat
  ];
  if (values.some((value) => value === "")) throw new Error("manual_nutrition_targets_incomplete");
  return {
    carbohydrateGrams: { minimum: Number(targets.carbohydrateGrams.minimum), maximum: Number(targets.carbohydrateGrams.maximum) },
    fatGrams: { minimum: Number(targets.fatGrams.minimum), maximum: Number(targets.fatGrams.maximum) },
    fiberGrams: { minimum: Number(targets.fiberGrams.minimum), maximum: Number(targets.fiberGrams.maximum) },
    hydrationLiters: { minimum: Number(targets.hydrationLiters.minimum), maximum: Number(targets.hydrationLiters.maximum) },
    macroRatioPercent: { protein: Number(targets.macroRatioPercent.protein), carbohydrate: Number(targets.macroRatioPercent.carbohydrate), fat: Number(targets.macroRatioPercent.fat) }
  };
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

export function HealthWorkspace({ onAskHealth, onCreateTask }:{
  onAskHealth?:(prompt:string)=>void;
  onCreateTask?:(draft:{title:string;localDate:string;notes:string})=>void;
}) {
  const [weekStart, setWeekStart] = useState(() => weekStartFor(shanghaiDate()));
  const [profile, setProfile] = useState<StoredProfile | null>(null);
  const [active, setActive] = useState<HealthPlan | null>(null);
  const [candidate, setCandidate] = useState<HealthPlan | null>(null);
  const [selectedDay, setSelectedDay] = useState(0);
  const [collaboration, setCollaboration] = useState<HealthConversationState | null>(null);
  const [collaborationDraft, setCollaborationDraft] = useState("");
  const [collaborationError, setCollaborationError] = useState<string | null>(null);
  const [collaborationExpanded, setCollaborationExpanded] = useState(false);
  const [healthAiStage, setHealthAiStage] = useState<HealthAiStage>("idle");
  const [editingProfile, setEditingProfile] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sleepAnalyses, setSleepAnalyses] = useState<SleepAnalysis[]>([]);
  const [sleepFile, setSleepFile] = useState<File | null>(null);
  const [sleepDropActive, setSleepDropActive] = useState(false);
  const [manualDraft, setManualDraft] = useState<ManualPlanDraft | null>(null);
  const [sleepImageAnalysisAvailable, setSleepImageAnalysisAvailable] = useState<boolean | null>(null);
  const [feishuHealthSyncAvailable, setFeishuHealthSyncAvailable] = useState<boolean | null>(null);
  const [dailyActual, setDailyActual] = useState<DailyActual | null>(null);
  const [dailyActualDraft, setDailyActualDraft] = useState<DailyActualDraft>(() => actualDraftFrom(null));
  const [dailyActualLoading, setDailyActualLoading] = useState(false);
  const [dailyActualSaving, setDailyActualSaving] = useState(false);
  const [dailyActualMessage, setDailyActualMessage] = useState<string | null>(null);
  const sleepFileInputRef = useRef<HTMLInputElement | null>(null);
  const candidateSectionRef = useRef<HTMLElement | null>(null);
  const generationAttemptRef = useRef(0);
  const visiblePlan = candidate ?? active;
  const selectedReference = visiblePlan?.days[selectedDay] ?? null;
  const actualDate = selectedReference?.localDate ?? addDays(weekStart, selectedDay);
  const actualReference = active?.days.find((day) => day.localDate === actualDate) ?? null;
  const actualDateRef = useRef(actualDate);
  actualDateRef.current = actualDate;
  const sleepDate = selectedReference?.localDate ?? shanghaiDate();
  const candidateIsUneditedSleepRevision = candidate?.source === "ai" && candidate.sourceSleepAnalysisId !== null;
  const lastCollaborationMessage = collaboration?.messages.at(-1) ?? null;
  const replyPending = lastCollaborationMessage?.role === "user";
  const collaborationUserMessageCount = collaboration?.messages.filter((message) => message.role === "user").length ?? 0;
  const collaborationSummary = healthCollaborationSummaryCopy({
    stage: healthAiStage,
    hasDraft: Boolean(collaborationDraft.trim()),
    replyPending,
    needsClarification: lastCollaborationMessage?.role === "assistant" && lastCollaborationMessage.needsClarification === true,
    userMessageCount: collaborationUserMessageCount,
    hasReadError: Boolean(collaborationError)
  });

  useEffect(() => { void reload(); }, [weekStart]);
  useEffect(() => { setCollaborationExpanded(false); }, [weekStart]);
  useEffect(() => {
    try {
      setCollaborationDraft(window.localStorage.getItem(`${healthDraftStoragePrefix}.${weekStart}`) ?? "");
    } catch {
      setCollaborationDraft("");
    }
  }, [weekStart]);
  useEffect(() => {
    const timeout = window.setTimeout(() => {
      try {
        const key = `${healthDraftStoragePrefix}.${weekStart}`;
        if (collaborationDraft) window.localStorage.setItem(key, collaborationDraft);
        else window.localStorage.removeItem(key);
      } catch {
        // Draft persistence is a convenience; the saved conversation remains authoritative.
      }
    }, 180);
    return () => window.clearTimeout(timeout);
  }, [collaborationDraft, weekStart]);
  useEffect(() => {
    let cancelled = false;
    void request<{ sleepImageAnalysis: boolean; feishuClarificationSync: boolean }>("/api/v1/health/capabilities")
      .then((result) => { if (!cancelled) { setSleepImageAnalysisAvailable(result.sleepImageAnalysis); setFeishuHealthSyncAvailable(result.feishuClarificationSync); } })
      .catch(() => { if (!cancelled) { setSleepImageAnalysisAvailable(false); setFeishuHealthSyncAvailable(false); } });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void request<{ analyses: SleepAnalysis[] }>(`/api/v1/health/sleep-analyses/${sleepDate}`)
      .then((result) => { if (!cancelled) setSleepAnalyses(result.analyses); })
      .catch(() => { if (!cancelled) setSleepAnalyses([]); });
    return () => { cancelled = true; };
  }, [sleepDate]);

  useEffect(() => {
    let cancelled = false;
    setDailyActualLoading(true);
    setDailyActual(null);
    setDailyActualDraft(actualDraftFrom(null));
    setDailyActualMessage(null);
    void request<{ actual: DailyActual | null }>(`/api/v1/health/days/${actualDate}/actual`)
      .then((result) => {
        if (cancelled) return;
        setDailyActual(result.actual);
        setDailyActualDraft(actualDraftFrom(result.actual));
      })
      .catch(() => {
        if (cancelled) return;
        setDailyActual(null);
        setDailyActualDraft(actualDraftFrom(null));
        setDailyActualMessage("实际记录暂时无法读取；健康参考本身不受影响。");
      })
      .finally(() => { if (!cancelled) setDailyActualLoading(false); });
    return () => { cancelled = true; };
  }, [actualDate]);

  async function reload() {
    setLoading(true);
    setCollaborationError(null);
    try {
      const collaborationRequest = request<HealthConversationState>(`/api/v1/health/weeks/${weekStart}/collaboration`).catch(() => null);
      const [profileResult, weekResult, collaborationResult] = await Promise.all([
        request<{ profile: StoredProfile | null }>("/api/v1/health/profile"),
        request<{ active: HealthPlan | null; candidate: HealthPlan | null }>(`/api/v1/health/weeks/${weekStart}`),
        collaborationRequest
      ]);
      setProfile(profileResult.profile);
      setActive(weekResult.active);
      setCandidate(weekResult.candidate);
      setCollaboration(collaborationResult);
      if (!collaborationResult) setCollaborationError("本周健康交流暂时无法读取；现有健康参考仍可查看，数据库迁移完成后可在这里继续交流。");
      else if (collaborationResult.messages.at(-1)?.role === "user") setHealthAiStage("reply_failed");
      else setHealthAiStage("idle");
      setSelectedDay(0);
      setError(null);
    } catch {
      setError("健康参考暂时无法读取，请确认本机 API 正在运行。");
    } finally {
      setLoading(false);
    }
  }

  async function refreshCollaboration() {
    try {
      const result = await request<HealthConversationState>(`/api/v1/health/weeks/${weekStart}/collaboration`);
      setCollaboration(result);
      return result;
    } catch {
      setCollaborationError("本周健康交流暂时无法读取；已经确认的健康参考不会受影响。");
      return null;
    }
  }

  async function sendHealthMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = collaborationDraft.trim();
    if (!collaboration || !content || busy || replyPending) return;
    setBusy(true); setError(null); setCollaborationError(null); setHealthAiStage("saving_message");
    let saved: HealthConversationState;
    try {
      saved = await request<HealthConversationState>(`/api/v1/health/collaborations/${collaboration.conversation.id}/messages`, "POST", { content });
      setCollaboration(saved);
      setCollaborationDraft("");
    } catch (requestError) {
      const code = requestError instanceof Error ? (requestError as ApiError).body?.error : undefined;
      if (code === "health_collaboration_reply_pending") {
        await refreshCollaboration();
        setHealthAiStage("reply_failed");
        setCollaborationError("上一条说明已经保存，当前只需重试 DeepSeek 回应，不需要再次发送。");
      } else {
        setHealthAiStage("idle");
        setCollaborationError("健康说明没有保存成功，请确认本机 API 正在运行后再试；输入内容仍保留在这里。");
      }
      setBusy(false);
      return;
    }

    setHealthAiStage("replying");
    try {
      const replied = await request<HealthConversationState>(`/api/v1/health/collaborations/${saved.conversation.id}/reply-last`, "POST");
      setCollaboration(replied);
      setHealthAiStage("ready");
    } catch (requestError) {
      const serverMessage = requestError instanceof Error ? (requestError as ApiError).body?.message : undefined;
      setHealthAiStage("reply_failed");
      setCollaborationError(serverMessage ?? "你的健康说明已经保存，但 DeepSeek 暂时没有返回；直接点击“重试回应”即可。");
    } finally {
      setBusy(false);
    }
  }

  async function retryHealthReply() {
    if (!collaboration || !replyPending || busy) return;
    setBusy(true); setError(null); setCollaborationError(null); setHealthAiStage("replying");
    try {
      const replied = await request<HealthConversationState>(`/api/v1/health/collaborations/${collaboration.conversation.id}/reply-last`, "POST");
      setCollaboration(replied);
      setHealthAiStage("ready");
    } catch (requestError) {
      const serverMessage = requestError instanceof Error ? (requestError as ApiError).body?.message : undefined;
      setHealthAiStage("reply_failed");
      setCollaborationError(serverMessage ?? "DeepSeek 仍未返回回应；你的原文已经保存，不需要重复输入。");
    } finally {
      setBusy(false);
    }
  }

  async function createCandidate() {
    const attempt = generationAttemptRef.current + 1;
    generationAttemptRef.current = attempt;
    setBusy(true); setError(null); setCollaborationError(null); setHealthAiStage("preparing_candidate");
    const generatingTimer = window.setTimeout(() => {
      if (generationAttemptRef.current === attempt) setHealthAiStage("generating_candidate");
    }, 700);
    const waitingTimer = window.setTimeout(() => {
      if (generationAttemptRef.current === attempt) setHealthAiStage("waiting_candidate");
    }, 18_000);
    try {
      const result = await request<{ plan: HealthPlan }>("/api/v1/health/weeks/ai-candidates", "POST", {
        weekStart
      });
      setCandidate(result.plan); setSelectedDay(0); setHealthAiStage("candidate_ready"); setCollaborationExpanded(false);
      window.requestAnimationFrame(() => candidateSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    } catch (requestError) {
      const code = requestError instanceof Error ? (requestError as ApiError).body?.error : undefined;
      const serverMessage = requestError instanceof Error ? (requestError as ApiError).body?.message : undefined;
      setHealthAiStage("candidate_failed");
      setError(code === "health_profile_required"
        ? "请先保存健康资料，再生成本周参考。"
        : serverMessage ?? "DeepSeek 暂时无法生成候选，现有参考保持不变；系统没有写入固定替代内容。");
    } finally {
      window.clearTimeout(generatingTimer);
      window.clearTimeout(waitingTimer);
      setBusy(false);
    }
  }

  async function confirmCandidate() {
    if (!candidate) return;
    setBusy(true); setError(null);
    try {
      const result = await request<{ plan: HealthPlan }>(`/api/v1/health/weeks/${candidate.id}/confirm`, "POST", { expectedVersion: candidate.version });
      setActive(result.plan); setCandidate(null);
    } catch (requestError) {
      const code = requestError instanceof Error ? (requestError as ApiError).body?.error : undefined;
      if (code === "health_plan_base_changed" || code === "health_profile_version_conflict") {
        await reload();
        setError(code === "health_plan_base_changed" ? "生效版本已经变化，这份旧候选没有覆盖新内容。请重新生成修订候选。" : "健康资料已经更新，这份旧候选没有生效。请基于最新资料重新生成。");
      } else setError("确认失败，候选仍保留。请刷新后重试。");
    }
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
    if (sleepImageAnalysisAvailable === false) {
      setError("睡眠截图分析尚未配置可用的视觉模型；本周健康参考的其他功能仍可正常使用。");
      return;
    }
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

  function selectSleepFile(file: File | null) {
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 6 * 1024 * 1024) {
      setSleepFile(null);
      setError("请选择不超过 6 MB 的 PNG、JPG 或 WebP 睡眠截图。");
      return;
    }
    const extension = file.type === "image/jpeg" ? "jpg" : file.type.split("/")[1];
    const namedFile = file.name.trim() ? file : new File([file], `sleep-${sleepDate}.${extension}`, { type: file.type, lastModified: file.lastModified });
    setSleepFile(namedFile);
    setError(null);
  }

  function transferredImage(files: FileList | File[]): File | null {
    return Array.from(files).find((file) => ["image/png", "image/jpeg", "image/webp"].includes(file.type)) ?? null;
  }

  function handleSleepDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setSleepDropActive(false);
    if (sleepImageAnalysisAvailable === false) return;
    const file = transferredImage(event.dataTransfer.files);
    if (!file) {
      setError("拖入内容中没有可用的 PNG、JPG 或 WebP 图片。");
      return;
    }
    selectSleepFile(file);
  }

  function handleSleepPaste(event: ClipboardEvent<HTMLDivElement>) {
    if (sleepImageAnalysisAvailable === false) return;
    const file = transferredImage(event.clipboardData.files);
    if (!file) {
      setError("剪贴板中没有可用的 PNG、JPG 或 WebP 图片。");
      return;
    }
    event.preventDefault();
    selectSleepFile(file);
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

  function openManualEditor() {
    const source = candidate ?? active;
    if (!source) return;
    setManualDraft(manualDraftFromPlan(source));
    setSelectedDay(0);
    setError(null);
  }

  function updateManualDay(patch: Partial<ManualDayDraft>) {
    setManualDraft((current) => {
      if (!current) return current;
      const days = [...current.days];
      days[selectedDay] = { ...days[selectedDay]!, ...patch };
      return { ...current, days };
    });
  }

  function updateManualNutritionTargets(patch: (current: ManualNutritionTargets) => ManualNutritionTargets) {
    setManualDraft((current) => {
      if (!current) return current;
      const days = [...current.days];
      const day = days[selectedDay]!;
      days[selectedDay] = { ...day, nutritionTargets: patch(day.nutritionTargets ?? emptyManualNutritionTargets()) };
      return { ...current, days };
    });
  }

  function updateManualPoem(patch: Partial<NonNullable<DayReference["content"]["seasonalPoem"]>>) {
    const current = manualDraft?.days[selectedDay]?.seasonalPoem ?? { title: "", author: "", excerpt: "", relevance: "" };
    updateManualDay({ seasonalPoem: { ...current, ...patch } });
  }

  function updateManualMovement(patch: Partial<DayReference["content"]["movement"]>) {
    setManualDraft((current) => {
      if (!current) return current;
      const days = [...current.days];
      const day = days[selectedDay]!;
      days[selectedDay] = { ...day, movement: { ...day.movement, ...patch } };
      return { ...current, days };
    });
  }

  async function saveManualCandidate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!manualDraft) return;
    setBusy(true); setError(null);
    try {
      const content = {
        ...manualDraft,
        overview: manualDraft.overview.trim(),
        supplements: listText(manualDraft.supplements),
        days: manualDraft.days.map((day) => ({
          ...day,
          nutritionTargets: completeManualNutritionTargets(day.nutritionTargets),
          mealExamples: day.mealExamples ? {
            breakfast: listText(day.mealExamples.breakfast.join("\n")),
            lunch: listText(day.mealExamples.lunch.join("\n")),
            dinner: listText(day.mealExamples.dinner.join("\n")),
            snack: listText(day.mealExamples.snack.join("\n"))
          } : undefined,
          proteinRotationSources: day.proteinRotationSources?.length ? listText(day.proteinRotationSources.join("\n")) : undefined,
          foodReference: day.foodReference ? {
            proteinOptions: listText(day.foodReference.proteinOptions.join("\n")),
            fiberOptions: listText(day.foodReference.fiberOptions.join("\n")),
            carbOptions: listText(day.foodReference.carbOptions.join("\n"))
          } : undefined,
          plateGuidance: listText(day.plateGuidance.join("\n")),
          seasonalVegetables: listText(day.seasonalVegetables.join("\n")),
          seasonalGuidance: day.seasonalGuidance?.trim() || null,
          seasonalPoem: day.seasonalPoem?.excerpt.trim()
            ? {
                title: day.seasonalPoem.title.trim(),
                author: day.seasonalPoem.author.trim(),
                excerpt: day.seasonalPoem.excerpt.trim(),
                relevance: day.seasonalPoem.relevance.trim()
              }
            : null,
          movement: {
            ...day.movement,
            focus: day.movement.focus?.length ? listText(day.movement.focus.join("\n")) : undefined,
            safetyNotes: day.movement.safetyNotes?.length ? listText(day.movement.safetyNotes.join("\n")) : undefined
          }
        }))
      };
      const result = candidate
        ? await request<{ plan: HealthPlan }>(`/api/v1/health/weeks/${candidate.id}/manual-candidate`, "PUT", { expectedVersion: candidate.version, content })
        : await request<{ plan: HealthPlan }>("/api/v1/health/weeks/manual-candidates", "POST", { weekStart, content });
      setCandidate(result.plan);
      setManualDraft(null);
    } catch (saveError) {
      setError(saveError instanceof Error && saveError.message === "manual_nutrition_targets_incomplete"
        ? "营养目标已启用，请把碳水、脂肪、纤维、饮水和三大营养素比例填写完整；也可以关闭这一组目标。"
        : "手动候选保存失败，当前生效参考没有被覆盖。请检查范围、必填列表和三大营养素比例后重试。");
    } finally { setBusy(false); }
  }

  async function saveDailyActual(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const targetDate = actualDate;
    const proteinGrams = dailyActualDraft.proteinGrams.trim() === "" ? null : Number(dailyActualDraft.proteinGrams);
    const fiberGrams = dailyActualDraft.fiberGrams.trim() === "" ? null : Number(dailyActualDraft.fiberGrams);
    const waterLiters = dailyActualDraft.waterLiters.trim() === "" ? null : Number(dailyActualDraft.waterLiters);
    if ((proteinGrams !== null && (!Number.isInteger(proteinGrams) || proteinGrams < 0 || proteinGrams > 1000))
      || (fiberGrams !== null && (!Number.isInteger(fiberGrams) || fiberGrams < 0 || fiberGrams > 200))
      || (waterLiters !== null && (!Number.isFinite(waterLiters) || waterLiters < 0 || waterLiters > 10))) {
      setDailyActualMessage("请检查数值：蛋白质和纤维使用整数克，饮水使用 0–10 L。");
      return;
    }
    setDailyActualSaving(true);
    setDailyActualMessage(null);
    try {
      const result = await request<{ actual: DailyActual | null }>(`/api/v1/health/days/${targetDate}/actual`, "PUT", {
        proteinGrams,
        fiberGrams,
        waterMilliliters: waterLiters === null ? null : Math.round(waterLiters * 1000)
      });
      if (actualDateRef.current !== targetDate) return;
      setDailyActual(result.actual);
      setDailyActualDraft(actualDraftFrom(result.actual));
      setDailyActualMessage(result.actual ? "当日实际记录已保存。" : "当日实际记录已清空。");
    } catch {
      if (actualDateRef.current !== targetDate) return;
      setDailyActualMessage("实际记录没有保存，请稍后重试。");
    } finally {
      setDailyActualSaving(false);
    }
  }

  function askAbout(kind: "food" | "movement") {
    if (!selectedReference || !visiblePlan) return;
    const date = selectedReference.localDate;
    const referenceState = candidate ? "待确认健康候选" : "已确认健康参考";
    const prompt = kind === "food"
      ? `请根据我 ${date} 的${referenceState}，回答一个具体饮食问题。当前参考是：${selectedReference.content.nutritionDirection}；蛋白质范围 ${selectedReference.content.proteinRangeGrams.minimum}–${selectedReference.content.proteinRangeGrams.maximum} 克；时令蔬菜提示：${selectedReference.content.seasonalVegetables.join("、")}。请先问我具体想吃什么或当前用餐场景，不要自动修改本周健康参考，也不要创建任务。`
      : `请根据我 ${date} 的${referenceState}，回答一个具体运动问题。当前参考是：${activityLabel[selectedReference.content.movement.category]}，${selectedReference.content.movement.durationMinutes.minimum}–${selectedReference.content.movement.durationMinutes.maximum} 分钟，${intensityLabel[selectedReference.content.movement.intensity]}；安全提醒：${selectedReference.content.movement.safetyReminder}。请先问我具体想了解什么，不要自动修改本周健康参考，也不要创建任务。`;
    onAskHealth?.(prompt);
  }

  function createTaskFromMovement() {
    if (!selectedReference || !active || candidate || !onCreateTask) return;
    const movement = selectedReference.content.movement;
    onCreateTask({
      title: `${activityLabel[movement.category]}（健康参考）`,
      localDate: selectedReference.localDate,
      notes: `来源：${selectedReference.localDate} 已确认健康参考（${active.solarTerm}${active.city ? ` · ${active.city}` : ""}）。建议范围：${movement.durationMinutes.minimum}–${movement.durationMinutes.maximum} 分钟，${intensityLabel[movement.intensity]}。安全提醒：${movement.safetyReminder}。原健康参考继续保留；本任务的起止时间和专注结构需单独确认。`
    });
  }

  return <section className="health-workspace">
    <header className="health-heading">
      <div><p className="section-kicker">健康参考</p><h1>周笺定方向，日处方给参考。</h1><p>把本周目标落到今天可以怎样吃、怎样动；不安排任务、不要求打卡，也不冒充医疗建议。</p></div>
      <div className="health-week-switcher"><button type="button" disabled={busy} aria-label="上一周健康参考" onClick={() => setWeekStart(addDays(weekStart, -7))}><ChevronLeft /></button><div><strong>{weekStart} 起</strong><small>周日到周六</small></div><button type="button" disabled={busy} aria-label="下一周健康参考" onClick={() => setWeekStart(addDays(weekStart, 7))}><ChevronRight /></button></div>
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
      <section className={`health-collaboration ${collaborationExpanded ? "is-expanded" : "is-collapsed"}`} aria-label="本周健康交流">
        <button className="health-collaboration-toggle" type="button" aria-expanded={collaborationExpanded} aria-controls="health-collaboration-panel" onClick={() => setCollaborationExpanded((expanded) => !expanded)}>
          <span className="health-collaboration-title"><span className="section-kicker">本周笔谈</span><strong>{collaborationSummary}</strong></span>
          <span className="health-collaboration-meta"><span>{collaborationUserMessageCount} 次说明</span><span>{collaborationExpanded ? "收起交流" : "展开交流"}</span><ChevronDown aria-hidden="true" /></span>
        </button>
        {collaborationExpanded && <div className="health-collaboration-panel" id="health-collaboration-panel">
          <p className="health-collaboration-note">这里是 {weekStart} 起这一周的独立健康交流，不会混入复盘、普通对话或网络日记。{feishuHealthSyncAvailable === true ? "需要你补充时，问题也会同步到飞书。" : feishuHealthSyncAvailable === false ? "当前未连接飞书健康追问，本页仍可完成全部交流。" : ""}</p>
          <div className="health-conversation-ledger" aria-live="polite">
            {collaboration?.messages.length ? collaboration.messages.map((message) => <article key={message.id} data-role={message.role}>
              <div><strong>{message.role === "user" ? "你" : "DeepSeek"}</strong><span>{message.source === "feishu" ? "来自飞书 · " : ""}{conversationTime(message.createdAt)}</span>{message.role === "assistant" && message.needsClarification && <i>待补充</i>}</div>
              <p>{message.content}</p>
            </article>) : <div className="health-conversation-empty"><Quote /><div><strong>尚未起笔</strong><p>可以直接写下作息、训练、饮食、饮水、正在服用的药物或补充剂，以及这一周的特殊安排。DeepSeek 会先澄清，不会直接改计划。</p></div></div>}
          </div>
          <form className="health-collaboration-composer" onSubmit={sendHealthMessage}>
            <label htmlFor="health-collaboration-input">告诉 DeepSeek 这一周真实需要考虑的情况</label>
            <textarea id="health-collaboration-input" aria-label="本周健康想法" rows={5} maxLength={4000} value={collaborationDraft} onChange={(event) => setCollaborationDraft(event.target.value)} placeholder="例如：开学前希望早睡早起；每周三次力量、三次有氧；最近在喝中药，需要保守考虑饮水与补充剂安排……" />
            <footer>
              <small>{profile ? "输入草稿会保留；发送成功后原文会保存到本周健康交流。" : "请先在上方保存健康资料，DeepSeek 才能结合资料回应。"}</small>
              {replyPending ? <button className="primary-button" type="button" disabled={busy} onClick={() => void retryHealthReply()}>{healthAiStage === "replying" ? <LoaderCircle className="spin" /> : <RefreshCcw />}重试回应</button> : <button className="primary-button" type="submit" disabled={busy || !profile || !collaboration || !collaborationDraft.trim()}>{healthAiStage === "saving_message" || healthAiStage === "replying" ? <LoaderCircle className="spin" /> : <Send />}{healthAiStage === "saving_message" ? "正在保存" : healthAiStage === "replying" ? "等待回应" : "发送给 DeepSeek"}</button>}
            </footer>
          </form>
          <div className={`health-ai-status ${healthAiStage}`} role="status"><span aria-hidden="true" />{healthAiStatusCopy(healthAiStage)}</div>
          {collaborationError && <div className="health-collaboration-error" role="alert">{collaborationError}</div>}
        </div>}
      </section>
      <section className="health-generation">
        <div><p className="section-kicker">本周候选</p><h2>{candidate ? "候选尚未生效" : active ? "当前参考保持稳定" : "生成一份本周参考"}</h2><small>DeepSeek 会读取本周健康交流、已保存资料和已有日程；只生成候选，确认前不会改变健康栏目。</small></div>
        <div className="health-generation-context"><strong>{collaborationUserMessageCount} 条已保存说明</strong><span>{collaborationDraft.trim() ? "笔谈中还有未发送内容，请先发送" : replyPending ? "上一条说明等待 DeepSeek 回应" : "已准备好生成候选"}</span></div>
        <div className="health-generation-actions"><button className="quiet-button" type="button" disabled={busy || !profile || !visiblePlan} onClick={openManualEditor}><ClipboardPenLine />手动编辑候选</button><button className="primary-button" type="button" disabled={busy || !profile || !collaboration || Boolean(collaborationDraft.trim()) || replyPending} onClick={() => void createCandidate()}>{healthAiStage === "preparing_candidate" || healthAiStage === "generating_candidate" || healthAiStage === "waiting_candidate" ? <LoaderCircle className="spin" /> : <Sparkles />}{healthAiStage === "preparing_candidate" ? "正在整理" : healthAiStage === "generating_candidate" || healthAiStage === "waiting_candidate" ? "正在生成候选" : "根据本页交流生成候选"}</button></div>
      </section>
      {manualDraft && <form className="health-manual-editor" onSubmit={saveManualCandidate}>
        <header><div><p className="section-kicker">手动周参考候选</p><h2>你决定每一项内容。</h2><small>保存后只会形成待确认候选，不会立即覆盖当前生效版本。</small></div><button className="quiet-button" type="button" disabled={busy} onClick={() => setManualDraft(null)}>取消编辑</button></header>
        <label><span>本周概览</span><textarea value={manualDraft.overview} onChange={(event) => setManualDraft((current) => current ? { ...current, overview: event.target.value } : current)} rows={3} maxLength={2000} required /></label>
        <label><span>补充剂参考（逗号或换行分隔）</span><textarea value={manualDraft.supplements} onChange={(event) => setManualDraft((current) => current ? { ...current, supplements: event.target.value } : current)} rows={2} /></label>
        <div className="health-manual-days" role="tablist" aria-label="手动编辑的日期">{manualDraft.days.map((_, dayIndex) => <button key={dayIndex} role="tab" aria-selected={selectedDay === dayIndex} className={selectedDay === dayIndex ? "active" : ""} type="button" onClick={() => setSelectedDay(dayIndex)}><span>{weekday[dayIndex]}</span><strong>{String(dayIndex + 1).padStart(2, "0")}</strong></button>)}</div>
        {manualDraft.days[selectedDay] && <section className="health-manual-day-fields">
          <label className="wide"><span>{weekday[selectedDay]}饮食方向</span><textarea value={manualDraft.days[selectedDay]!.nutritionDirection} onChange={(event) => updateManualDay({ nutritionDirection: event.target.value })} rows={3} maxLength={700} required /></label>
          <label><span>蛋白质下限（g）</span><input type="number" min="1" max="300" value={manualDraft.days[selectedDay]!.proteinRangeGrams.minimum} onChange={(event) => updateManualDay({ proteinRangeGrams: { ...manualDraft.days[selectedDay]!.proteinRangeGrams, minimum: Number(event.target.value) } })} required /></label>
          <label><span>蛋白质上限（g）</span><input type="number" min="1" max="300" value={manualDraft.days[selectedDay]!.proteinRangeGrams.maximum} onChange={(event) => updateManualDay({ proteinRangeGrams: { ...manualDraft.days[selectedDay]!.proteinRangeGrams, maximum: Number(event.target.value) } })} required /></label>
          <fieldset className="health-manual-fieldset wide">
            <legend>每日营养目标（可选）</legend>
            <label className="health-checkbox health-manual-toggle"><input type="checkbox" checked={Boolean(manualDraft.days[selectedDay]!.nutritionTargets)} onChange={(event) => updateManualDay({ nutritionTargets: event.target.checked ? emptyManualNutritionTargets() : undefined })} /><span>为当天填写碳水、脂肪、纤维、饮水和比例参考</span></label>
            {manualDraft.days[selectedDay]!.nutritionTargets && <div className="health-manual-grid">
              <label><span>碳水下限（g）</span><input type="number" min="0" max="1000" value={manualDraft.days[selectedDay]!.nutritionTargets!.carbohydrateGrams.minimum} onChange={(event) => updateManualNutritionTargets((targets) => ({ ...targets, carbohydrateGrams: { ...targets.carbohydrateGrams, minimum: manualNumber(event.target.value) } }))} required /></label>
              <label><span>碳水上限（g）</span><input type="number" min="0" max="1000" value={manualDraft.days[selectedDay]!.nutritionTargets!.carbohydrateGrams.maximum} onChange={(event) => updateManualNutritionTargets((targets) => ({ ...targets, carbohydrateGrams: { ...targets.carbohydrateGrams, maximum: manualNumber(event.target.value) } }))} required /></label>
              <label><span>脂肪下限（g）</span><input type="number" min="0" max="1000" value={manualDraft.days[selectedDay]!.nutritionTargets!.fatGrams.minimum} onChange={(event) => updateManualNutritionTargets((targets) => ({ ...targets, fatGrams: { ...targets.fatGrams, minimum: manualNumber(event.target.value) } }))} required /></label>
              <label><span>脂肪上限（g）</span><input type="number" min="0" max="1000" value={manualDraft.days[selectedDay]!.nutritionTargets!.fatGrams.maximum} onChange={(event) => updateManualNutritionTargets((targets) => ({ ...targets, fatGrams: { ...targets.fatGrams, maximum: manualNumber(event.target.value) } }))} required /></label>
              <label><span>纤维下限（g）</span><input type="number" min="0" max="1000" value={manualDraft.days[selectedDay]!.nutritionTargets!.fiberGrams.minimum} onChange={(event) => updateManualNutritionTargets((targets) => ({ ...targets, fiberGrams: { ...targets.fiberGrams, minimum: manualNumber(event.target.value) } }))} required /></label>
              <label><span>纤维上限（g）</span><input type="number" min="0" max="1000" value={manualDraft.days[selectedDay]!.nutritionTargets!.fiberGrams.maximum} onChange={(event) => updateManualNutritionTargets((targets) => ({ ...targets, fiberGrams: { ...targets.fiberGrams, maximum: manualNumber(event.target.value) } }))} required /></label>
              <label><span>饮水下限（L）</span><input type="number" min="0" max="10" step="0.1" value={manualDraft.days[selectedDay]!.nutritionTargets!.hydrationLiters.minimum} onChange={(event) => updateManualNutritionTargets((targets) => ({ ...targets, hydrationLiters: { ...targets.hydrationLiters, minimum: manualNumber(event.target.value) } }))} required /></label>
              <label><span>饮水上限（L）</span><input type="number" min="0" max="10" step="0.1" value={manualDraft.days[selectedDay]!.nutritionTargets!.hydrationLiters.maximum} onChange={(event) => updateManualNutritionTargets((targets) => ({ ...targets, hydrationLiters: { ...targets.hydrationLiters, maximum: manualNumber(event.target.value) } }))} required /></label>
              <div className="health-manual-macros wide"><span>三大营养素比例（合计约 100%）</span><label><b>蛋白</b><input aria-label="蛋白质比例" type="number" min="0" max="100" value={manualDraft.days[selectedDay]!.nutritionTargets!.macroRatioPercent.protein} onChange={(event) => updateManualNutritionTargets((targets) => ({ ...targets, macroRatioPercent: { ...targets.macroRatioPercent, protein: manualNumber(event.target.value) } }))} required /></label><label><b>碳水</b><input aria-label="碳水比例" type="number" min="0" max="100" value={manualDraft.days[selectedDay]!.nutritionTargets!.macroRatioPercent.carbohydrate} onChange={(event) => updateManualNutritionTargets((targets) => ({ ...targets, macroRatioPercent: { ...targets.macroRatioPercent, carbohydrate: manualNumber(event.target.value) } }))} required /></label><label><b>脂肪</b><input aria-label="脂肪比例" type="number" min="0" max="100" value={manualDraft.days[selectedDay]!.nutritionTargets!.macroRatioPercent.fat} onChange={(event) => updateManualNutritionTargets((targets) => ({ ...targets, macroRatioPercent: { ...targets.macroRatioPercent, fat: manualNumber(event.target.value) } }))} required /></label></div>
            </div>}
          </fieldset>
          <label className="wide"><span>饮水参考建议（每行一条，可选）</span><textarea value={manualDraft.days[selectedDay]!.hydrationGuidance?.join("\n") ?? ""} onChange={(event) => updateManualDay({ hydrationGuidance: event.target.value.trim() ? draftLines(event.target.value) : undefined })} rows={3} maxLength={1000} /></label>
          <fieldset className="health-manual-fieldset wide">
            <legend>今日吃法与替代参考（可选）</legend>
            <label className="health-checkbox health-manual-toggle"><input type="checkbox" checked={Boolean(manualDraft.days[selectedDay]!.mealExamples)} onChange={(event) => updateManualDay({ mealExamples: event.target.checked ? { breakfast: [""], lunch: [""], dinner: [""], snack: [] } : undefined })} /><span>填写早餐、午餐、晚餐和可选加餐示例</span></label>
            {manualDraft.days[selectedDay]!.mealExamples && <div className="health-manual-grid">
              <label><span>早餐示例（每行一项）</span><textarea value={manualDraft.days[selectedDay]!.mealExamples!.breakfast.join("\n")} onChange={(event) => updateManualDay({ mealExamples: { ...manualDraft.days[selectedDay]!.mealExamples!, breakfast: draftLines(event.target.value) } })} rows={3} required /></label>
              <label><span>午餐示例（每行一项）</span><textarea value={manualDraft.days[selectedDay]!.mealExamples!.lunch.join("\n")} onChange={(event) => updateManualDay({ mealExamples: { ...manualDraft.days[selectedDay]!.mealExamples!, lunch: draftLines(event.target.value) } })} rows={3} required /></label>
              <label><span>晚餐示例（每行一项）</span><textarea value={manualDraft.days[selectedDay]!.mealExamples!.dinner.join("\n")} onChange={(event) => updateManualDay({ mealExamples: { ...manualDraft.days[selectedDay]!.mealExamples!, dinner: draftLines(event.target.value) } })} rows={3} required /></label>
              <label><span>加餐示例（可留空）</span><textarea value={manualDraft.days[selectedDay]!.mealExamples!.snack.join("\n")} onChange={(event) => updateManualDay({ mealExamples: { ...manualDraft.days[selectedDay]!.mealExamples!, snack: draftLines(event.target.value) } })} rows={3} /></label>
            </div>}
            <label><span>当天蛋白轮换来源（逗号或换行分隔）</span><textarea value={manualDraft.days[selectedDay]!.proteinRotationSources?.join("，") ?? ""} onChange={(event) => updateManualDay({ proteinRotationSources: event.target.value.trim() ? draftLines(event.target.value.replace(/[，,]/g, "\n")) : undefined })} rows={2} /></label>
            <label className="health-checkbox health-manual-toggle"><input type="checkbox" checked={Boolean(manualDraft.days[selectedDay]!.foodReference)} onChange={(event) => updateManualDay({ foodReference: event.target.checked ? { proteinOptions: [""], fiberOptions: [""], carbOptions: [""] } : undefined })} /><span>填写可替换的蛋白、纤维和碳水来源</span></label>
            {manualDraft.days[selectedDay]!.foodReference && <div className="health-manual-grid health-manual-grid-three">
              <label><span>蛋白来源</span><textarea value={manualDraft.days[selectedDay]!.foodReference!.proteinOptions.join("\n")} onChange={(event) => updateManualDay({ foodReference: { ...manualDraft.days[selectedDay]!.foodReference!, proteinOptions: draftLines(event.target.value) } })} rows={3} required /></label>
              <label><span>纤维来源</span><textarea value={manualDraft.days[selectedDay]!.foodReference!.fiberOptions.join("\n")} onChange={(event) => updateManualDay({ foodReference: { ...manualDraft.days[selectedDay]!.foodReference!, fiberOptions: draftLines(event.target.value) } })} rows={3} required /></label>
              <label><span>碳水来源</span><textarea value={manualDraft.days[selectedDay]!.foodReference!.carbOptions.join("\n")} onChange={(event) => updateManualDay({ foodReference: { ...manualDraft.days[selectedDay]!.foodReference!, carbOptions: draftLines(event.target.value) } })} rows={3} required /></label>
            </div>}
          </fieldset>
          <label className="wide"><span>餐盘提示（逗号或换行分隔）</span><textarea value={manualDraft.days[selectedDay]!.plateGuidance.join("\n")} onChange={(event) => updateManualDay({ plateGuidance: listText(event.target.value) })} rows={2} required /></label>
          <label className="wide"><span>时令蔬菜提示（逗号或换行分隔）</span><textarea value={manualDraft.days[selectedDay]!.seasonalVegetables.join("，")} onChange={(event) => updateManualDay({ seasonalVegetables: listText(event.target.value) })} rows={2} required /></label>
          <label className="wide"><span>时令生活提示（可选）</span><textarea value={manualDraft.days[selectedDay]!.seasonalGuidance ?? ""} onChange={(event) => updateManualDay({ seasonalGuidance: event.target.value.trim() ? event.target.value : null })} rows={2} maxLength={500} /></label>
          <label><span>诗词篇名（可选）</span><input value={manualDraft.days[selectedDay]!.seasonalPoem?.title ?? ""} onChange={(event) => updateManualPoem({ title: event.target.value })} maxLength={120} required={Boolean(manualDraft.days[selectedDay]!.seasonalPoem)} /></label>
          <label><span>作者（可选）</span><input value={manualDraft.days[selectedDay]!.seasonalPoem?.author ?? ""} onChange={(event) => updateManualPoem({ author: event.target.value })} maxLength={120} required={Boolean(manualDraft.days[selectedDay]!.seasonalPoem)} /></label>
          <label className="wide"><span>诗句（可选；留空则不显示诗词）</span><textarea value={manualDraft.days[selectedDay]!.seasonalPoem?.excerpt ?? ""} onChange={(event) => event.target.value.trim() ? updateManualPoem({ excerpt: event.target.value }) : updateManualDay({ seasonalPoem: null })} rows={2} maxLength={180} /></label>
          {manualDraft.days[selectedDay]!.seasonalPoem && <label className="wide"><span>与当天的关联</span><textarea value={manualDraft.days[selectedDay]!.seasonalPoem?.relevance ?? ""} onChange={(event) => updateManualPoem({ relevance: event.target.value })} rows={2} maxLength={300} required /></label>}
          <label><span>运动类别</span><select value={manualDraft.days[selectedDay]!.movement.category} onChange={(event) => updateManualMovement({ category: event.target.value as DayReference["content"]["movement"]["category"] })}><option value="strength">力量训练</option><option value="volleyball">排球</option><option value="running">跑步</option><option value="walking">步行</option><option value="cycling">骑行</option><option value="recovery">轻量恢复</option><option value="rest">休息</option></select></label>
          <label><span>运动强度</span><select value={manualDraft.days[selectedDay]!.movement.intensity} onChange={(event) => updateManualMovement({ intensity: event.target.value as DayReference["content"]["movement"]["intensity"] })}><option value="rest">休息</option><option value="low">低强度</option><option value="moderate">中等强度</option><option value="high">高强度</option></select></label>
          <label><span>运动下限（分钟）</span><input type="number" min="0" max="240" value={manualDraft.days[selectedDay]!.movement.durationMinutes.minimum} onChange={(event) => updateManualMovement({ durationMinutes: { ...manualDraft.days[selectedDay]!.movement.durationMinutes, minimum: Number(event.target.value) } })} required /></label>
          <label><span>运动上限（分钟）</span><input type="number" min="0" max="300" value={manualDraft.days[selectedDay]!.movement.durationMinutes.maximum} onChange={(event) => updateManualMovement({ durationMinutes: { ...manualDraft.days[selectedDay]!.movement.durationMinutes, maximum: Number(event.target.value) } })} required /></label>
          <label className="health-checkbox wide"><input type="checkbox" checked={manualDraft.days[selectedDay]!.movement.highIntensity} onChange={(event) => updateManualMovement({ highIntensity: event.target.checked })} /><span>这是高强度日</span></label>
          <label className="wide"><span>训练重点或动作结构（逗号或换行分隔，可选）</span><textarea value={manualDraft.days[selectedDay]!.movement.focus?.join("\n") ?? ""} onChange={(event) => updateManualMovement({ focus: event.target.value.trim() ? draftLines(event.target.value) : undefined })} rows={3} /></label>
          <label className="wide"><span>安全提醒</span><textarea value={manualDraft.days[selectedDay]!.movement.safetyReminder} onChange={(event) => updateManualMovement({ safetyReminder: event.target.value })} rows={2} maxLength={400} required /></label>
          <label className="wide"><span>分条注意事项（逗号或换行分隔，可选）</span><textarea value={manualDraft.days[selectedDay]!.movement.safetyNotes?.join("\n") ?? ""} onChange={(event) => updateManualMovement({ safetyNotes: event.target.value.trim() ? draftLines(event.target.value) : undefined })} rows={3} /></label>
        </section>}
        <footer><button className="primary-button" type="submit" disabled={busy}>{busy ? <LoaderCircle className="spin" /> : <Check />}保存为待确认候选</button></footer>
      </form>}
      {visiblePlan ? <section className="health-plan" ref={candidateSectionRef}>
        <header className="health-plan-header"><div><p className="section-kicker">{candidate ? "待确认版本" : "本周生效版本"}</p><h2>{visiblePlan.solarTerm} · {visiblePlan.city ?? "未设置城市"}</h2><small>{candidate ? (visiblePlan.source === "ai" ? "DeepSeek 只生成候选；天气不可用时不会编造，确认后才会替换本周参考。" : visiblePlan.source === "manual" ? "由你手动编辑的候选，确认后才会替换本周参考。" : "这是历史候选，仍需你确认后才会生效。") : "本周参考不会因一天睡眠或运动变化自动改写。"}</small></div>{candidate && <div className="candidate-actions"><button className="quiet-button" type="button" disabled={busy} onClick={() => void discardCandidate()}>放弃候选</button><button className="primary-button" type="button" disabled={busy} onClick={() => void confirmCandidate()}>{busy ? <LoaderCircle className="spin" /> : <Check />}确认并使用</button></div>}</header>
        <section className="health-week-summary" aria-label="本周摘要">
          <div><p className="section-kicker">本周摘要</p><strong>{profile?.profile.goals.slice(0,3).join("、") || "按已保存资料生成的本周参考"}</strong><p>{visiblePlan.overview}</p></div>
          <dl>
            <div><dt>每周运动</dt><dd>{profile ? `${profile.profile.activity.sessionsPerWeek} 次` : "未提供"}</dd></div>
            <div><dt>单次时长</dt><dd>{profile ? `${profile.profile.activity.usualDurationMinutes.minimum}–${profile.profile.activity.usualDurationMinutes.maximum}m` : "未提供"}</dd></div>
            <div><dt>每日蛋白</dt><dd>{selectedReference ? `${selectedReference.content.proteinRangeGrams.minimum}–${selectedReference.content.proteinRangeGrams.maximum}g` : "未提供"}</dd></div>
            <div><dt>每日饮水</dt><dd>{selectedReference?.content.nutritionTargets ? `${selectedReference.content.nutritionTargets.hydrationLiters.minimum}–${selectedReference.content.nutritionTargets.hydrationLiters.maximum}L` : "当前参考未提供"}</dd></div>
          </dl>
        </section>
        {candidate?.revisionReason && active && candidate.basedOnPlanId === active.id && <section className="health-revision-preview" aria-label={candidateIsUneditedSleepRevision ? "睡眠修订前后差异" : "候选前后差异"}>
          <header><Sparkles /><div><p className="section-kicker">{candidateIsUneditedSleepRevision ? "本次修订依据" : "候选说明"}</p><strong>候选尚未生效</strong></div></header>
          <p>{candidate.revisionReason}</p>
          <div className="health-revision-diff">{planRevisionChanges(active, candidate).map((change) => <div key={change}><strong>本周</strong><span>{change}</span></div>)}{candidate.days.map((day) => {
            const previous = active.days.find((item) => item.dayIndex === day.dayIndex);
            const changes = previous ? revisionChanges(previous, day) : [];
            return changes.length > 0 ? <div key={day.id}><strong>{weekday[day.dayIndex]}</strong><span>{changes.join("；")}</span></div> : null;
          })}{planRevisionChanges(active, candidate).length === 0 && candidate.days.every((day) => {
            const previous = active.days.find((item) => item.dayIndex === day.dayIndex);
            return !previous || revisionChanges(previous, day).length === 0;
          }) && <div><strong>本周</strong><span>候选没有改变当前可显示的每日参考；确认前原计划仍保持不变。</span></div>}</div>
        </section>}
        <div className="health-days" role="tablist" aria-label="本周健康参考日期">{visiblePlan.days.map((day) => <button key={day.id} role="tab" aria-selected={selectedDay === day.dayIndex} className={selectedDay === day.dayIndex ? "active" : ""} type="button" onClick={() => setSelectedDay(day.dayIndex)}><span>{weekday[day.dayIndex]}</span><strong>{day.localDate.slice(8)}</strong></button>)}</div>
        <section className="health-actuals" aria-label={`${actualDate} 实际营养与饮水记录`}>
          <header><div><p className="section-kicker">当日实际记录</p><h3>{actualDate} · 只记每日总量</h3><small>实际记录独立于 AI 健康参考；修改或替换周计划不会覆盖这些数据。</small></div><Droplets aria-hidden="true" /></header>
          <div className="health-actual-progress-grid">
            {actualProgress("蛋白质", dailyActual?.proteinGrams ?? null, actualReference?.content.proteinRangeGrams, "protein", "g", 200)}
            {actualProgress("膳食纤维", dailyActual?.fiberGrams ?? null, actualReference?.content.nutritionTargets?.fiberGrams, "fiber", "g", 60)}
            {actualProgress("饮水", dailyActual?.waterMilliliters === null || dailyActual?.waterMilliliters === undefined ? null : dailyActual.waterMilliliters / 1000, actualReference?.content.nutritionTargets?.hydrationLiters, "water", "L", 5)}
          </div>
          <form className="health-actual-form" onSubmit={saveDailyActual}>
            <label><span>蛋白质实际（g）</span><input aria-label="蛋白质实际克数" type="number" min="0" max="1000" step="1" value={dailyActualDraft.proteinGrams} disabled={dailyActualLoading || dailyActualSaving} onChange={(event) => { setDailyActualDraft((draft) => ({ ...draft, proteinGrams: event.target.value })); setDailyActualMessage(null); }} placeholder="例如 95" /></label>
            <label><span>膳食纤维实际（g）</span><input aria-label="膳食纤维实际克数" type="number" min="0" max="200" step="1" value={dailyActualDraft.fiberGrams} disabled={dailyActualLoading || dailyActualSaving} onChange={(event) => { setDailyActualDraft((draft) => ({ ...draft, fiberGrams: event.target.value })); setDailyActualMessage(null); }} placeholder="例如 26" /></label>
            <label><span>饮水实际（L）</span><input aria-label="饮水实际升数" type="number" min="0" max="10" step="0.1" value={dailyActualDraft.waterLiters} disabled={dailyActualLoading || dailyActualSaving} onChange={(event) => { setDailyActualDraft((draft) => ({ ...draft, waterLiters: event.target.value })); setDailyActualMessage(null); }} placeholder="例如 2.3" /></label>
            <button className="primary-button" type="submit" disabled={dailyActualLoading || dailyActualSaving}>{dailyActualSaving ? <LoaderCircle className="spin" /> : <Save />}{dailyActualSaving ? "正在保存" : "保存当日记录"}</button>
          </form>
          <p className="health-actual-message" role="status">{dailyActualLoading ? "正在读取当日实际记录…" : dailyActualMessage ?? "留空并保存可清除该项；不会生成饮食评价或处罚。"}</p>
        </section>
        {selectedReference && <>
          {(selectedReference.content.seasonalGuidance||selectedReference.content.seasonalPoem)&&<article className="health-seasonal-card"><Leaf/><div>{selectedReference.content.seasonalGuidance&&<><p className="section-kicker">结合时令与已取得的环境信息</p><strong>{selectedReference.content.seasonalGuidance}</strong></>}{selectedReference.content.seasonalPoem&&<blockquote><Quote/><p>“{selectedReference.content.seasonalPoem.excerpt}”</p><cite>{selectedReference.content.seasonalPoem.author}《{selectedReference.content.seasonalPoem.title}》</cite><small>{selectedReference.content.seasonalPoem.relevance}</small></blockquote>}</div></article>}
          <article className="health-day-detail health-prescription">
            <section className="health-food-prescription">
              <header><Leaf /><div><p>今日饮食处方 · 参考级</p><strong>今天可以怎样吃</strong></div></header>
              <p>{selectedReference.content.nutritionDirection}</p>
              <div className="health-target-scales">
                {referenceScale("蛋白质", selectedReference.content.proteinRangeGrams, "protein")}
                {referenceScale("碳水", selectedReference.content.nutritionTargets?.carbohydrateGrams, "carb")}
                {referenceScale("脂肪", selectedReference.content.nutritionTargets?.fatGrams, "fat")}
                {referenceScale("膳食纤维", selectedReference.content.nutritionTargets?.fiberGrams, "fiber")}
                {referenceScale("饮水", selectedReference.content.nutritionTargets?.hydrationLiters, "water", "L")}
              </div>
              {selectedReference.content.nutritionTargets ? <div className="health-macro-ratio" aria-label="三大营养素参考比例">
                <header><h3>三大营养素参考比例</h3><small>只表示建议结构，不代表今日实际摄入</small></header>
                <div aria-hidden="true"><i data-tone="protein" style={{ "--macro-share": `${selectedReference.content.nutritionTargets.macroRatioPercent.protein}%` } as CSSProperties} /><i data-tone="carb" style={{ "--macro-share": `${selectedReference.content.nutritionTargets.macroRatioPercent.carbohydrate}%` } as CSSProperties} /><i data-tone="fat" style={{ "--macro-share": `${selectedReference.content.nutritionTargets.macroRatioPercent.fat}%` } as CSSProperties} /></div>
                <p><span><b data-tone="protein" />蛋白 {selectedReference.content.nutritionTargets.macroRatioPercent.protein}%</span><span><b data-tone="carb" />碳水 {selectedReference.content.nutritionTargets.macroRatioPercent.carbohydrate}%</span><span><b data-tone="fat" />脂肪 {selectedReference.content.nutritionTargets.macroRatioPercent.fat}%</span></p>
              </div> : null}
              <section className="health-hydration-guidance"><h3>今日饮水参考</h3>{listOrMissing(selectedReference.content.hydrationGuidance)}</section>
              <section className="health-meal-sheet"><h3>三餐示例</h3>{selectedReference.content.mealExamples ? <dl>{([['早餐',selectedReference.content.mealExamples.breakfast],['午餐',selectedReference.content.mealExamples.lunch],['晚餐',selectedReference.content.mealExamples.dinner],['加餐',selectedReference.content.mealExamples.snack]] as Array<[string,string[]]>).map(([label,items])=><div key={label}><dt>{label}</dt><dd>{items.length ? items.join(" · ") : "可不安排"}</dd></div>)}</dl> : <p className="health-field-missing">当前参考未提供三餐示例；重新请求 DeepSeek 候选后可补齐。</p>}</section>
              <section className="health-protein-rotation"><h3>本周蛋白轮换</h3><div>{visiblePlan.days.map((day)=><span key={day.id} className={day.id===selectedReference.id?"current":""}><b>{weekday[day.dayIndex]}</b><small>{day.content.proteinRotationSources?.join(" / ") || "未提供"}</small></span>)}</div></section>
              <section className="health-food-reference"><h3>替代食材参考</h3>{selectedReference.content.foodReference ? <div><p><b>蛋白</b>{selectedReference.content.foodReference.proteinOptions.join("、")}</p><p><b>纤维</b>{selectedReference.content.foodReference.fiberOptions.join("、")}</p><p><b>碳水</b>{selectedReference.content.foodReference.carbOptions.join("、")}</p></div> : <p className="health-field-missing">当前参考未提供替代食材；重新请求 DeepSeek 候选后可补齐。</p>}</section>
            </section>
            <section className="health-movement-prescription">
              <header><HeartPulse /><div><p>今日运动处方 · 参考级</p><strong>{activityLabel[selectedReference.content.movement.category]} · {intensityLabel[selectedReference.content.movement.intensity]}</strong></div></header>
              <div className="health-movement-facts"><span><small>建议时长</small><b>{selectedReference.content.movement.durationMinutes.minimum}–{selectedReference.content.movement.durationMinutes.maximum} 分钟</b></span><span><small>强度</small><b>{intensityLabel[selectedReference.content.movement.intensity]}</b></span></div>
              <section><h3>今日重点</h3>{listOrMissing(selectedReference.content.movement.focus)}</section>
              <section className="health-safety-notes"><h3>注意事项</h3>{listOrMissing(selectedReference.content.movement.safetyNotes ?? [selectedReference.content.movement.safetyReminder])}</section>
              <section><h3>餐盘与时令提示</h3>{listOrMissing(selectedReference.content.plateGuidance)}<div className="vegetable-tags">{selectedReference.content.seasonalVegetables.map((item) => <span key={item}>{item}</span>)}</div></section>
            </section>
          </article>
          <div className="health-reference-actions"><button className="quiet-button" type="button" onClick={() => askAbout("food")}><MessageCircleQuestion />按今天食材协商</button><button className="quiet-button" type="button" onClick={() => askAbout("movement")}><MessageCircleQuestion />调整今日运动</button>{!candidate && active?.id === visiblePlan.id && selectedReference.content.movement.category !== "rest" && <button className="primary-button" type="button" onClick={createTaskFromMovement}><ClipboardPenLine />转为任务并重新排期</button>}</div>
        </>}
        <section className="health-supplements"><p className="section-kicker">补充剂参考</p>{visiblePlan.supplements.map((item) => <p key={item}>{item}</p>)}</section>
      </section> : <div className="health-empty"><HeartPulse /><strong>健康资料已准备好后，会在这里生成一份待你确认的本周参考。</strong></div>}
      <section className="health-sleep-card">
        <header><div><p className="section-kicker">睡眠截图</p><h2>只读取你主动上传的这一张。</h2><small>只分析截图中实际出现的时间、时长、阶段、设备评分和说明；原图不会保存，也不会自动修改健康资料或本周参考。</small>{sleepImageAnalysisAvailable === false && <p className="health-capability-note">当前未配置经过验证的视觉模型，因此截图分析暂不可用；健康资料、周参考和手动修订不受影响。</p>}</div><div className="health-sleep-actions"><input ref={sleepFileInputRef} className="sleep-file-input" aria-label="选择睡眠截图" disabled={sleepImageAnalysisAvailable === false} type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { selectSleepFile(event.target.files?.[0] ?? null); event.currentTarget.value = ""; }} /><div className="sleep-drop-shell"><div data-testid="sleep-dropzone" className={`sleep-dropzone ${sleepDropActive ? "drag-active" : ""} ${sleepFile ? "has-file" : ""}`} role="button" tabIndex={sleepImageAnalysisAvailable === false ? -1 : 0} aria-label="睡眠截图拖放与粘贴区域" aria-disabled={sleepImageAnalysisAvailable === false} onKeyDown={(event) => { if ((event.key === "Enter" || event.key === " ") && sleepImageAnalysisAvailable !== false) { event.preventDefault(); sleepFileInputRef.current?.click(); } }} onDragEnter={(event) => { event.preventDefault(); setSleepDropActive(true); }} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; setSleepDropActive(true); }} onDragLeave={() => setSleepDropActive(false)} onDrop={handleSleepDrop} onPaste={handleSleepPaste}><Upload /><span><strong>{sleepFile ? sleepFile.name : "拖入或粘贴睡眠截图"}</strong><small>{sleepFile ? "已选择，可重新粘贴或更换图片" : "点击框后按 Ctrl+V，或直接把图片拖进来"}</small></span><button className="sleep-file-picker" type="button" disabled={sleepImageAnalysisAvailable === false} onClick={() => sleepFileInputRef.current?.click()}>{sleepFile ? "更换文件" : "选择文件"}</button></div>{sleepFile && <button className="sleep-file-clear" type="button" aria-label="移除已选择的睡眠截图" onClick={() => setSleepFile(null)}><X /></button>}</div><button className="primary-button" type="button" disabled={busy || !sleepFile || sleepImageAnalysisAvailable === false} onClick={() => void analyzeSleepScreenshot()}>{busy ? <LoaderCircle className="spin" /> : <Sparkles />}上传并分析</button></div></header>
        {sleepAnalyses.length === 0 ? <p className="health-sleep-empty">{sleepDate} 还没有已保存的截图分析。</p> : <div className="health-sleep-results">{sleepAnalyses.map((record) => <article key={record.id}><div className="health-sleep-result-head"><strong>{record.localDate}</strong><small>{record.originalFileName} · {new Date(record.createdAt).toLocaleString("zh-CN")}</small></div><div className="sleep-metrics">{sleepMetric("总睡眠", record.analysis.totalSleepMinutes, " 分钟")}{sleepMetric("深睡", record.analysis.deepSleepMinutes, " 分钟")}{sleepMetric("浅睡", record.analysis.lightSleepMinutes, " 分钟")}{sleepMetric("快速眼动", record.analysis.remSleepMinutes, " 分钟")}{sleepMetric("清醒次数", record.analysis.awakeCount)}{sleepMetric("设备评分", record.analysis.deviceScore, " / 100")}{sleepMetric("入睡", record.analysis.sleepStart)}{sleepMetric("起床", record.analysis.wakeTime)}</div>{record.analysis.deviceNotes && <p>{record.analysis.deviceNotes}</p>}<ul>{record.analysis.interpretation.map((item) => <li key={item}>{item}</li>)}</ul>{active && !candidate && <button className="quiet-button sleep-revision-button" type="button" disabled={busy} onClick={() => void createSleepRevisionCandidate(record)}><Sparkles />根据这次睡眠生成修订候选</button>}<small className="health-sleep-limitations">{record.analysis.limitations.join(" ")}</small></article>)}</div>}
      </section>
    </>}
  </section>;
}
