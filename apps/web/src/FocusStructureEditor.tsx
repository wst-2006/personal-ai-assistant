import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, RotateCcw, Save, Sparkles, Trash2 } from "lucide-react";
import {
  allocateContinuousFocusStructure,
  allocateTemplateFocusStructure,
  adjustAdjacentFocusSegments,
  type FocusDistribution,
  type FocusSegment
} from "@personal-ai/domain/focus";

export type FocusStructureRecord = {
  id: string;
  state: "candidate" | "active" | "superseded" | "invalidated" | "cancelled";
  source: "manual" | "template" | "ai";
  taskScheduleRevision: number;
  totalStartAt: string;
  totalEndAt: string;
  version: number;
  segments: Array<FocusSegment & { position: number }>;
};

type EditorTask = {
  id: string;
  startAt: string;
  endAt: string;
  timeZone: string;
};

type Props = {
  task: EditorTask;
  active: FocusStructureRecord | null;
  candidate: FocusStructureRecord | null;
  busy: boolean;
  onSave: (segments: FocusSegment[], source: "manual" | "template") => Promise<void>;
  onPlanAi: (instructions: string | null) => Promise<void>;
  onConfirm: () => Promise<void>;
  onConfirmDraft: (segments: FocusSegment[]) => Promise<void>;
  onDiscard: () => Promise<void>;
};

const distributions: Array<{ value: FocusDistribution | "custom"; label: string }> = [
  { value: "equal", label: "等长" },
  { value: "increasing", label: "逐渐延长" },
  { value: "decreasing", label: "逐渐缩短" },
  { value: "custom", label: "自定义" }
];

