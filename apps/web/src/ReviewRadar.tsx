import { useCallback, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { REVIEW_RADAR_STAGES } from "@personal-ai/domain/review";

export type RadarKey = "mainlineProgress" | "overallExecution" | "focusQuality" | "energyState" | "wellbeing" | "growthGain";
export type RadarValues = Record<RadarKey, number>;

export const RADAR_DIMENSIONS: Array<{ key: RadarKey; label: string }> = [
  { key: "mainlineProgress", label: "主线推进" },
  { key: "overallExecution", label: "总体执行" },
  { key: "focusQuality", label: "专注质量" },
  { key: "energyState", label: "精力状态" },
  { key: "wellbeing", label: "身心维护" },
  { key: "growthGain", label: "成长获得" }
];

const DEFAULT_RADAR_VALUES: RadarValues = {
  mainlineProgress: 60,
  overallExecution: 40,
  focusQuality: 60,
  energyState: 40,
  wellbeing: 60,
  growthGain: 40
};

const VIEWBOX_WIDTH = 360;
const VIEWBOX_HEIGHT = 304;
const CENTER = { x: 180, y: 145 };
const RADIUS = 94;
const RING_LEVELS = [...REVIEW_RADAR_STAGES];

export function numericRadarValues(values?: Partial<Record<RadarKey, number | null>>): RadarValues {
  return Object.fromEntries(RADAR_DIMENSIONS.map(({ key }) => [
    key,
    typeof values?.[key] === "number" ? clampScore(values[key]!) : DEFAULT_RADAR_VALUES[key]
  ])) as RadarValues;
}

export function parseRadarSnapshotContent(content: string): RadarValues | null {
  try {
    const parsed = JSON.parse(content) as { version?: unknown; radar?: unknown };
    if (parsed.version !== 1 || !parsed.radar || typeof parsed.radar !== "object") return null;
    return numericRadarValues(parsed.radar as Partial<Record<RadarKey, number | null>>);
  } catch {
    return null;
  }
}

function axisPoint(index: number, radius: number) {
  const angle = -Math.PI / 2 + index * Math.PI * 2 / RADAR_DIMENSIONS.length;
  return { x: CENTER.x + Math.cos(angle) * radius, y: CENTER.y + Math.sin(angle) * radius };
}

function polygonPoints(values: RadarValues, radius = RADIUS) {
  return RADAR_DIMENSIONS.map(({ key }, index) => {
    const point = axisPoint(index, radius * values[key] / 100);
    return `${point.x.toFixed(2)},${point.y.toFixed(2)}`;
  }).join(" ");
}

function clampScore(value: number) {
  return RING_LEVELS.reduce((nearest, stage) => (
    Math.abs(stage - value) < Math.abs(nearest - value) ? stage : nearest
  ), RING_LEVELS[0]);
}

function formatScore(value: number) {
  return String(value);
}

type RadarChartProps = {
  values: RadarValues;
  editable?: boolean;
  onChange?: (key: RadarKey, value: number) => void;
  ariaLabel?: string;
  compact?: boolean;
};

export function RadarChart({ values, editable = false, onChange, ariaLabel = "六维回看雷达图", compact = false }: RadarChartProps) {
  const [dragKey, setDragKey] = useState<RadarKey | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const activeIndex = useMemo(() => dragKey ? RADAR_DIMENSIONS.findIndex(({ key }) => key === dragKey) : -1, [dragKey]);

  const scoreFromPointer = useCallback((event: ReactPointerEvent<SVGElement>, key: RadarKey) => {
    if (!svgRef.current) return null;
    const rect = svgRef.current.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width * VIEWBOX_WIDTH;
    const y = (event.clientY - rect.top) / rect.height * VIEWBOX_HEIGHT;
    const index = RADAR_DIMENSIONS.findIndex(({ key: axisKey }) => axisKey === key);
    if (index < 0) return null;
    const axis = axisPoint(index, 1);
    const distanceOnAxis = (x - CENTER.x) * (axis.x - CENTER.x) + (y - CENTER.y) * (axis.y - CENTER.y);
    return clampScore(distanceOnAxis / RADIUS * 100);
  }, []);

  const updateFromPointer = useCallback((event: ReactPointerEvent<SVGSVGElement>) => {
    if (!editable || !dragKey || !onChange || !svgRef.current) return;
    const score = scoreFromPointer(event, dragKey);
    if (score !== null) onChange(dragKey, score);
  }, [dragKey, editable, onChange, scoreFromPointer]);

  const beginDrag = useCallback((event: ReactPointerEvent<SVGElement>, key: RadarKey) => {
    if (!editable || !onChange) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragKey(key);
    const score = scoreFromPointer(event, key);
    if (score !== null) onChange(key, score);
  }, [editable, onChange, scoreFromPointer]);

  function handleKeyDown(event: ReactKeyboardEvent<SVGCircleElement>, key: RadarKey) {
    if (!editable || !onChange) return;
    if (!["ArrowUp", "ArrowRight", "ArrowDown", "ArrowLeft"].includes(event.key)) return;
    event.preventDefault();
    const currentStage = RING_LEVELS.indexOf(clampScore(values[key]));
    const direction = event.key === "ArrowUp" || event.key === "ArrowRight" ? 1 : -1;
    const nextStage = Math.max(0, Math.min(RING_LEVELS.length - 1, currentStage + direction));
    onChange(key, RING_LEVELS[nextStage]!);
  }

  return <svg
    ref={svgRef}
    className={`review-radar-chart${compact ? " compact" : ""}`}
    viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`}
    role={editable ? "application" : "img"}
    aria-label={ariaLabel}
    onPointerMove={updateFromPointer}
    onPointerUp={() => setDragKey(null)}
    onPointerCancel={() => setDragKey(null)}
  >
    <g className="review-radar-grid" aria-hidden="true">
      {RING_LEVELS.map((level) => <polygon key={level} points={polygonPoints(numericRadarValues(Object.fromEntries(RADAR_DIMENSIONS.map(({ key }) => [key, level]))), RADIUS)} />)}
      {RADAR_DIMENSIONS.map((_, index) => { const point = axisPoint(index, RADIUS); return <line key={index} x1={CENTER.x} y1={CENTER.y} x2={point.x} y2={point.y} />; })}
    </g>
    {editable && RADAR_DIMENSIONS.map(({ key }, index) => {
      const point = axisPoint(index, RADIUS + 4);
      return <line
        key={`hit-${key}`}
        className={`review-radar-axis-hit${dragKey === key ? " active" : ""}`}
        x1={CENTER.x}
        y1={CENTER.y}
        x2={point.x}
        y2={point.y}
        aria-label={`${RADAR_DIMENSIONS[index]!.label}拖动轴`}
        onPointerDown={(event) => beginDrag(event, key)}
      />;
    })}
    <polygon className="review-radar-area" points={polygonPoints(values)} />
    <polyline className="review-radar-outline" points={`${polygonPoints(values)} ${polygonPoints(values).split(" ")[0]}`} />
    {RADAR_DIMENSIONS.map(({ key, label }, index) => {
      const labelPoint = axisPoint(index, compact ? 117 : 126);
      const valuePoint = axisPoint(index, RADIUS * values[key] / 100);
      const textAnchor = labelPoint.x < CENTER.x - 4 ? "end" : labelPoint.x > CENTER.x + 4 ? "start" : "middle";
      return <g className="review-radar-axis" key={key}>
        <text x={labelPoint.x} y={labelPoint.y - 3} textAnchor={textAnchor}>{label}</text>
        <text className="review-radar-value" x={labelPoint.x} y={labelPoint.y + 12} textAnchor={textAnchor}>{formatScore(values[key])}</text>
        <circle
          className={`review-radar-handle${editable ? " editable" : ""}${dragKey === key ? " active" : ""}`}
          cx={valuePoint.x}
          cy={valuePoint.y}
          r={editable ? 6 : 3.5}
          tabIndex={editable ? 0 : undefined}
          role={editable ? "slider" : undefined}
          aria-label={editable ? `${label}，${values[key]} 分，可拖动调整` : undefined}
          aria-valuemin={editable ? RING_LEVELS[0] : undefined}
          aria-valuemax={editable ? 100 : undefined}
          aria-valuenow={editable ? values[key] : undefined}
          aria-valuetext={editable ? `第 ${RING_LEVELS.indexOf(clampScore(values[key])) + 1} 层，共 ${RING_LEVELS.length} 层` : undefined}
          onPointerDown={(event) => {
            beginDrag(event, key);
          }}
          onKeyDown={(event) => handleKeyDown(event, key)}
        />
      </g>;
    })}
    <circle className="review-radar-center" cx={CENTER.x} cy={CENTER.y} r={2.5} aria-hidden="true" />
    {activeIndex >= 0 && <title>{RADAR_DIMENSIONS[activeIndex]?.label}：{values[dragKey!]}</title>}
  </svg>;
}

type RadarEditorProps = {
  values: RadarValues;
  onChange: (key: RadarKey, value: number) => void;
  onSave: () => void;
  saving?: boolean;
  saved?: boolean;
};

export function RadarEditor({ values, onChange, onSave, saving = false, saved = false }: RadarEditorProps) {
  return <div className="review-radar-editor-shell">
    <RadarChart values={values} editable onChange={onChange} ariaLabel="可拖动调整的六维回看雷达图" />
    <div className="review-radar-score-list" aria-label="六维评分">
      {RADAR_DIMENSIONS.map(({ key, label }) => <div key={key}><span>{label}</span><strong>{formatScore(values[key])}</strong></div>)}
    </div>
    <footer className="review-radar-editor-footer">
      <span>{saved ? "已保存到今日复盘" : "每个点只停在五层六边形的顶点上"}</span>
      <button className="primary-button" type="button" onClick={onSave} disabled={saving}>{saving ? "正在保存" : "保存六维回看"}</button>
    </footer>
  </div>;
}
