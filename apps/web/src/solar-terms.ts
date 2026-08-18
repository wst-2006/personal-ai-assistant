export type SeasonalPlantKind = "orchid" | "lotus" | "chrysanthemum" | "plum";
export type SeasonalAccentKind = "frost" | "bud" | "rain" | "thunder" | "balance" | "breeze" | "grain" | "sun" | "dew" | "snow";

export type SolarTermMotif = {
  term: string;
  slug: string;
  targetLongitude: number;
  approximateMonth: number;
  approximateDay: number;
  kind: SeasonalPlantKind;
  season: "春" | "夏" | "秋" | "冬";
  seasonPhase: 0 | 1 | 2 | 3 | 4 | 5;
  plant: "兰" | "荷" | "菊" | "梅";
  note: string;
  accent: SeasonalAccentKind;
};

export type ResolvedSolarTerm = SolarTermMotif & {
  index: number;
  start: Date;
  nextStart: Date;
};

export const SOLAR_TERM_MOTIFS: readonly SolarTermMotif[] = [
  { term: "小寒", slug: "xiaohan", targetLongitude: 285, approximateMonth: 1, approximateDay: 5, kind: "plum", season: "冬", seasonPhase: 4, plant: "梅", note: "疏影初寒", accent: "frost" },
  { term: "大寒", slug: "dahan", targetLongitude: 300, approximateMonth: 1, approximateDay: 20, kind: "plum", season: "冬", seasonPhase: 5, plant: "梅", note: "寒尽待春", accent: "frost" },
  { term: "立春", slug: "lichun", targetLongitude: 315, approximateMonth: 2, approximateDay: 4, kind: "orchid", season: "春", seasonPhase: 0, plant: "兰", note: "新芽启岁", accent: "bud" },
  { term: "雨水", slug: "yushui", targetLongitude: 330, approximateMonth: 2, approximateDay: 19, kind: "orchid", season: "春", seasonPhase: 1, plant: "兰", note: "润物无声", accent: "rain" },
  { term: "惊蛰", slug: "jingzhe", targetLongitude: 345, approximateMonth: 3, approximateDay: 5, kind: "orchid", season: "春", seasonPhase: 2, plant: "兰", note: "微雷醒草", accent: "thunder" },
  { term: "春分", slug: "chunfen", targetLongitude: 0, approximateMonth: 3, approximateDay: 20, kind: "orchid", season: "春", seasonPhase: 3, plant: "兰", note: "昼夜均平", accent: "balance" },
  { term: "清明", slug: "qingming", targetLongitude: 15, approximateMonth: 4, approximateDay: 5, kind: "orchid", season: "春", seasonPhase: 4, plant: "兰", note: "清气入纸", accent: "breeze" },
  { term: "谷雨", slug: "guyu", targetLongitude: 30, approximateMonth: 4, approximateDay: 20, kind: "orchid", season: "春", seasonPhase: 5, plant: "兰", note: "雨生百谷", accent: "rain" },
  { term: "立夏", slug: "lixia", targetLongitude: 45, approximateMonth: 5, approximateDay: 5, kind: "lotus", season: "夏", seasonPhase: 0, plant: "荷", note: "新荷初展", accent: "bud" },
  { term: "小满", slug: "xiaoman", targetLongitude: 60, approximateMonth: 5, approximateDay: 21, kind: "lotus", season: "夏", seasonPhase: 1, plant: "荷", note: "物至小满", accent: "grain" },
  { term: "芒种", slug: "mangzhong", targetLongitude: 75, approximateMonth: 6, approximateDay: 5, kind: "lotus", season: "夏", seasonPhase: 2, plant: "荷", note: "有种有收", accent: "grain" },
  { term: "夏至", slug: "xiazhi", targetLongitude: 90, approximateMonth: 6, approximateDay: 21, kind: "lotus", season: "夏", seasonPhase: 3, plant: "荷", note: "日长风静", accent: "sun" },
  { term: "小暑", slug: "xiaoshu", targetLongitude: 105, approximateMonth: 7, approximateDay: 7, kind: "lotus", season: "夏", seasonPhase: 4, plant: "荷", note: "荷风送凉", accent: "breeze" },
  { term: "大暑", slug: "dashu", targetLongitude: 120, approximateMonth: 7, approximateDay: 23, kind: "lotus", season: "夏", seasonPhase: 5, plant: "荷", note: "浓荫避暑", accent: "sun" },
  { term: "立秋", slug: "liqiu", targetLongitude: 135, approximateMonth: 8, approximateDay: 7, kind: "chrysanthemum", season: "秋", seasonPhase: 0, plant: "菊", note: "疏篱有秋", accent: "grain" },
  { term: "处暑", slug: "chushu", targetLongitude: 150, approximateMonth: 8, approximateDay: 23, kind: "chrysanthemum", season: "秋", seasonPhase: 1, plant: "菊", note: "暑气渐收", accent: "breeze" },
  { term: "白露", slug: "bailu", targetLongitude: 165, approximateMonth: 9, approximateDay: 7, kind: "chrysanthemum", season: "秋", seasonPhase: 2, plant: "菊", note: "露凝草木", accent: "dew" },
  { term: "秋分", slug: "qiufen", targetLongitude: 180, approximateMonth: 9, approximateDay: 23, kind: "chrysanthemum", season: "秋", seasonPhase: 3, plant: "菊", note: "平分秋色", accent: "balance" },
  { term: "寒露", slug: "hanlu", targetLongitude: 195, approximateMonth: 10, approximateDay: 8, kind: "chrysanthemum", season: "秋", seasonPhase: 4, plant: "菊", note: "寒露入枝", accent: "dew" },
  { term: "霜降", slug: "shuangjiang", targetLongitude: 210, approximateMonth: 10, approximateDay: 23, kind: "chrysanthemum", season: "秋", seasonPhase: 5, plant: "菊", note: "木叶含霜", accent: "frost" },
  { term: "立冬", slug: "lidong", targetLongitude: 225, approximateMonth: 11, approximateDay: 7, kind: "plum", season: "冬", seasonPhase: 0, plant: "梅", note: "万物收藏", accent: "breeze" },
  { term: "小雪", slug: "xiaoxue", targetLongitude: 240, approximateMonth: 11, approximateDay: 22, kind: "plum", season: "冬", seasonPhase: 1, plant: "梅", note: "初雪入砚", accent: "snow" },
  { term: "大雪", slug: "daxue", targetLongitude: 255, approximateMonth: 12, approximateDay: 7, kind: "plum", season: "冬", seasonPhase: 2, plant: "梅", note: "雪意深白", accent: "snow" },
  { term: "冬至", slug: "dongzhi", targetLongitude: 270, approximateMonth: 12, approximateDay: 21, kind: "plum", season: "冬", seasonPhase: 3, plant: "梅", note: "一阳初生", accent: "sun" },
] as const;

