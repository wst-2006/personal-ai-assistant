import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Archive, Check, ChevronRight, CircleAlert, LoaderCircle, Plus, RotateCcw, Save, Trash2 } from "lucide-react";

type PlanScope = "month" | "semester" | "annual";
type PlanStatus = "active" | "archived";

type Milestone = {
  id: string;
  title: string;
  targetDate: string | null;
  notes: string | null;
  position: number;
};

type LongRangePlan = {
  id: string;
  scope: PlanScope;
  title: string;
  periodStart: string;
  periodEnd: string;
  description: string | null;
  status: PlanStatus;
  version: number;
  archivedAt: string | null;
  milestones: Milestone[];
};

type DraftMilestone = { key: string; title: string; targetDate: string; notes: string };
type PlanDraft = {
  scope: PlanScope;
  title: string;
  periodStart: string;
  periodEnd: string;
  description: string;
  milestones: DraftMilestone[];
};

type ApiFailureBody = { error?: string; plan?: LongRangePlan };

class PlanApiError extends Error {
  constructor(readonly status: number, readonly body: ApiFailureBody) {
    super(body.error ?? `HTTP ${status}`);
  }
}

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3000";
const scopeOptions: Array<{ value: PlanScope; label: string; prompt: string }> = [
  { value: "month", label: "本月主线", prompt: "把这个月真正想推进的事留在这里。" },
  { value: "semester", label: "学期规划", prompt: "把学期目标和关键节点放在同一条脉络里。" },
  { value: "annual", label: "年度方向", prompt: "保留能校准长期方向的少量承诺。" }
];

function shanghaiParts() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date());
  const value = (kind: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === kind)?.value ?? "";
  return { year: Number(value("year")), month: Number(value("month")), day: Number(value("day")) };
}

function isoDate(year: number, month: number, day: number) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function defaultPeriod(scope: PlanScope): Pick<PlanDraft, "periodStart" | "periodEnd"> {
  const { year, month } = shanghaiParts();
  if (scope === "annual") return { periodStart: isoDate(year, 1, 1), periodEnd: isoDate(year, 12, 31) };
  if (scope === "semester") {
    return month <= 6
      ? { periodStart: isoDate(year, 1, 1), periodEnd: isoDate(year, 6, 30) }
      : { periodStart: isoDate(year, 7, 1), periodEnd: isoDate(year, 12, 31) };
  }
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { periodStart: isoDate(year, month, 1), periodEnd: isoDate(year, month, lastDay) };
}

function blankDraft(scope: PlanScope): PlanDraft {
  return { scope, title: "", ...defaultPeriod(scope), description: "", milestones: [] };
}

function draftFromPlan(plan: LongRangePlan): PlanDraft {
  return {
    scope: plan.scope,
    title: plan.title,
    periodStart: plan.periodStart,
    periodEnd: plan.periodEnd,
    description: plan.description ?? "",
    milestones: plan.milestones.map((milestone) => ({
      key: milestone.id,
      title: milestone.title,
      targetDate: milestone.targetDate ?? "",
      notes: milestone.notes ?? ""
    }))
  };
}

function displayPeriod(plan: Pick<LongRangePlan, "periodStart" | "periodEnd">) {
  const format = new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" });
  const start = format.format(new Date(`${plan.periodStart}T12:00:00+08:00`));
  const end = format.format(new Date(`${plan.periodEnd}T12:00:00+08:00`));
  return `${start} - ${end}`;
}

function textForFailure(error: unknown) {
  if (error instanceof PlanApiError) {
    if (error.body.error === "long_range_plan_version_conflict") return "这份规划已经在另一处更新。已保留你的输入，请重新查看后再保存。";
    if (error.body.error === "invalid_long_range_plan_state") return "已归档的规划不能直接编辑；请先恢复它。";
    if (error.body.error === "long_range_plan_not_found") return "这份规划已经不存在，请刷新列表。";
  }
  return "无法保存规划，请确认本地 API 正在运行后重试。";
}

async function requestPlan<T>(path: string, method: string, payload?: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method,
    headers: payload ? { "content-type": "application/json" } : undefined,
    body: payload ? JSON.stringify(payload) : undefined
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new PlanApiError(response.status, body as ApiFailureBody);
  return body as T;
}

function payloadFromDraft(draft: PlanDraft) {
  return {
    scope: draft.scope,
    title: draft.title.trim(),
    periodStart: draft.periodStart,
    periodEnd: draft.periodEnd,
    description: draft.description.trim() || null,
    milestones: draft.milestones
      .filter((milestone) => milestone.title.trim())
      .map((milestone) => ({
        title: milestone.title.trim(),
        targetDate: milestone.targetDate || null,
        notes: milestone.notes.trim() || null
      }))
  };
}

function newMilestone(): DraftMilestone {
  return { key: crypto.randomUUID(), title: "", targetDate: "", notes: "" };
}

