import { useEffect, useState } from "react";
import { CheckCircle2, Leaf, Sparkles, Timer, TrendingUp } from "lucide-react";

type Tone = "quiet" | "steady" | "bright" | "strained";
type TrendGranularity = "day" | "week" | "month";
type TrendPoint = { startDate: string; endDate: string; focusMinutes: number };
type Summary = {
  days: Array<{ localDate: string; focusMinutes: number; closedTasks: number; plannedTasks: number; tone: Tone }>;
  focusTrend: { granularity: TrendGranularity; points: TrendPoint[] };
  focusMinutes: number;
  plannedTasks: number;
  closedTasks: number;
  satisfaction: { satisfied: number; neutral: number; dissatisfied: number };
  radar: Array<{ key: string; label: string; value: number | null; source: "system" | "user"; sampleDays: number }>;
  garden: { points: number; growthPercent: number; treeKind: string; quality: number };
};
type WindowDays = 7 | 30 | 90 | 365;

const API = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3000";
const WINDOW_OPTIONS: Array<{ days: WindowDays; label: string }> = [
  { days: 7, label: "最近 7 天" },
  { days: 30, label: "最近 30 天" },
  { days: 90, label: "最近 90 天" },
  { days: 365, label: "最近 1 年" }
];
const CHART_WIDTH = 720;
const CHART_HEIGHT = 220;
const CHART_PADDING = { top: 18, right: 18, bottom: 42, left: 48 };

const localDate = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const weekday = (value: string) => new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", weekday: "short" }).format(new Date(`${value}T12:00:00Z`)).replace("周", "");
const compactDate = (value: string) => `${Number(value.slice(5, 7))}/${Number(value.slice(8, 10))}`;
const dayLabel = (value: string, windowDays: WindowDays) => windowDays === 7 ? weekday(value) : value.slice(8);
const stateTitle = (windowDays: WindowDays) => windowDays === 7 ? "一周留下的色块" : windowDays === 30 ? "一个月留下的色块" : windowDays === 90 ? "近三个月状态图" : "一年状态图";
const trendPeriodLabel = (point: TrendPoint, granularity: TrendGranularity) => {
  if (granularity === "month") return `${Number(point.startDate.slice(5, 7))}月`;
  if (granularity === "week") return `${compactDate(point.startDate)} 起`;
  return compactDate(point.startDate);
};
const trendPointTitle = (point: TrendPoint, granularity: TrendGranularity) => {
  const range = point.startDate === point.endDate ? point.startDate : `${point.startDate} 至 ${point.endDate}`;
  const period = granularity === "month" ? "本月" : granularity === "week" ? "本周" : "当天";
  return `${range} · ${period}有效专注 ${point.focusMinutes} 分钟`;
};
const leadingCalendarCells = (startDate: string) => {
  const weekdayIndex = new Date(`${startDate}T00:00:00.000Z`).getUTCDay();
  return weekdayIndex === 0 ? 6 : weekdayIndex - 1;
};

function FocusTrendChart({ trend }: { trend: Summary["focusTrend"] }) {
  const plotWidth = CHART_WIDTH - CHART_PADDING.left - CHART_PADDING.right;
  const plotHeight = CHART_HEIGHT - CHART_PADDING.top - CHART_PADDING.bottom;
  const maxMinutes = Math.max(30, ...trend.points.map((point) => point.focusMinutes));
  const coordinates = trend.points.map((point, index) => ({
    x: CHART_PADDING.left + (trend.points.length === 1 ? plotWidth / 2 : index / (trend.points.length - 1) * plotWidth),
    y: CHART_PADDING.top + plotHeight - point.focusMinutes / maxMinutes * plotHeight,
    point
  }));
  const path = coordinates.map(({ x, y }, index) => `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`).join(" ");
  const labelStep = Math.max(1, Math.ceil(trend.points.length / 6));
  const yTicks = [0, 0.5, 1];

  return <div className="focus-line-chart" data-granularity={trend.granularity}>
    <svg viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} role="img" aria-label="有效专注时长折线图">
      {yTicks.map((ratio) => {
        const y = CHART_PADDING.top + plotHeight - ratio * plotHeight;
        return <g key={ratio} className="focus-line-grid">
          <line x1={CHART_PADDING.left} x2={CHART_WIDTH - CHART_PADDING.right} y1={y} y2={y} />
          <text x={CHART_PADDING.left - 9} y={y + 4}>{Math.round(maxMinutes * ratio)}m</text>
        </g>;
      })}
      <path className="focus-line-path" d={path} />
      {coordinates.map(({ x, y, point }, index) => <g key={`${point.startDate}:${point.endDate}`} className="focus-line-point">
        <circle cx={x} cy={y} r="4"><title>{trendPointTitle(point, trend.granularity)}</title></circle>
        {(index % labelStep === 0 || index === coordinates.length - 1) && <text className="focus-line-label" x={x} y={CHART_HEIGHT - 13}>{trendPeriodLabel(point, trend.granularity)}</text>}
      </g>)}
    </svg>
    <p>{trend.granularity === "day" ? "按日" : trend.granularity === "week" ? "按周汇总" : "按月汇总"}，时间范围内共记录 {trend.points.reduce((total, point) => total + point.focusMinutes, 0)} 分钟有效专注。</p>
  </div>;
}

