import { useCallback, useEffect, useMemo, useState } from "react";
import { BarChart3, CheckCircle2, Leaf, Sparkles, Timer } from "lucide-react";

type Summary = {
  days: Array<{ localDate: string; focusMinutes: number; closedTasks: number; plannedTasks: number; tone: "quiet" | "steady" | "bright" | "strained" }>;
  focusMinutes: number; plannedTasks: number; closedTasks: number;
  satisfaction: { satisfied: number; neutral: number; dissatisfied: number };
  radar: Array<{ key: string; label: string; value: number | null; source: "system" | "user"; sampleDays: number }>;
  garden: { points: number; growthPercent: number; treeKind: string; quality: number };
};
type WindowDays = 7 | 30;
const API = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3000";
const localDate = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const weekday = (value: string) => new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", weekday: "short" }).format(new Date(`${value}T12:00:00Z`)).replace("周", "");
const dayLabel = (value: string, windowDays: WindowDays) => windowDays === 30 ? value.slice(8) : weekday(value);

export function GrowthWorkspace() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [windowDays, setWindowDays] = useState<WindowDays>(7);
  const load = useCallback(async () => {
    const response = await fetch(`${API}/api/v1/growth/summary?endDate=${localDate()}&days=${windowDays}`);
    if (!response.ok) throw new Error("growth_request_failed");
    setSummary((await response.json() as { summary: Summary }).summary);
  }, [windowDays]);
  useEffect(() => { void load().catch(() => setError("无法读取成长数据，请确认 API 正在运行。")); }, [load]);
  const maxFocus = useMemo(() => Math.max(30, ...(summary?.days.map((day) => day.focusMinutes) ?? [30])), [summary]);
  return <section className="page growth-page" aria-labelledby="growth-title">
    <div className="growth-heading"><div><p className="eyebrow">成长花园</p><h1 id="growth-title">生长来自留下的数据。</h1></div><div className="growth-range-switch" role="group" aria-label="成长时间范围"><button type="button" aria-pressed={windowDays === 7} onClick={() => setWindowDays(7)}>最近 7 天</button><button type="button" aria-pressed={windowDays === 30} onClick={() => setWindowDays(30)}>最近 30 天</button></div></div>
    {!summary ? <div className="growth-loading"><Leaf /><p>正在汇集你的真实记录。</p></div> : <>
      <section className="growth-hero" aria-label="成长概览"><div className="growth-plant"><span className="plant-stem" style={{ height: `${Math.max(42, summary.garden.growthPercent * 1.5)}px` }} /><i /><b /></div><div><p className="section-kicker">当前树种</p><strong>{summary.garden.treeKind}</strong><p>由近期完成质量决定，专注时长推动生长进度。</p></div><div className="growth-hero-stats"><span><Timer />{summary.focusMinutes} 分钟</span><span><CheckCircle2 />{summary.closedTasks}/{summary.plannedTasks} 项结束</span><span><Sparkles />{summary.garden.points} 积分</span></div></section>
      <div className="growth-grid"><section className="growth-panel focus-trend"><div className="panel-heading"><div><p className="section-kicker">专注轨迹</p><h2>有效专注时长</h2></div><BarChart3 /></div><div className={`bar-chart ${windowDays === 30 ? "month-chart" : ""}`}>{summary.days.map((day) => <div className="bar-day" key={day.localDate}><div className="bar-track"><span style={{ height: `${Math.max(day.focusMinutes ? 8 : 2, day.focusMinutes / maxFocus * 100)}%` }} title={`${day.localDate} · ${day.focusMinutes} 分钟`} /></div><strong>{day.focusMinutes || "-"}</strong><small>{dayLabel(day.localDate, windowDays)}</small></div>)}</div></section>
        <section className="growth-panel"><div className="panel-heading"><div><p className="section-kicker">每日状态</p><h2>{windowDays === 30 ? "一个月留下的色块" : "一周留下的色块"}</h2></div><Leaf /></div><p className="growth-state-legend">绿色偏满意，黄色为混合或一般，红色偏不满意；灰色表示当天没有主观反馈。</p><div className={`state-grid ${windowDays === 30 ? "month-state-grid" : ""}`}>{summary.days.map((day) => <div key={day.localDate} className={`state-cell ${day.tone}`} title={`${day.localDate} · ${day.focusMinutes} 分钟 · ${day.closedTasks} 项结束`}><strong>{dayLabel(day.localDate, windowDays)}</strong><span>{day.focusMinutes}m</span><small>{day.closedTasks} 项</small></div>)}</div></section>
        <section className="growth-panel radar-panel"><div className="panel-heading"><div><p className="section-kicker">六维回看</p><h2>系统预填与主动评价分开</h2></div><span>{summary.garden.quality}%</span></div><div className="radar-list">{summary.radar.map((metric) => <div key={metric.key}><span><span className="metric-label">{metric.label}</span><small>{metric.source === "system" ? "记录预填" : `${metric.sampleDays} 天已填`}</small></span><i><b style={{ width: `${metric.value ?? 0}%` }} /></i><strong>{metric.value ?? "未填"}</strong></div>)}</div></section>
        <section className="growth-panel feeling-panel"><div className="panel-heading"><div><p className="section-kicker">主观感受</p><h2>专注之后的声音</h2></div><Sparkles /></div><div className="feeling-row"><span className="satisfied">满意 <strong>{summary.satisfaction.satisfied}</strong></span><span className="neutral">一般 <strong>{summary.satisfaction.neutral}</strong></span><span className="dissatisfied">不满意 <strong>{summary.satisfaction.dissatisfied}</strong></span></div></section>
      </div></>}
    {error && <div className="focus-error" role="alert">{error}</div>}
  </section>;
}
