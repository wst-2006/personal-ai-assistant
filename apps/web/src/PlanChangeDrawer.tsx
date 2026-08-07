import { useState } from "react";
import { AlertTriangle, ArrowRight, CalendarClock, LoaderCircle, MessageSquareText, PencilLine } from "lucide-react";

type Feasibility = "feasible" | "risky" | "needs_clarification";
type ScheduleKind = "none" | "daypart" | "exact";
type Daypart = "morning" | "afternoon" | "evening";
type LifecycleStatus = "open" | "active" | "awaiting_outcome" | "closed" | "cancelled";

type ScheduleShape = {
  scheduleKind: ScheduleKind;
  localDate: string | null;
  daypart: Daypart | null;
  startAt: string | null;
  endAt: string | null;
};

type AffectedTask = ScheduleShape & {
  id: string;
  title: string;
  lifecycleStatus: LifecycleStatus;
  timeZone: string;
  version: number;
  scheduleRevision: number;
  canReschedule: boolean;
};

export type PlanChangeAdjustmentReview = ScheduleShape & {
  taskId: string;
  taskTitle: string;
  timeZone: "Asia/Shanghai";
  reason: string;
  currentScheduleKind: ScheduleKind;
  currentLocalDate: string | null;
  currentDaypart: Daypart | null;
  currentStartAt: string | null;
  currentEndAt: string | null;
  expectedVersion: number;
  expectedScheduleRevision: number;
};

type Advisory = {
  referenceDate: string;
  summary: string;
  feasibility: Feasibility;
  affectedTasks: AffectedTask[];
  options: Array<{ title: string; detail: string; adjustments: PlanChangeAdjustmentReview[] }>;
  warnings: string[];
};

const API = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3000";

const daypartLabels: Record<Daypart, string> = { morning: "上午", afternoon: "下午", evening: "晚上" };
const lifecycleLabels: Record<LifecycleStatus, string> = {
  open: "可调整",
  active: "专注中，不能移动",
  awaiting_outcome: "等待结果，不能移动",
  closed: "已关闭，仅作历史参考",
  cancelled: "已取消"
};

function exactTimeRange(startAt: string, endAt: string) {
  const formatter = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false });
  return `${formatter.format(new Date(startAt))}–${formatter.format(new Date(endAt))}`;
}

function scheduleLabel(schedule: ScheduleShape) {
  if (schedule.scheduleKind === "exact" && schedule.startAt && schedule.endAt) return exactTimeRange(schedule.startAt, schedule.endAt);
  if (schedule.scheduleKind === "daypart" && schedule.localDate && schedule.daypart) return `${schedule.localDate} · ${daypartLabels[schedule.daypart]}`;
  return schedule.localDate ? `${schedule.localDate} · 未排具体时间` : "未排期";
}

const feasibilityLabel: Record<Feasibility, string> = {
  feasible: "可行，但由你决定",
  risky: "存在安排风险",
  needs_clarification: "还需要一点信息"
};

export function PlanChangeDrawer({
  taskId,
  taskTitle,
  onReviewAdjustment,
  onBackToTimeline
}: {
  taskId: string;
  taskTitle: string;
  onReviewAdjustment: (adjustment: PlanChangeAdjustmentReview) => void;
  onBackToTimeline: () => void;
}) {
  const [message, setMessage] = useState("");
  const [advisory, setAdvisory] = useState<Advisory | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function consult() {
    const text = message.trim();
    if (!text) {
      setError("先写下这次临时变化，AI 才能结合今天的安排分析。");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`${API}/api/v1/ai/plan-change-advisories`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskId, message: text })
      });
      const payload = await response.json().catch(() => ({})) as { advisory?: Advisory; error?: string };
      if (!response.ok || !payload.advisory) throw new Error(payload.error ?? "request_failed");
      setAdvisory(payload.advisory);
    } catch {
      setError("AI 暂时无法分析这次变动，原始说明仍保留在这里。你也可以直接回到时间轴自行调整。");
    } finally {
      setLoading(false);
    }
  }

  return <section className="plan-change-drawer" aria-labelledby="plan-change-title">
    <div className="plan-change-intro">
      <span className="plan-change-icon"><CalendarClock /></span>
      <div>
        <p className="section-kicker">计划变更协商</p>
        <h2 id="plan-change-title">先看影响，再由你决定。</h2>
      </div>
    </div>
    <p className="plan-change-task">刚才的提醒已停止，<strong>{taskTitle}</strong> 仍保留在原定安排中。</p>
    <label className="plan-change-message">
      <span>这次有什么变化？</span>
      <textarea
        aria-label="变更说明"
        value={message}
        onChange={(event) => setMessage(event.target.value)}
        placeholder="例如：临时要处理一件事，今天下午两点后才有时间。"
        rows={5}
        maxLength={4000}
      />
    </label>
    <button className="primary-button full-width" type="button" disabled={loading || !message.trim()} onClick={() => void consult()}>
      {loading ? <LoaderCircle className="spin" /> : <MessageSquareText />}
      {loading ? "正在分析" : "查看协商建议"}
    </button>
    {error && <p className="plan-change-error" role="alert"><AlertTriangle />{error}</p>}
    {advisory && <section className="plan-change-advice" aria-live="polite">
      <div className={`plan-change-feasibility ${advisory.feasibility}`}><span>{feasibilityLabel[advisory.feasibility]}</span></div>
      <p className="plan-change-summary">{advisory.summary}</p>
      {advisory.affectedTasks.length > 0 && <section className="plan-change-affected">
        <h3>可能受影响</h3>
        <ul>{advisory.affectedTasks.map((task) => <li key={task.id}><div><strong>{task.title}</strong><small>{lifecycleLabels[task.lifecycleStatus]}</small></div><span>{scheduleLabel(task)}</span></li>)}</ul>
      </section>}
      <section className="plan-change-options">
        <h3>可选做法</h3>
        {advisory.options.map((option, index) => <article key={`${option.title}-${index}`}>
          <span>{String(index + 1).padStart(2, "0")}</span>
          <div>
            <strong>{option.title}</strong>
            <p>{option.detail}</p>
            {option.adjustments.length > 0 && <div className="plan-change-adjustments">
              {option.adjustments.map((adjustment) => <section key={`${adjustment.taskId}:${adjustment.expectedScheduleRevision}`}>
                <div><small>{adjustment.taskTitle}</small><span>{scheduleLabel({ scheduleKind: adjustment.currentScheduleKind, localDate: adjustment.currentLocalDate, daypart: adjustment.currentDaypart, startAt: adjustment.currentStartAt, endAt: adjustment.currentEndAt })} → {scheduleLabel(adjustment)}</span></div>
                <p>{adjustment.reason}</p>
                <button className="quiet-button" type="button" onClick={() => onReviewAdjustment(adjustment)}><PencilLine />打开确认表单</button>
              </section>)}
            </div>}
          </div>
        </article>)}
      </section>
      {advisory.warnings.length > 0 && <section className="plan-change-warnings"><h3>需要留意</h3><ul>{advisory.warnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}</ul></section>}
      <p className="plan-change-rule">这些只是候选建议。打开表单仍不会写入；只有你检查并点击“保存任务”后，排期才会改变。</p>
    </section>}
    <button className="quiet-button full-width plan-change-return" type="button" onClick={onBackToTimeline}>
      回到时间轴，自己决定调整 <ArrowRight />
    </button>
  </section>;
}