const DAY_MS = 86_400_000;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1_000;

function normalizeDegrees(value: number) {
  return ((value % 360) + 360) % 360;
}

function signedAngle(value: number) {
  return ((value + 180) % 360 + 360) % 360 - 180;
}

function apparentSolarLongitude(timestamp: number) {
  const julianDate = timestamp / DAY_MS + 2_440_587.5;
  const centuries = (julianDate - 2_451_545) / 36_525;
  const meanLongitude = normalizeDegrees(280.46646 + centuries * (36_000.76983 + centuries * .0003032));
  const meanAnomaly = normalizeDegrees(357.52911 + centuries * (35_999.05029 - .0001537 * centuries));
  const anomalyRadians = meanAnomaly * Math.PI / 180;
  const equationOfCenter = Math.sin(anomalyRadians) * (1.914602 - centuries * (.004817 + .000014 * centuries))
    + Math.sin(2 * anomalyRadians) * (.019993 - .000101 * centuries)
    + Math.sin(3 * anomalyRadians) * .000289;
  const omega = (125.04 - 1_934.136 * centuries) * Math.PI / 180;
  return normalizeDegrees(meanLongitude + equationOfCenter - .00569 - .00478 * Math.sin(omega));
}

export function solarTermStart(year: number, index: number) {
  const motif = SOLAR_TERM_MOTIFS[index];
  if (!motif) throw new RangeError(`Unknown solar term index: ${index}`);
  let lower = Date.UTC(year, motif.approximateMonth - 1, motif.approximateDay - 4, 12);
  let upper = Date.UTC(year, motif.approximateMonth - 1, motif.approximateDay + 4, 12);
  for (let iteration = 0; iteration < 56; iteration += 1) {
    const middle = (lower + upper) / 2;
    if (signedAngle(apparentSolarLongitude(middle) - motif.targetLongitude) < 0) lower = middle;
    else upper = middle;
  }
  return new Date((lower + upper) / 2);
}

export function shanghaiDateKey(value: Date) {
  const shifted = new Date(value.getTime() + SHANGHAI_OFFSET_MS);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
}

function shanghaiYear(value: Date) {
  return new Date(value.getTime() + SHANGHAI_OFFSET_MS).getUTCFullYear();
}

function resolveMoment(value?: Date | string) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-").map(Number);
    return new Date(Date.UTC(year!, month! - 1, day!, 15, 59, 59, 999));
  }
  return new Date();
}

export function resolveSolarTerm(value?: Date | string): ResolvedSolarTerm {
  const moment = resolveMoment(value);
  const year = shanghaiYear(moment);
  const entries = [
    { year: year - 1, index: SOLAR_TERM_MOTIFS.length - 1, start: solarTermStart(year - 1, SOLAR_TERM_MOTIFS.length - 1) },
    ...SOLAR_TERM_MOTIFS.map((_, index) => ({ year, index, start: solarTermStart(year, index) })),
    { year: year + 1, index: 0, start: solarTermStart(year + 1, 0) },
  ];
  let active = entries[0]!;
  let next = entries[1]!;
  for (let index = 1; index < entries.length; index += 1) {
    const candidate = entries[index]!;
    if (candidate.start.getTime() <= moment.getTime()) {
      active = candidate;
      next = entries[index + 1] ?? candidate;
      continue;
    }
    next = candidate;
    break;
  }
  return { ...SOLAR_TERM_MOTIFS[active.index]!, index: active.index, start: active.start, nextStart: next.start };
}
