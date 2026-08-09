import { useEffect, useMemo, useState } from "react";

type SeasonalPlantKind = "orchid" | "lotus" | "chrysanthemum" | "plum";

type SeasonalMotif = {
  kind: SeasonalPlantKind;
  season: string;
  term: string;
  plant: string;
  note: string;
};

const solarTerms = [
  [1, 5, "小寒"], [1, 20, "大寒"], [2, 4, "立春"], [2, 19, "雨水"],
  [3, 5, "惊蛰"], [3, 20, "春分"], [4, 5, "清明"], [4, 20, "谷雨"],
  [5, 5, "立夏"], [5, 21, "小满"], [6, 6, "芒种"], [6, 21, "夏至"],
  [7, 7, "小暑"], [7, 23, "大暑"], [8, 7, "立秋"], [8, 23, "处暑"],
  [9, 7, "白露"], [9, 23, "秋分"], [10, 8, "寒露"], [10, 23, "霜降"],
  [11, 7, "立冬"], [11, 22, "小雪"], [12, 7, "大雪"], [12, 22, "冬至"],
] as const;

function dateParts(value?: string) {
  if (value && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [, month, day] = value.split("-").map(Number);
    return { month, day };
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    month: "numeric",
    day: "numeric",
  }).formatToParts(new Date());
  return {
    month: Number(parts.find((part) => part.type === "month")?.value ?? 1),
    day: Number(parts.find((part) => part.type === "day")?.value ?? 1),
  };
}

function resolveSeasonalMotif(value?: string): SeasonalMotif {
  const { month, day } = dateParts(value);
  const numericDate = month * 100 + day;
  let termIndex = solarTerms.length - 1;
  for (let index = 0; index < solarTerms.length; index += 1) {
    const [termMonth, termDay] = solarTerms[index];
    if (numericDate >= termMonth * 100 + termDay) termIndex = index;
  }
  const term = solarTerms[termIndex][2];

  if (termIndex >= 2 && termIndex <= 7) {
    return { kind: "orchid", season: "春", term, plant: "兰", note: "幽香入纸" };
  }
  if (termIndex >= 8 && termIndex <= 13) {
    return { kind: "lotus", season: "夏", term, plant: "荷", note: "清影生凉" };
  }
  if (termIndex >= 14 && termIndex <= 19) {
    return { kind: "chrysanthemum", season: "秋", term, plant: "菊", note: "疏篱有秋" };
  }
  return { kind: "plum", season: "冬", term, plant: "梅", note: "暗香破寒" };
}