export function FocusStructureEditor({ task, active, candidate, busy, onSave, onPlanAi, onConfirm, onConfirmDraft, onDiscard }: Props) {
  const totalMinutes = Math.round((new Date(task.endAt).getTime() - new Date(task.startAt).getTime()) / 60_000);
  const defaultBreak = totalMinutes >= 120 ? 15 : totalMinutes >= 90 ? 10 : 5;
  const [focusCount, setFocusCount] = useState(1);
  const [distribution, setDistribution] = useState<FocusDistribution | "custom">("equal");
  const [breakMinutes, setBreakMinutes] = useState(defaultBreak);
  const [segments, setSegments] = useState<FocusSegment[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [aiInstructions, setAiInstructions] = useState("");
  const dragRef = useRef<null | { boundaryIndex: number; startX: number; width: number; initial: FocusSegment[] }>(null);
  const maxCount = totalMinutes === 30 ? 1 : Math.max(1, Math.floor(totalMinutes / (30 + Math.max(5, breakMinutes))));

  useEffect(() => {
    const stored = candidate ?? active;
    if (stored) {
      const storedSegments = stored.segments.map(({ segmentType, durationMinutes }) => ({ segmentType, durationMinutes }));
      const next = totalMinutes === 30 && storedSegments.length === 1 && storedSegments[0]?.segmentType === "focus" && storedSegments[0].durationMinutes === 30
        ? [{ segmentType: "focus" as const, durationMinutes: 25 }, { segmentType: "break" as const, durationMinutes: 5 }]
        : storedSegments;
      const focusDurations = next.filter((segment) => segment.segmentType === "focus").map((segment) => segment.durationMinutes);
      setSegments(next);
      setFocusCount(focusDurations.length);
      setBreakMinutes(next.find((segment) => segment.segmentType === "break")?.durationMinutes ?? 0);
      setDistribution(inferDistribution(focusDurations));
      setLocalError(null);
    } else {
      try {
        const initial = allocateContinuousFocusStructure({
          totalStartAt: task.startAt,
          totalEndAt: task.endAt,
          breakMinutes: defaultBreak
        });
        setSegments(initial.segments);
        setFocusCount(1);
        setBreakMinutes(initial.breakMinutes);
        setDistribution("equal");
        setLocalError(null);
      } catch (error) {
        setSegments([]);
        setFocusCount(1);
        setBreakMinutes(defaultBreak);
        setDistribution("equal");
        setLocalError(error instanceof Error ? templateError(error.message) : "当前时间块无法生成专注结构。");
      }
    }
  }, [active?.id, active?.version, candidate?.id, candidate?.version, task.id, task.startAt, task.endAt, totalMinutes]);

  const validation = useMemo(() => validateDraft(segments, totalMinutes), [segments, totalMinutes]);
  const candidateSegments = candidate?.segments.map(({ segmentType, durationMinutes }) => ({ segmentType, durationMinutes })) ?? null;
  const activeSegments = active?.segments.map(({ segmentType, durationMinutes }) => ({ segmentType, durationMinutes })) ?? null;
  const candidateMatchesDraft = candidateSegments ? sameSegments(candidateSegments, segments) : false;
  const activeMatchesDraft = activeSegments ? sameSegments(activeSegments, segments) : false;
  const usingActive = Boolean(active && !candidate && activeMatchesDraft);
  const timeline = useMemo(() => segmentTimeline(task.startAt, task.timeZone, segments), [task.startAt, task.timeZone, segments]);
  const timeRange = `${formatClock(task.startAt, task.timeZone)}–${formatClock(task.endAt, task.timeZone)}`;

  function applyTemplate(count: number, mode: FocusDistribution, rest = breakMinutes) {
    try {
      const allocation = allocateTemplateFocusStructure({
        totalStartAt: task.startAt,
        totalEndAt: task.endAt,
        focusCount: count,
        distribution: mode,
        breakMinutes: rest || defaultBreak
      });
      setFocusCount(count);
      setDistribution(mode);
      setBreakMinutes(allocation.segments.find((segment) => segment.segmentType === "break")?.durationMinutes ?? 0);
      setSegments(allocation.segments);
      setLocalError(null);
    } catch (error) {
      setLocalError(error instanceof Error ? templateError(error.message) : "当前时间块无法生成这个结构。");
    }
  }

  function chooseCount(count: number) {
    if (count > maxCount) return;
    applyTemplate(count, distribution === "custom" ? "equal" : distribution);
  }

  function chooseDistribution(value: FocusDistribution | "custom") {
    if (value === "custom") {
      setDistribution(value);
      setExpanded(true);
      return;
    }
    applyTemplate(focusCount, value);
  }

  function chooseBreak(value: number) {
    if (!Number.isInteger(value) || value < 5 || value > 15) {
      setLocalError("休息时间必须为 5–15 分钟。");
      return;
    }
    applyTemplate(focusCount, distribution === "custom" ? "equal" : distribution, value);
  }

  function updateSegment(index: number, durationMinutes: number) {
    setDistribution("custom");
    setSegments((current) => current.map((segment, position) => position === index ? { ...segment, durationMinutes } : segment));
  }

  function beginBoundaryDrag(event: React.PointerEvent<HTMLButtonElement>, boundaryIndex: number) {
    if (busy) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const width = event.currentTarget.closest(".structure-timeline")?.getBoundingClientRect().width ?? 1;
    dragRef.current = { boundaryIndex, startX: event.clientX, width, initial: segments };
    setDistribution("custom");
  }

  function moveBoundary(event: React.PointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    const delta = Math.round(((event.clientX - drag.startX) / drag.width) * totalMinutes);
    setSegments(adjustAdjacentFocusSegments(drag.initial, drag.boundaryIndex, delta));
  }

  function endBoundaryDrag() {
    dragRef.current = null;
  }

  function restoreActive() {
    if (!active) return;
    const next = active.segments.map(({ segmentType, durationMinutes }) => ({ segmentType, durationMinutes }));
    const focusDurations = next.filter((segment) => segment.segmentType === "focus").map((segment) => segment.durationMinutes);
    setSegments(next);
    setFocusCount(focusDurations.length);
    setBreakMinutes(next.find((segment) => segment.segmentType === "break")?.durationMinutes ?? 0);
    setDistribution(inferDistribution(focusDurations));
    setLocalError(null);
  }

  async function save() {
    if (!validation.valid) return;
    setLocalError(null);
    await onSave(segments, distribution === "custom" ? "manual" : "template");
  }

  return (
    <section className="focus-structure-editor" aria-label="专注结构编辑器">
      <header className="structure-heading">
        <div>
          <p className="section-kicker">执行结构</p>
          <strong>{candidate ? candidate.source === "ai" ? "AI 候选，等待你确认" : "候选方案，等待确认" : usingActive ? "当前使用方案" : active ? "已调整，等待确认" : "先安排这段时间"}</strong>
        </div>
        <span>{timeRange} · {totalMinutes} 分钟</span>
      </header>

      <div className="structure-template-row" aria-label="专注段数">
        {[1, 2, 3, 4].map((count) => (
          <button
            type="button"
            aria-pressed={focusCount === count}
            disabled={busy || count > maxCount}
            onClick={() => chooseCount(count)}
            key={count}
          >
            {count === 1 ? "连续" : `${count} 段`}
          </button>
        ))}
        <label className={maxCount <= 4 ? "disabled" : ""}>
          <span>更多</span>
          <input
            aria-label="更多专注段数"
            type="number"
            min="5"
            max={maxCount}
            disabled={busy || maxCount <= 4}
            value={focusCount > 4 ? focusCount : 5}
            onChange={(event) => chooseCount(Number(event.target.value))}
          />
        </label>
      </div>

      {focusCount > 1 && (
        <div className="structure-modes" aria-label="专注时长分布">
          {distributions.map((item) => (
            <button
              type="button"
              aria-pressed={distribution === item.value}
              disabled={busy}
              onClick={() => chooseDistribution(item.value)}
              key={item.value}
            >{item.label}</button>
          ))}
        </div>
      )}

      {totalMinutes > 30 && (
        <div className="structure-rest-control">
          <span>每段休息</span>
          {[5, 10].map((minutes) => (
            <button type="button" aria-pressed={breakMinutes === minutes} disabled={busy} onClick={() => chooseBreak(minutes)} key={minutes}>
              {minutes} 分钟
            </button>
          ))}
          <label>
            <input
              aria-label="自定义休息分钟"
              type="number"
              min="5"
              max="15"
              step="1"
              disabled={busy}
              value={breakMinutes}
              onChange={(event) => chooseBreak(Number(event.target.value))}
            />
            <em>分钟</em>
          </label>
        </div>
      )}

      <details className="structure-ai-disclosure">
        <summary><Sparkles /><span><strong>需要 AI 帮你拆分？</strong><small>按需展开，不影响当前结构。</small></span></summary>
        <div className="structure-ai-planner">
          <textarea
            aria-label="AI 专注结构临时要求"
            rows={2}
            maxLength={1000}
            placeholder="例如：拆成 3 段，前短后长，休息都用 5 分钟"
            disabled={busy}
            value={aiInstructions}
            onChange={(event) => setAiInstructions(event.target.value)}
          />
          <button type="button" className="focus-secondary" disabled={busy} onClick={() => void onPlanAi(aiInstructions.trim() || null)}>
            <Sparkles />{candidate?.source === "ai" ? "重新安排" : "生成候选"}
          </button>
        </div>
      </details>

      <div className="structure-timeline" aria-label="专注结构时间带">
        {timeline.map((segment, index) => (
          <div
            className={segment.segmentType}
            style={{ flexGrow: Math.max(segment.durationMinutes, 5) }}
            title={`${segment.label} ${segment.durationMinutes} 分钟，${segment.start} 至 ${segment.end}`}
            key={`${segment.segmentType}-${index}`}
          >
            <strong>{segment.segmentType === "focus" ? "专注" : "休息"}</strong>
            <span>{segment.durationMinutes}m</span>
            <small>{segment.start}–{segment.end}</small>
            {index < timeline.length - 1 && (
              <button
                className="structure-boundary"
                type="button"
                aria-label={`调整第 ${index + 1} 与第 ${index + 2} 段边界`}
                disabled={busy}
                onPointerDown={(event) => beginBoundaryDrag(event, index)}
                onPointerMove={moveBoundary}
                onPointerUp={endBoundaryDrag}
                onPointerCancel={endBoundaryDrag}
              ><span /></button>
            )}
          </div>
        ))}
      </div>

      <button className="structure-expand" type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
        <ChevronDown />精确编辑
      </button>
      {expanded && (
        <div className="structure-precision">
          {timeline.filter((segment) => segment.segmentType === "focus").map((focus, rowIndex) => {
            const focusIndex = rowIndex * 2;
            const rest = timeline[focusIndex + 1];
            return (
              <div className="structure-stage-row" key={rowIndex}>
                <strong>第 {rowIndex + 1} 段</strong>
                <label>
                  <span>专注</span>
                  <input aria-label={`第 ${rowIndex + 1} 段专注分钟`} type="number" min="30" step="1" value={segments[focusIndex]?.durationMinutes ?? 0} onChange={(event) => updateSegment(focusIndex, Number(event.target.value))} />
                  <em>分钟</em>
                  <small>{focus.start}–{focus.end}</small>
                </label>
                {rest && (
                  <label>
                    <span>休息</span>
                    <input aria-label={`第 ${rowIndex + 1} 段休息分钟`} type="number" min="5" max="15" step="1" value={segments[focusIndex + 1]?.durationMinutes ?? 0} onChange={(event) => updateSegment(focusIndex + 1, Number(event.target.value))} />
                    <em>分钟</em>
                    <small>{rest.start}–{rest.end}</small>
                  </label>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className={`structure-balance ${validation.valid ? "valid" : "invalid"} ${usingActive ? "active" : ""}`} role="status" aria-live="polite">
        {usingActive
          ? <><span className="structure-active-status"><Check />正在使用 {timeRange}</span><span>{validation.used} 分钟 · {focusCount} 段专注</span></>
          : <><span>已安排 {validation.used} 分钟</span><span>{validation.remaining === 0 ? "刚好填满任务时间" : validation.remaining > 0 ? `还剩 ${validation.remaining} 分钟` : `超出 ${Math.abs(validation.remaining)} 分钟`}</span></>}
        {!validation.valid && <strong>{validation.message}</strong>}
        {localError && <strong>{localError}</strong>}
      </div>

      <footer className="structure-actions">
        {active && <button type="button" className="focus-secondary" disabled={busy || usingActive} onClick={restoreActive}><RotateCcw />恢复已确认</button>}
        {candidate && <button type="button" className="focus-secondary danger" disabled={busy} onClick={() => void onDiscard()}><Trash2 />放弃候选</button>}
        <button type="button" className="focus-secondary" disabled={busy || !validation.valid || candidateMatchesDraft || usingActive} onClick={() => void save()}><Save />暂存候选</button>
        <button type="button" className={`primary-button ${usingActive ? "structure-active-button" : ""}`} disabled={busy || !validation.valid || usingActive} onClick={() => void (candidateMatchesDraft ? onConfirm() : onConfirmDraft(segments))}><Check />{usingActive ? "已使用" : "确认并使用"}</button>
      </footer>
      <p className="structure-note">{usingActive ? `当前会按 ${timeRange} 的这份结构执行。` : "确认后按这份结构执行；任务的固定开始和结束时间不会改变。"}</p>
    </section>
  );
}

function validateDraft(segments: FocusSegment[], totalMinutes: number): { valid: boolean; used: number; remaining: number; message: string } {
  const used = segments.reduce((sum, segment) => sum + (Number.isFinite(segment.durationMinutes) ? segment.durationMinutes : 0), 0);
  const remaining = totalMinutes - used;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (index % 2 === 0 && (segment.segmentType !== "focus" || segment.durationMinutes < 25)) {
      return { valid: false, used, remaining, message: `第 ${Math.floor(index / 2) + 1} 段专注不能少于 25 分钟。` };
    }
    if (index % 2 === 1 && (segment.segmentType !== "break" || segment.durationMinutes < 5 || segment.durationMinutes > 15)) {
      return { valid: false, used, remaining, message: `第 ${Math.floor(index / 2) + 1} 段休息必须为 5–15 分钟。` };
    }
  }
  if (segments.length % 2 !== 0 || segments.at(-1)?.segmentType !== "break") {
    return { valid: false, used, remaining, message: "每个专注段后都必须有一段休息。" };
  }
  if (remaining !== 0) return { valid: false, used, remaining, message: "各段总和必须刚好填满任务时间。" };
  return { valid: true, used, remaining, message: "" };
}

function segmentTimeline(startAt: string, timeZone: string, segments: FocusSegment[]) {
  let cursor = new Date(startAt).getTime();
  if (!Number.isFinite(cursor)) {
    return segments.map((segment, index) => ({
      ...segment,
      label: `${segment.segmentType === "focus" ? "专注" : "休息"} ${Math.floor(index / 2) + 1}`,
      start: "--:--",
      end: "--:--"
    }));
  }
  return segments.map((segment, index) => {
    const start = cursor;
    cursor += Math.max(0, segment.durationMinutes) * 60_000;
    return {
      ...segment,
      label: `${segment.segmentType === "focus" ? "专注" : "休息"} ${Math.floor(index / 2) + 1}`,
      start: formatClock(new Date(start).toISOString(), timeZone),
      end: formatClock(new Date(cursor).toISOString(), timeZone)
    };
  });
}

function formatClock(value: string, timeZone: string) {
  let safeZone = "Asia/Shanghai";
  try {
    if (timeZone) {
      new Intl.DateTimeFormat("en-US", { timeZone }).format();
      safeZone = timeZone;
    }
  } catch {
    // Legacy tasks may carry a removed or malformed zone; keep the editor usable.
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "--:--"
    : new Intl.DateTimeFormat("zh-CN", { timeZone: safeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

function inferDistribution(values: number[]): FocusDistribution | "custom" {
  if (values.length <= 1 || Math.max(...values) - Math.min(...values) <= 1) return "equal";
  if (values.every((value, index) => index === 0 || value > values[index - 1]!)) return "increasing";
  if (values.every((value, index) => index === 0 || value < values[index - 1]!)) return "decreasing";
  return "custom";
}

function sameSegments(left: FocusSegment[], right: FocusSegment[]) {
  return left.length === right.length && left.every((segment, index) => segment.segmentType === right[index]?.segmentType && segment.durationMinutes === right[index]?.durationMinutes);
}

function templateError(message: string) {
  if (message.includes("positive multiple") || message.includes("valid date")) return "这项任务的时间范围不符合专注结构规则，请先回到今日页调整排期。";
  if (message.includes("final break") || message.includes("5-15")) return "任务最后必须保留 5–15 分钟休息。";
  if (message.includes("strictly")) return "当前时长无法形成严格递增或递减结构，请增加任务时长或改用等长。";
  if (message.includes("requested number")) return "当前任务时间不足以容纳这些专注段和休息段。";
  return "当前时间块无法生成这个结构。";
}
