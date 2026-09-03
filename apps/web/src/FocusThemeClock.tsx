import { useEffect, useRef, useState } from "react";
import type { FocusTheme } from "@personal-ai/domain/user-profile";

type FocusThemeClockProps = {
  theme: FocusTheme;
  value: string;
  compact?: boolean;
};

const flipAnimationDurationMs = 520;

const lcdSegmentOrder = ["a", "b", "c", "d", "e", "f", "g"] as const;
type LcdSegment = typeof lcdSegmentOrder[number];

const lcdSegmentShapes: Record<LcdSegment, string> = {
  a: "7,3 35,3 39,7 35,11 7,11 3,7",
  b: "37,9 41,13 41,30 37,34 34,30 34,13",
  c: "37,37 41,41 41,58 37,62 34,58 34,41",
  d: "7,60 35,60 39,64 35,68 7,68 3,64",
  e: "3,37 7,41 7,58 3,62 0,58 0,41",
  f: "3,9 7,13 7,30 3,34 0,30 0,13",
  g: "7,32 35,32 39,36 35,40 7,40 3,36",
};

const lcdDigitSegments: Record<string, readonly LcdSegment[]> = {
  "0": ["a", "b", "c", "d", "e", "f"],
  "1": ["b", "c"],
  "2": ["a", "b", "g", "e", "d"],
  "3": ["a", "b", "g", "c", "d"],
  "4": ["f", "g", "b", "c"],
  "5": ["a", "f", "g", "c", "d"],
  "6": ["a", "f", "g", "e", "c", "d"],
  "7": ["a", "b", "c"],
  "8": lcdSegmentOrder,
  "9": ["a", "b", "c", "d", "f", "g"],
};

function LcdClock({ value, compact }: Pick<FocusThemeClockProps, "value" | "compact">) {
  let cursor = 0;
  const marks = value.split("").map((character, index) => {
    const width = character === ":" ? 18 : 46;
    const x = cursor;
    cursor += width;
    if (character === ":") {
      return <g className="lcd-colon" transform={`translate(${x} 0)`} key={`${character}-${index}`}>
        <circle cx="9" cy="28" r="2.7" />
        <circle cx="9" cy="45" r="2.7" />
      </g>;
    }
    const activeSegments = new Set(lcdDigitSegments[character] ?? []);
    return <g className="lcd-digit" transform={`translate(${x + 2} 0)`} key={`${character}-${index}`} aria-hidden="true">
      {lcdSegmentOrder.map((segment) => <polygon
        className={`lcd-segment ${activeSegments.has(segment) ? "active" : "inactive"}`}
        data-segment={segment}
        points={lcdSegmentShapes[segment]}
        key={segment}
      />)}
    </g>;
  });
  return <svg
    className={`theme-clock lcd-clock ${compact ? "compact" : ""}`}
    viewBox={`-3 0 ${cursor + 6} 71`}
    preserveAspectRatio="xMidYMid meet"
    role="img"
    aria-label={value}
  >
    {marks}
  </svg>;
}

function FlipDigit({ value }: { value: string }) {
  const [current, setCurrent] = useState(value);
  const [previous, setPrevious] = useState(value);
  const [flipping, setFlipping] = useState(false);
  const currentRef = useRef(value);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (value === currentRef.current) return;
    const oldValue = currentRef.current;
    currentRef.current = value;
    setPrevious(oldValue);
    setCurrent(value);
    setFlipping(true);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      setFlipping(false);
      timerRef.current = null;
    }, flipAnimationDurationMs);
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, [value]);

  return <i className={`flip-digit ${flipping ? "is-flipping" : ""}`} aria-hidden="true">
    <span className="flip-digit-half flip-digit-half-top"><b>{flipping ? previous : current}</b></span>
    <span className="flip-digit-half flip-digit-half-bottom"><b>{current}</b></span>
    {flipping && <>
      <span className="flip-digit-flap" aria-hidden="true">
        <span className="flip-digit-flap-face flip-digit-flap-front"><b>{previous}</b></span>
        <span className="flip-digit-flap-face flip-digit-flap-back"><b>{current}</b></span>
      </span>
    </>}
  </i>;
}

function FlipClock({ value, compact }: Pick<FocusThemeClockProps, "value" | "compact">) {
  return <span className={`theme-clock flip-clock ${compact ? "compact" : ""}`} aria-label={value}>
    {value.split("").map((character, index) => character === ":"
      ? <i className="flip-colon" aria-hidden="true" key={`colon-${index}`}>:</i>
      : <FlipDigit value={character} key={`digit-${index}`} />)}
  </span>;
}

function NixieClock({ value, compact }: Pick<FocusThemeClockProps, "value" | "compact">) {
  return <span className={`theme-clock nixie-clock ${compact ? "compact" : ""}`} aria-label={value}>
    {value.split("").map((character, index) => character === ":"
      ? <i className="nixie-colon" aria-hidden="true" key={`colon-${index}`} />
      : <i className="nixie-tube" aria-hidden="true" key={`${character}-${index}`}><b>{character}</b></i>)}
  </span>;
}

export function FocusThemeClock({ theme, value, compact = false }: FocusThemeClockProps) {
  if (theme === "ink") return <LcdClock value={value} compact={compact} />;
  if (theme === "flip") return <FlipClock value={value} compact={compact} />;
  if (theme === "nixie") return <NixieClock value={value} compact={compact} />;
  return <span className={`theme-clock text-theme-clock ${theme}-clock ${compact ? "compact" : ""}`} aria-label={value}>{value}</span>;
}