function PlantDrawing({ kind }: { kind: SeasonalPlantKind }) {
  if (kind === "orchid") {
    return <g className="seasonal-plant-lines seasonal-orchid">
      <path d="M176 211C161 161 157 111 164 49M158 210C145 166 131 130 102 91M166 205C177 162 190 122 219 91M153 202C128 176 105 163 72 158M173 200C198 178 217 164 239 158" />
      <path className="seasonal-leaf-soft" d="M164 194C148 154 143 108 157 65M165 186C178 151 194 126 217 108M151 190C129 166 107 151 83 145" />
      <path className="seasonal-flower" d="M158 61C145 47 146 34 160 39C166 23 178 26 176 43C190 36 198 46 186 57C194 70 181 77 171 66C164 78 151 74 158 61Z" />
      <circle cx="169" cy="56" r="3.5" />
    </g>;
  }
  if (kind === "lotus") {
    return <g className="seasonal-plant-lines seasonal-lotus">
      <path d="M165 215C163 178 162 143 166 103M116 215C123 176 124 146 117 123M205 214C199 176 202 151 218 129" />
      <path className="seasonal-leaf-soft" d="M54 138C78 110 112 108 137 134C112 155 80 156 54 138ZM178 147C198 125 226 123 247 141C228 158 202 161 178 147Z" />
      <path className="seasonal-flower" d="M166 104C139 92 130 71 146 46C159 53 166 66 166 84C170 62 181 48 198 43C206 69 194 92 166 104ZM166 100C151 87 151 66 164 48C179 65 180 87 166 100Z" />
      <path className="seasonal-water-line" d="M46 221C91 214 137 224 181 218C212 214 235 218 255 222" />
    </g>;
  }
  if (kind === "chrysanthemum") {
    return <g className="seasonal-plant-lines seasonal-chrysanthemum">
      <path className="seasonal-chrysanthemum-inkmass seasonal-chrysanthemum-inkmass-left" d="M160 177C145 157 123 157 106 174C113 197 141 205 160 177Z" />
      <path className="seasonal-chrysanthemum-inkmass seasonal-chrysanthemum-inkmass-right" d="M178 158C194 137 218 139 229 160C214 178 191 176 178 158Z" />
      <path className="seasonal-chrysanthemum-inkmass seasonal-chrysanthemum-inkmass-high" d="M151 145C134 130 113 136 106 154C120 167 141 163 151 145Z" />
      <path d="M172 218C171 177 170 138 171 95M169 178C147 155 128 139 99 128M173 161C194 143 211 132 234 126M159 149C143 130 132 117 116 104" />
      <path className="seasonal-leaf-soft" d="M160 177C136 161 117 170 107 194C132 198 151 191 160 177ZM178 157C196 138 215 142 226 162C205 170 189 167 178 157ZM151 145C132 133 116 138 108 154C126 159 141 155 151 145Z" />
      <path className="seasonal-flower-wash" d="M138 86C138 56 156 35 182 38C210 41 220 65 209 92C199 117 164 126 145 107C139 101 137 94 138 86Z" />
      <g className="seasonal-flower seasonal-chrysanthemum-bloom">
        <path d="M173 87C158 74 153 58 162 52C171 59 174 72 173 87" />
        <path d="M173 87C169 67 174 48 184 47C191 58 184 75 173 87" />
        <path d="M174 87C184 68 198 57 206 63C207 75 191 84 174 87" />
        <path d="M174 88C195 80 210 83 211 93C202 102 187 97 174 88" />
        <path d="M173 89C192 100 197 113 188 119C176 115 174 101 173 89" />
        <path d="M171 89C177 108 171 122 161 120C153 111 161 98 171 89" />
        <path d="M170 88C151 105 137 105 134 95C141 83 157 84 170 88" />
        <path d="M170 86C149 82 138 71 144 62C156 60 166 72 170 86" />
        <path className="seasonal-petal-inner" d="M172 87C165 79 165 70 172 69C179 74 177 82 172 87ZM173 87C181 80 190 80 191 87C186 94 179 91 173 87ZM172 89C179 95 178 103 171 104C164 99 167 93 172 89ZM170 88C162 93 154 90 155 83C162 78 167 83 170 88Z" />
        <circle cx="172" cy="87" r="3.2" />
      </g>
      <path className="seasonal-side-flower-wash" d="M92 103C91 86 101 74 116 76C131 78 140 92 134 107C127 123 106 126 96 115C93 112 92 108 92 103Z" />
      <g className="seasonal-flower seasonal-side-bloom">
        <path d="M113 105C104 96 104 87 111 83C119 87 120 97 113 105M114 105C121 95 130 92 134 98C132 107 123 109 114 105M112 106C104 112 96 109 97 102C103 97 108 101 112 106M113 104C110 94 115 86 122 89C126 97 120 103 113 104M112 106C116 115 109 121 103 117C101 111 106 107 112 106" />
        <circle cx="113" cy="104" r="2.2" />
      </g>
      <path className="seasonal-chrysanthemum-bud" d="M230 126C222 117 224 108 232 107C241 112 240 121 230 126ZM100 128C93 118 96 110 104 111C111 117 108 125 100 128Z" />
      <path className="seasonal-falling-petal" d="M222 73C231 66 238 70 233 79C228 86 222 83 222 73Z" />
    </g>;
  }
  return <g className="seasonal-plant-lines seasonal-plum">
    <path className="seasonal-branch" d="M48 198C91 180 116 151 136 119C157 85 183 65 229 51M121 141C99 121 84 104 75 82M151 100C139 77 136 61 143 42M180 72C195 81 208 84 229 81" />
    <g className="seasonal-flower seasonal-plum-bloom">
      <path d="M136 118C126 108 129 98 141 101C141 88 151 85 158 96C166 86 177 91 174 104C187 104 190 115 178 121C187 132 177 141 166 133C159 145 147 141 149 128C136 133 128 126 136 118Z" />
      <path d="M221 51C213 42 216 34 226 36C226 25 236 23 241 33C249 25 258 30 254 40C266 42 266 52 256 57C263 67 253 74 245 66C238 75 229 70 231 60C220 64 214 58 221 51Z" />
      <path d="M70 83C62 74 66 65 76 68C76 56 86 54 91 64C100 56 109 62 105 72C116 73 118 83 107 88C114 98 104 105 96 96C89 106 79 101 82 91C70 95 64 89 70 83Z" />
    </g>
  </g>;
}

