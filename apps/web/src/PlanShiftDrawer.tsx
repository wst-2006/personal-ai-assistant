import { CalendarClock, Check, LoaderCircle, RefreshCw, X } from "lucide-react";
import { useState } from "react";
import { inferPlanInstructionDate } from "@personal-ai/domain/task";

type Adjustment = {
  taskId: string;
  title: string;
  expectedVersion: number;
  expectedScheduleRevision: number;
  currentStartAt: string;
  currentEndAt: string;
  nextStartAt: string;
  nextEndAt: string;
};
type Skipped = { taskId: string; title: string; reason: string };
type Preview = { localDate: string | null; offsetMinutes: number; adjustments: Adjustment[]; skipped: Skipped[] };
type ApiFailure = { error?: string; conflicts?: Array<{ title?: string }> };

const API = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3000";

export function parsePlanShiftOffset(text: string): number | null {
  const normalized = text.replace(/\s+/gu, "");
  const amount = normalized.match(/(\d+(?:\.5)?)小时/u);
  const minutes = normalized.match(/(\d+)分钟/u);
  const chineseHours = normalized.match(/([一二两三四五六七八九十])个?小时/u)?.[1];
  const chineseHourValues: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const value = /一个半小时|一小时半/u.test(normalized)
    ? 90
    : /半小时|半个小时/u.test(normalized)
      ? 30
      : amount
        ? Number(amount[1]) * 60
        : minutes
          ? Number(minutes[1])
          : chineseHours
            ? chineseHourValues[chineseHours]! * 60
            : null;
  if (!value || !Number.isFinite(value) || value % 30 !== 0) return null;
  return /提前|往前|前移/u.test(normalized) ? -value : value;
}

function shanghaiDate() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function range(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

function scopeLabel(localDate: string | null) {
  if (!localDate) return "全部日期";
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "long", day: "numeric" }).format(new Date(`${localDate}T00:00:00+08:00`));
}

export function PlanShiftDrawer({ initialText, onDone }: { initialText?: string; onDone: () => void }) {
  const [text, setText] = useState(initialText ?? "");
  const [date, setDate] = useState(() => inferPlanInstructionDate(initialText ?? "", shanghaiDate()) ?? "");
  const [dateWasEdited, setDateWasEdited] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function buildPreview() {
    const offsetMinutes = parsePlanShiftOffset(text);
    if (!offsetMinutes) { setError("请写清楚顺延多久，例如“计划：把今天所有任务往后延半个小时”。"); return; }
    setLoading(true); setError(null);
    try {
      const response = await fetch(`${API}/api/v1/tasks/bulk-shift/preview`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ localDate: date || null, offsetMinutes }) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? "preview_failed");
      setPreview(payload as Preview);
    } catch { setError("暂时无法读取当天排期，请确认本地服务正在运行。原话仍保留。"); }
    finally { setLoading(false); }
  }

  async function apply() {
    if (!preview || preview.adjustments.length === 0) return;
    setSaving(true); setError(null);
    try {
      const response = await fetch(`${API}/api/v1/tasks/bulk-shift`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ localDate: preview.localDate, offsetMinutes: preview.offsetMinutes, adjustments: preview.adjustments.map(({ taskId, expectedVersion, expectedScheduleRevision }) => ({ taskId, expectedVersion, expectedScheduleRevision })) }) });
      const payload = await response.json().catch(() => ({})) as ApiFailure;
      if (!response.ok) {
        if (payload.error === "task_time_conflict") {
          const titles = payload.conflicts?.map((item) => item.title).filter(Boolean).slice(0, 3).join("、");
          setError(`顺延后会与${titles ? `“${titles}”` : "其他任务"}重叠，排期没有改动。请调整作用日期或先处理冲突任务。`);
        } else if (payload.error === "task_version_conflict" || payload.error === "task_schedule_revision_conflict" || payload.error === "bulk_shift_invalid") {
          setError("预览后任务状态发生了变化，排期没有改动。请重新生成预览再确认。");
        } else {
          setError("保存没有完成，排期保持原样；请重新读取预览后再确认。");
        }
        return;
      }
      onDone();
    } catch { setError("保存没有完成，排期保持原样；请确认本地服务正在运行后重试。"); }
    finally { setSaving(false); }
  }

  return <section className="plan-shift-drawer" aria-labelledby="plan-shift-title">
    <div className="plan-change-intro"><span className="plan-change-icon"><CalendarClock /></span><div><p className="section-kicker">计划调整</p><h2 id="plan-shift-title">批量顺延，但先让你确认。</h2></div></div>
    <p className="plan-change-task">以“计划：”或“计划 ”开头的内容会进入这里，不会被当成新任务。只移动仍可编辑的精确排期。</p>
    <label className="plan-change-message"><span>调整说明</span><textarea aria-label="计划调整说明" value={text} onChange={(event) => { const nextText = event.target.value; setText(nextText); if (!dateWasEdited) setDate(inferPlanInstructionDate(nextText, shanghaiDate()) ?? ""); setPreview(null); }} rows={3} maxLength={4000} placeholder="计划：把今天所有任务往后延半个小时" /></label>
    <label className="plan-shift-date"><span>作用日期（留空表示全部日期）</span><input type="date" value={date} onChange={(event) => { setDateWasEdited(true); setDate(event.target.value); setPreview(null); }} /></label>
    <button className="primary-button full-width" type="button" disabled={loading || !text.trim()} onClick={() => void buildPreview()}>{loading ? <LoaderCircle className="spin" /> : <RefreshCw />}{loading ? "正在读取排期" : "生成调整预览"}</button>
    {error && <p className="plan-change-error" role="alert"><X />{error}</p>}
    {preview && <section className="plan-shift-preview" aria-live="polite"><p className="plan-shift-summary">范围：{scopeLabel(preview.localDate)}。将{preview.offsetMinutes > 0 ? "顺延" : "提前"} {Math.abs(preview.offsetMinutes)} 分钟，共 {preview.adjustments.length} 项。</p>{preview.adjustments.length > 0 && <ul>{preview.adjustments.map((item) => <li key={item.taskId}><strong>{item.title}</strong><span>{range(item.currentStartAt)}–{range(item.currentEndAt)} → {range(item.nextStartAt)}–{range(item.nextEndAt)}</span></li>)}</ul>}{preview.skipped.length > 0 && <div className="plan-shift-skipped"><strong>不会移动</strong>{preview.skipped.map((item) => <p key={item.taskId}>{item.title}：{item.reason}</p>)}</div>}<button className="primary-button full-width" type="button" disabled={saving || preview.adjustments.length === 0} onClick={() => void apply()}>{saving ? <LoaderCircle className="spin" /> : <Check />}{saving ? "正在保存" : `确认执行：${preview.offsetMinutes > 0 ? "顺延" : "提前"} ${preview.adjustments.length} 项`}</button></section>}
  </section>;
}