export function LongRangePlansWorkspace() {
  const [scope, setScope] = useState<PlanScope>("month");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [plans, setPlans] = useState<LongRangePlan[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<PlanDraft>(() => blankDraft("month"));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedPlan = useMemo(() => plans.find((plan) => plan.id === selectedId) ?? null, [plans, selectedId]);
  const scopeCopy = scopeOptions.find((option) => option.value === scope)!;

  const loadPlans = useCallback(async (nextScope = scope, nextIncludeArchived = includeArchived) => {
    setLoading(true);
    try {
      const result = await requestPlan<{ plans: LongRangePlan[] }>(`/api/v1/long-range-plans?scope=${nextScope}&includeArchived=${nextIncludeArchived}`, "GET");
      setPlans(result.plans);
      setSelectedId((current) => result.plans.some((plan) => plan.id === current) ? current : null);
      setError(null);
    } catch (loadError) {
      setError(textForFailure(loadError));
      setPlans([]);
      setSelectedId(null);
    } finally {
      setLoading(false);
    }
  }, [includeArchived, scope]);

  useEffect(() => { void loadPlans(); }, [loadPlans]);

  useEffect(() => {
    if (selectedPlan) setDraft(draftFromPlan(selectedPlan));
  }, [selectedPlan]);

  function chooseScope(nextScope: PlanScope) {
    setScope(nextScope);
    setSelectedId(null);
    setDraft(blankDraft(nextScope));
    setError(null);
  }

  function beginNewPlan() {
    setSelectedId(null);
    setDraft(blankDraft(scope));
    setError(null);
  }

  function selectPlan(plan: LongRangePlan) {
    setSelectedId(plan.id);
    setDraft(draftFromPlan(plan));
    setError(null);
  }

  function updateDraft(patch: Partial<PlanDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  function updateMilestone(key: string, patch: Partial<DraftMilestone>) {
    setDraft((current) => ({
      ...current,
      milestones: current.milestones.map((milestone) => milestone.key === key ? { ...milestone, ...patch } : milestone)
    }));
  }

  async function savePlan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const payload = payloadFromDraft(draft);
    if (!payload.title || !payload.periodStart || !payload.periodEnd) {
      setError("请填写规划标题和起止日期。");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = selectedPlan
        ? await requestPlan<{ plan: LongRangePlan }>(`/api/v1/long-range-plans/${selectedPlan.id}`, "PUT", { ...payload, expectedVersion: selectedPlan.version })
        : await requestPlan<{ plan: LongRangePlan }>("/api/v1/long-range-plans", "POST", payload);
      await loadPlans(result.plan.scope, includeArchived);
      if (result.plan.scope !== scope) setScope(result.plan.scope);
      setSelectedId(result.plan.id);
      setDraft(draftFromPlan(result.plan));
    } catch (saveError) {
      setError(textForFailure(saveError));
    } finally {
      setSaving(false);
    }
  }

  async function setPlanStatus(status: PlanStatus) {
    if (!selectedPlan) return;
    setSaving(true);
    setError(null);
    try {
      const result = await requestPlan<{ plan: LongRangePlan }>(`/api/v1/long-range-plans/${selectedPlan.id}/status`, "POST", {
        status,
        expectedVersion: selectedPlan.version
      });
      await loadPlans(scope, includeArchived || status === "archived");
      setSelectedId(result.plan.id);
      setDraft(draftFromPlan(result.plan));
    } catch (statusError) {
      setError(textForFailure(statusError));
    } finally {
      setSaving(false);
    }
  }

  return <section className="long-range-workspace page" aria-labelledby="long-range-title">
    <header className="long-range-heading">
      <div>
        <p className="section-kicker">手动规划</p>
        <h1 id="long-range-title">把目光放远，也把决定留在自己手里。</h1>
        <p>月度主线、学期计划和年度方向相互照见，但不会自动拆成任务或改写你的时间轴。</p>
      </div>
      <button className="primary-button" type="button" onClick={beginNewPlan}><Plus />新建规划</button>
    </header>

    <div className="long-range-scope" role="tablist" aria-label="规划层级">
      {scopeOptions.map((option) => <button key={option.value} role="tab" type="button" aria-selected={scope === option.value} onClick={() => chooseScope(option.value)}>
        <span>{option.label}</span><small>{option.value === "month" ? "近处" : option.value === "semester" ? "中程" : "远处"}</small>
      </button>)}
    </div>

    <div className="long-range-layout">
      <aside className="long-range-list" aria-label={`${scopeCopy.label}列表`}>
        <header><div><strong>{scopeCopy.label}</strong><small>{scopeCopy.prompt}</small></div><label className="archive-toggle"><input aria-label="显示已归档规划" type="checkbox" checked={includeArchived} onChange={(event) => setIncludeArchived(event.target.checked)} /><span>已归档</span></label></header>
        {loading ? <div className="long-range-loading"><LoaderCircle className="spin" />正在读取规划</div> : plans.length === 0 ? <div className="long-range-empty"><strong>这里还没有规划。</strong><p>从一个你愿意承担的主线开始。</p><button className="text-button" type="button" onClick={beginNewPlan}><Plus />新建这一项</button></div> : <div className="long-range-items">{plans.map((plan) => <button key={plan.id} className={`long-range-item ${selectedId === plan.id ? "active" : ""} ${plan.status}`} type="button" onClick={() => selectPlan(plan)}>
          <span className="long-range-item-period">{displayPeriod(plan)}</span><strong>{plan.title}</strong><small>{plan.milestones.length} 个里程碑 {plan.status === "archived" ? "· 已归档" : ""}</small><ChevronRight />
        </button>)}</div>}
      </aside>

      <form className="long-range-editor" onSubmit={savePlan} aria-label={selectedPlan ? "编辑规划" : "新建规划"}>
        <header>
          <div><p className="section-kicker">{selectedPlan ? selectedPlan.status === "archived" ? "已归档" : "正在编辑" : "新的主线"}</p><h2>{selectedPlan ? selectedPlan.title : "从一条清晰的线开始"}</h2></div>
          {selectedPlan && <span className="plan-version">版本 {selectedPlan.version}</span>}
        </header>
        {error && <p className="long-range-error" role="alert"><CircleAlert />{error}</p>}
        <div className="long-range-fields">
          <label className="wide"><span>规划标题</span><input aria-label="规划标题" required maxLength={200} disabled={saving || selectedPlan?.status === "archived"} value={draft.title} onChange={(event) => updateDraft({ title: event.target.value })} placeholder="例如：完成秋季研究准备" /></label>
          <label><span>规划范围</span><select aria-label="规划范围" disabled={saving || selectedPlan?.status === "archived"} value={draft.scope} onChange={(event) => {
            const nextScope = event.target.value as PlanScope;
            updateDraft({ scope: nextScope, ...defaultPeriod(nextScope) });
          }}>{scopeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
          <div className="long-range-date-row"><label><span>开始日期</span><input aria-label="开始日期" type="date" required disabled={saving || selectedPlan?.status === "archived"} value={draft.periodStart} onChange={(event) => updateDraft({ periodStart: event.target.value })} /></label><label><span>结束日期</span><input aria-label="结束日期" type="date" required disabled={saving || selectedPlan?.status === "archived"} value={draft.periodEnd} onChange={(event) => updateDraft({ periodEnd: event.target.value })} /></label></div>
          <label className="wide"><span>规划说明（可选）</span><textarea aria-label="规划说明" rows={4} maxLength={8000} disabled={saving || selectedPlan?.status === "archived"} value={draft.description} onChange={(event) => updateDraft({ description: event.target.value })} placeholder="写下这段时间真正要推进的方向、边界或判断标准。" /></label>
        </div>

        <section className="milestone-editor" aria-labelledby="milestone-title">
          <header><div><p className="section-kicker">自己设定的节点</p><h3 id="milestone-title">里程碑</h3></div>{selectedPlan?.status !== "archived" && <button className="inline-button" type="button" disabled={saving || draft.milestones.length >= 30} onClick={() => updateDraft({ milestones: [...draft.milestones, newMilestone()] })}><Plus />添加节点</button>}</header>
          {draft.milestones.length === 0 ? <p className="milestone-empty">还没有节点。只在它能帮助你保持方向时再添加。</p> : <div className="milestone-list">{draft.milestones.map((milestone, index) => <article key={milestone.key} className="milestone-row"><span>{String(index + 1).padStart(2, "0")}</span><div><input aria-label={`里程碑 ${index + 1}`} required maxLength={200} disabled={saving || selectedPlan?.status === "archived"} value={milestone.title} onChange={(event) => updateMilestone(milestone.key, { title: event.target.value })} placeholder="一个可辨认的阶段节点" /><div className="milestone-detail"><label><span>目标日期（可选）</span><input aria-label={`里程碑 ${index + 1} 目标日期`} type="date" disabled={saving || selectedPlan?.status === "archived"} value={milestone.targetDate} onChange={(event) => updateMilestone(milestone.key, { targetDate: event.target.value })} /></label><label><span>补充说明（可选）</span><input aria-label={`里程碑 ${index + 1} 说明`} maxLength={4000} disabled={saving || selectedPlan?.status === "archived"} value={milestone.notes} onChange={(event) => updateMilestone(milestone.key, { notes: event.target.value })} placeholder="不必填" /></label></div></div>{selectedPlan?.status !== "archived" && <button className="quiet-icon" type="button" aria-label={`移除里程碑 ${index + 1}`} disabled={saving} onClick={() => updateDraft({ milestones: draft.milestones.filter((item) => item.key !== milestone.key) })}><Trash2 /></button>}</article>)}</div>}
        </section>

        <footer className="long-range-actions">
          {selectedPlan?.status === "active" && <button className="quiet-button" type="button" disabled={saving} onClick={() => void setPlanStatus("archived")}><Archive />归档规划</button>}
          {selectedPlan?.status === "archived" && <button className="quiet-button" type="button" disabled={saving} onClick={() => void setPlanStatus("active")}><RotateCcw />恢复规划</button>}
          {selectedPlan?.status !== "archived" && <button className="primary-button" type="submit" disabled={saving}>{saving ? <LoaderCircle className="spin" /> : selectedPlan ? <Save /> : <Check />}{saving ? "正在保存" : selectedPlan ? "保存修改" : "保存规划"}</button>}
        </footer>
      </form>
    </div>
  </section>;
}