export function SeasonalPlant({ date }: { date?: string }) {
  const motif = useMemo(() => resolveSeasonalMotif(date), [date]);
  return <aside className={`seasonal-corner seasonal-${motif.kind}`} aria-label={`${motif.term}，${motif.season}季${motif.plant}花水墨`}>
    <svg viewBox="0 0 270 235" role="img" aria-hidden="true">
      <path className="seasonal-wash" d="M77 35C118 4 196 7 234 49C269 88 256 163 210 200C163 238 75 226 37 179C2 136 29 70 77 35Z" />
      <path className="seasonal-mist" d="M23 196C77 184 115 201 163 193C202 186 235 190 267 203" />
      <PlantDrawing kind={motif.kind} />
    </svg>
    <div className="seasonal-caption" aria-hidden="true"><span>{motif.term}</span><strong>{motif.plant}</strong><small>{motif.note}</small></div>
  </aside>;
}

export function InitialInkLoadingScreen() {
  const [progress, setProgress] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const duration = reducedMotion ? 260 : 2_150;
    const fadeDuration = reducedMotion ? 40 : 430;
    const startedAt = performance.now();
    let animationFrame = 0;
    let removeTimer = 0;

    const update = (now: number) => {
      const ratio = Math.min(1, (now - startedAt) / duration);
      const eased = 1 - Math.pow(1 - ratio, 2.4);
      setProgress(Math.round(eased * 100));
      if (ratio < 1) {
        animationFrame = window.requestAnimationFrame(update);
        return;
      }
      setLeaving(true);
      removeTimer = window.setTimeout(() => setVisible(false), fadeDuration);
    };

    animationFrame = window.requestAnimationFrame(update);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.clearTimeout(removeTimer);
    };
  }, []);

  if (!visible) return null;
  const progressRatio = progress / 100;
  const sunOffset = Math.round((1 - progressRatio) * 96);
  const sunOpacity = Math.min(1, .18 + progressRatio * 1.05);
  return <section className={`ink-loading-screen ${leaving ? "is-leaving" : ""}`} aria-label="正在加载个人 AI 助手" aria-live="polite">
    <svg className="ink-loading-landscape" viewBox="0 0 1200 720" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <filter id="loading-ink-soften" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="18" /></filter>
        <filter id="loading-mist-soften" x="-30%" y="-60%" width="160%" height="220%"><feGaussianBlur stdDeviation="11" /></filter>
        <clipPath id="loading-sun-horizon">
          <path d="M0 0H1200V300C899 292 821 277 760 290C721 299 700 314 674 296C648 309 629 291 594 283C548 272 510 286 465 303C407 324 339 311 0 302Z" />
        </clipPath>
      </defs>
      <g className="loading-ink-washes" filter="url(#loading-ink-soften)">
        <ellipse cx="227" cy="349" rx="245" ry="172" />
        <ellipse cx="994" cy="327" rx="254" ry="178" />
        <ellipse cx="609" cy="626" rx="362" ry="76" />
      </g>
      <g className="loading-distant-mountains">
        <path d="M-64 493C80 430 148 276 278 316C365 343 394 423 474 394C552 365 570 211 685 248C773 277 815 414 912 376C1016 336 1071 188 1272 237L1272 532L-64 532Z" />
        <path d="M17 530C136 483 216 380 321 411C393 432 447 493 525 454C614 409 644 322 740 348C844 377 891 480 1009 429C1095 392 1149 341 1244 337L1244 562L17 562Z" />
      </g>
      <g clipPath="url(#loading-sun-horizon)">
        <g className="loading-rising-sun" style={{ transform: `translateY(${sunOffset}px)`, opacity: sunOpacity }}>
          <circle className="loading-sun-glow" cx="674" cy="244" r="63" />
          <circle className="loading-sun-disc" cx="674" cy="244" r="39" />
        </g>
      </g>
      <image className="loading-waterfall-art" href="/art/cold-waterfall-ink-public-domain.png" x="292" y="28" width="636" height="702" preserveAspectRatio="xMidYMid meet" />
      <g className="loading-water-glints">
        <path d="M630 440C620 478 621 520 613 558M650 427C643 473 647 520 640 574M670 445C662 489 667 531 660 563" />
      </g>
      <g className="loading-water-spray" filter="url(#loading-mist-soften)">
        <ellipse cx="628" cy="649" rx="132" ry="26" />
        <ellipse cx="680" cy="641" rx="92" ry="20" />
      </g>
      <g className="loading-river-lines">
        <path d="M466 659C391 659 330 671 278 694" />
        <path d="M704 659C781 659 849 670 917 698" />
      </g>
    </svg>
    <div className="ink-loading-center">
      <span className="ink-loading-seal" aria-hidden="true">序</span>
      <div><strong>山水初醒</strong><small>正在铺开今日纸页</small></div>
      <progress max="100" value={progress} aria-valuetext={`加载 ${progress}%`} />
      <span className="ink-loading-percent">{String(progress).padStart(2, "0")}</span>
    </div>
  </section>;
}