function StateGrid({ days, windowDays }: { days: Summary["days"]; windowDays: WindowDays }) {
  const compact = windowDays >= 90;
  if (!compact) {
    return <div className={`state-grid ${windowDays === 30 ? "month-state-grid" : ""}`}>
      {days.map((day) => <div key={day.localDate} className={`state-cell ${day.tone}`} title={`${day.localDate} · ${day.focusMinutes} 分钟 · ${day.closedTasks} 项结束`}>
        <strong>{dayLabel(day.localDate, windowDays)}</strong><span>{day.focusMinutes}m</span><small>{day.closedTasks} 项</small>
      </div>)}
    </div>;
  }

  const placeholders = days.length ? leadingCalendarCells(days[0]!.localDate) : 0;
  return <div className="state-heatmap-scroll" aria-label={`${windowDays} 天每日状态色块`}>
    <div className="state-grid compact-state-grid" data-window-days={windowDays}>
      {Array.from({ length: placeholders }, (_, index) => <span className="state-cell-placeholder" aria-hidden="true" key={`placeholder-${index}`} />)}
      {days.map((day) => <span
        key={day.localDate}
        className={`state-cell ${day.tone}`}
        role="img"
        aria-label={`${day.localDate}，有效专注 ${day.focusMinutes} 分钟，结束 ${day.closedTasks} 项任务`}
        title={`${day.localDate} · ${day.focusMinutes} 分钟 · ${day.closedTasks} 项结束`}
      />)}
    </div>
  </div>;
}

export function GrowthWorkspace() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [windowDays, setWindowDays] = useState<WindowDays>(7);

  useEffect(() => {
    const controller = new AbortController();
    setSummary(null);
    setError(null);
    void fetch(`${API}/api/v1/growth/summary?endDate=${localDate()}&days=${windowDays}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("growth_request_failed");
        const body = await response.json() as { summary: Summary };
        setSummary(body.summary);
      })
      .catch((loadError: unknown) => {
        if (loadError instanceof DOMException && loadError.name === "AbortError") return;
        setError("无法读取成长数据，请确认 API 正在运行。");
      });
    return () => controller.abort();
  }, [windowDays]);

  const rangeDescription = WINDOW_OPTIONS.find((option) => option.days === windowDays)?.label ?? "当前范围";

  return <section className="page growth-page" aria-labelledby="growth-title" aria-busy={!summary && !error}>
    <div className="growth-heading">
      <div><p className="eyebrow">成长花园</p><h1 id="growth-title">生长来自留下的数据。</h1></div>
      <div className="growth-range-switch" role="group" aria-label="成长时间范围">
        {WINDOW_OPTIONS.map((option) => <button type="button" key={option.days} aria-pressed={windowDays === option.days} onClick={() => setWindowDays(option.days)}>{option.label}</button>)}
      </div>
    </div>
    {!summary && !error ? <div className="growth-loading"><Leaf /><p>正在汇集{rangeDescription}的真实记录。</p></div> : summary ? <>
      <section className="growth-hero" aria-label="成长概览">
        <div className="growth-plant"><span className="plant-stem" style={{ height: `${Math.max(42, summary.garden.growthPercent * 1.5)}px` }} /><i /><b /></div>
        <div><p className="section-kicker">当前树种</p><strong>{summary.garden.treeKind}</strong><p>由近期完成质量决定，专注时长推动生长进度。</p></div>
        <div className="growth-hero-stats"><span><Timer />{summary.focusMinutes} 分钟</span><span><CheckCircle2 />{summary.closedTasks}/{summary.plannedTasks} 项结束</span><span><Sparkles />{summary.garden.points} 积分</span></div>
      </section>
      <div className="growth-grid">
        <section className="growth-panel focus-trend">
          <div className="panel-heading"><div><p className="section-kicker">专注轨迹</p><h2>有效专注时长</h2></div><TrendingUp /></div>
          <FocusTrendChart trend={summary.focusTrend} />
        </section>
        <section className="growth-panel">
          <div className="panel-heading"><div><p className="section-kicker">每日状态</p><h2>{stateTitle(windowDays)}</h2></div><Leaf /></div>
          <p className="growth-state-legend">绿色偏满意，黄色为混合或一般，红色偏不满意；灰色表示当天没有主观反馈。</p>
          <StateGrid days={summary.days} windowDays={windowDays} />
        </section>
        <section className="growth-panel radar-panel">
          <div className="panel-heading"><div><p className="section-kicker">六维回看</p><h2>系统预填与主动评价分开</h2></div><span>{summary.garden.quality}%</span></div>
          <div className="radar-list">{summary.radar.map((metric) => <div key={metric.key}><span><span className="metric-label">{metric.label}</span><small>{metric.source === "system" ? "记录预填" : `${metric.sampleDays} 天已填`}</small></span><i><b style={{ width: `${metric.value ?? 0}%` }} /></i><strong>{metric.value ?? "未填"}</strong></div>)}</div>
        </section>
        <section className="growth-panel feeling-panel">
          <div className="panel-heading"><div><p className="section-kicker">主观感受</p><h2>专注之后的声音</h2></div><Sparkles /></div>
          <div className="feeling-row"><span className="satisfied">满意 <strong>{summary.satisfaction.satisfied}</strong></span><span className="neutral">一般 <strong>{summary.satisfaction.neutral}</strong></span><span className="dissatisfied">不满意 <strong>{summary.satisfaction.dissatisfied}</strong></span></div>
        </section>
      </div>
    </> : null}
    {error && <div className="focus-error" role="alert">{error}</div>}
  </section>;
}
