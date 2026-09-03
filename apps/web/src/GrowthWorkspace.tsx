import { useCallback, useEffect, useRef, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, Leaf, Sparkles, TrendingUp } from "lucide-react";
import { RadarEditor, numericRadarValues, type RadarKey, type RadarValues } from "./ReviewRadar";

type Tone = "quiet" | "steady" | "bright" | "strained";
type TrendGranularity = "day" | "week" | "month";
type TrendPoint = { startDate: string; endDate: string; focusMinutes: number };
type PointsBreakdown = { execution: number; focus: number; satisfaction: number; review: number };
type Summary = {
  range: { start: string; end: string };
  selectedDate: string;
  days: Array<{ localDate: string; focusMinutes: number; closedTasks: number; completedTasks: number; plannedTasks: number; tone: Tone; points: number; pointsBreakdown: PointsBreakdown }>;
  focusTrend: { granularity: TrendGranularity; points: TrendPoint[] };
  focusMinutes: number;
  plannedTasks: number;
  closedTasks: number;
  completedTasks: number;
  periodGrowthPercent: number;
  satisfaction: { satisfied: number; neutral: number; dissatisfied: number };
  radar: Array<{ key: string; label: string; value: number | null; source: "system" | "user"; sampleDays: number }>;
  currentRadar: Array<{ key: string; label: string; value: number | null; source: "system" | "user" }>;
  currentRadarSaved: boolean;
  garden: { points: number; pointsBreakdown: PointsBreakdown; scoredDays: number; growthPercent: number; growthCap: number; baseGrowthScore: number; executionPercent: number; satisfactionPercent: number; bambooCount: number; treeKind: string; quality: number };
};
type WindowDays = 1 | 7 | 30;
type BambooStage = "shoots" | "mixed" | "grove";

type BambooPoint = { x: number; y: number; oldX: number; oldY: number; restX: number; restY: number };
type BambooLeaf = { segment: number; amount: number; side: -1 | 1; length: number; width: number; branchLength: number; branchAngle: number; phase: number; frequency: number; opacity: number; motion: number; motionVelocity: number };
type BambooShoot = { rootT: number; heightRatio: number; width: number; lean: number; tone: number; phase: number };
type BambooStalk = {
  rootT: number;
  phase: number;
  frequency: number;
  amplitude: number;
  damping: number;
  thickness: number;
  tone: number;
  nodes: BambooPoint[];
  restLengths: number[];
  leaves: BambooLeaf[];
};
type BambooPointer = { x: number; y: number; velocityX: number; velocityY: number; lastX: number; lastY: number; updatedAt: number; gusts: number; inside: boolean };

const BAMBOO_NODE_MIN = 6;
const BAMBOO_NODE_MAX = 8;
const BAMBOO_GUST_HOLD_MS = 900;
const BAMBOO_SETTLE_MS = 1_300;
const FOCUS_QUOTES = [
  { text: "不积跬步，无以至千里；不积小流，无以成江海。", author: "荀子" },
  { text: "业精于勤，荒于嬉；行成于思，毁于随。", author: "韩愈" },
  { text: "志不立，天下无可成之事。", author: "王阳明" },
  { text: "非学无以广才，非志无以成学。", author: "诸葛亮" },
  { text: "古之立大事者，不惟有超世之才，亦必有坚忍不拔之志。", author: "苏轼" },
  { text: "读书有三到，谓心到、眼到、口到。", author: "朱熹" }
] as const;

function seededRandom(seed: number) {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

function bambooRootPoint(width: number, height: number, amount: number) {
  const x = width * amount;
  const y = height - 3 - Math.sin(amount * Math.PI * 1.6) * 2;
  return { x, y };
}

function bambooRoots(count: number, offset = 0) {
  const roots = count + offset >= 4 ? [.49, .61, .72, .83] : count + offset === 2 ? [.64, .81] : count + offset === 1 ? [.73] : [];
  return roots.slice(offset, offset + count);
}

function buildBamboo(width: number, height: number, stage: BambooStage, bambooCount: number) {
  const random = seededRandom(0x5a17c9);
  const stalkCount = stage === "grove" ? bambooCount : stage === "mixed" ? Math.ceil(bambooCount / 2) : 0;
  const roots = bambooRoots(stalkCount);
  const heightRatios = stage === "grove" ? [.68, .89, .76, .96] : [.28, .37];
  const thicknesses = stage === "grove" ? [2.7, 3.5, 3.1, 4] : [2.6, 3.1];
  // Keep the four stalks on one ink family; the visible gradient is vertical,
  // from a washed root to a heavier upper stroke.
  const tones = [.205, .205, .205, .205];
  return roots.map((root, stalkIndex): BambooStalk => {
    const rootT = Math.min(.93, Math.max(.32, root + (random() - .5) * .018));
    const rootPoint = bambooRootPoint(width, height, rootT);
    const nodeCount = stage === "grove"
      ? BAMBOO_NODE_MIN + Math.floor(random() * (BAMBOO_NODE_MAX - BAMBOO_NODE_MIN + 1))
      : 5 + Math.floor(random() * 2);
    const length = Math.min(height - 8, height * heightRatios[stalkIndex]!);
    const lean = width * ([-.025, .026, -.012, .038][stalkIndex] ?? 0);
    const curvePhase = random() * Math.PI * 2;
    const nodes = Array.from({ length: nodeCount }, (_, nodeIndex): BambooPoint => {
      const amount = nodeIndex / (nodeCount - 1);
      const x = rootPoint.x + lean * amount + Math.sin(curvePhase + amount * Math.PI * 1.2) * width * .0045 * amount;
      const y = rootPoint.y - length * amount;
      return { x, y, oldX: x, oldY: y, restX: x, restY: y };
    });
    const restLengths = nodes.slice(1).map((node, index) => Math.hypot(node.x - nodes[index]!.x, node.y - nodes[index]!.y));
    const leafCount = stage === "grove" ? 5 + Math.floor(random() * 3) : 3 + Math.floor(random() * 2);
    const leaves = Array.from({ length: leafCount }, (_, leafIndex): BambooLeaf => {
      const progress = .24 + leafIndex / Math.max(1, leafCount - 1) * .67 + (random() - .5) * .075;
      const scaled = Math.max(.08, Math.min(.96, progress)) * (nodeCount - 1);
      return {
        segment: Math.min(nodeCount - 2, Math.floor(scaled)),
        amount: scaled - Math.floor(scaled),
        side: ((leafIndex + stalkIndex) % 2 === 0 ? -1 : 1),
        length: 14 + random() * 8,
        width: 2.1 + random() * 1.4,
        branchLength: 8 + random() * 10,
        branchAngle: .78 + random() * .36,
        phase: random() * Math.PI * 2,
        frequency: .0011 + random() * .0007,
        opacity: .72 + random() * .28,
        motion: 0,
        motionVelocity: 0
      };
    });
    return {
      rootT,
      phase: random() * Math.PI * 2,
      frequency: .00018 + random() * .00012,
      amplitude: .0012 + random() * .002,
      damping: .962 + random() * .009,
      thickness: thicknesses[stalkIndex]!,
      tone: tones[stalkIndex]!,
      nodes,
      restLengths,
      leaves
    };
  });
}

function buildBambooShoots(stage: BambooStage, bambooCount: number): BambooShoot[] {
  const shootCount = stage === "shoots" ? bambooCount : stage === "mixed" ? Math.floor(bambooCount / 2) : 0;
  const stalkCount = stage === "mixed" ? Math.ceil(bambooCount / 2) : 0;
  const roots = bambooRoots(shootCount, stage === "mixed" ? stalkCount : 0);
  const heights = stage === "shoots" ? [.19, .29, .23, .34] : [.23, .29];
  return roots.map((rootT, index) => ({
    rootT,
    heightRatio: heights[index]!,
    width: 10 + index % 2 * 2.5,
    lean: [-.08, .045, -.035, .07][index] ?? .04,
    tone: .24 + index * .018,
    phase: .7 + index * 1.13
  }));
}

function drawBambooShoot(context: CanvasRenderingContext2D, shoot: BambooShoot, width: number, height: number) {
  const root = bambooRootPoint(width, height, shoot.rootT);
  const shootHeight = height * shoot.heightRatio;
  const tipX = root.x + shoot.lean * shootHeight;
  const tipY = root.y - shootHeight;
  const waistY = root.y - shootHeight * .53;
  const gradient = context.createLinearGradient(root.x, root.y, tipX, tipY);
  gradient.addColorStop(0, `rgba(50,70,57,${(shoot.tone * .42).toFixed(3)})`);
  gradient.addColorStop(.58, `rgba(45,66,53,${(shoot.tone * .72).toFixed(3)})`);
  gradient.addColorStop(1, `rgba(37,55,44,${Math.min(.42, shoot.tone * 1.35).toFixed(3)})`);
  context.save();
  context.beginPath();
  context.moveTo(root.x - shoot.width * .54, root.y);
  context.bezierCurveTo(root.x - shoot.width * .7, waistY, tipX - shoot.width * .26, tipY + shootHeight * .18, tipX, tipY);
  context.bezierCurveTo(tipX + shoot.width * .34, tipY + shootHeight * .2, root.x + shoot.width * .68, waistY, root.x + shoot.width * .54, root.y);
  context.closePath();
  context.fillStyle = gradient;
  context.fill();
  context.strokeStyle = `rgba(37,55,44,${Math.min(.46, shoot.tone * 1.28).toFixed(3)})`;
  context.lineWidth = .9;
  context.stroke();
  for (let layer = 0; layer < 3; layer += 1) {
    const amount = .24 + layer * .22;
    const centerX = root.x + (tipX - root.x) * amount;
    const centerY = root.y + (tipY - root.y) * amount;
    const layerWidth = shoot.width * (1 - amount * .42);
    context.beginPath();
    context.moveTo(centerX - layerWidth * .54, centerY + 4);
    context.quadraticCurveTo(centerX + Math.sin(shoot.phase + layer) * 2, centerY - 8, centerX + layerWidth * .52, centerY - 3);
    context.strokeStyle = `rgba(37,55,44,${(.1 + amount * .2).toFixed(3)})`;
    context.lineWidth = .75;
    context.stroke();
  }
  context.beginPath();
  context.moveTo(tipX, tipY);
  context.quadraticCurveTo(tipX - 7, tipY + 8, tipX - 2, tipY + 17);
  context.strokeStyle = `rgba(37,55,44,${Math.min(.44, shoot.tone * 1.22).toFixed(3)})`;
  context.lineWidth = 1;
  context.stroke();
  context.restore();
}

function drawBambooLeaf(context: CanvasRenderingContext2D, x: number, y: number, angle: number, leaf: BambooLeaf, tone: number, flutter: number) {
  context.save();
  context.translate(x, y);
  context.rotate(angle + flutter);
  context.beginPath();
  context.moveTo(0, 0);
  context.bezierCurveTo(leaf.length * .17, -leaf.width * .64, leaf.length * .64, -leaf.width * 1.08, leaf.length, -leaf.width * .08);
  context.bezierCurveTo(leaf.length * .72, leaf.width * .42, leaf.length * .28, leaf.width * .62, 0, 0);
  context.fillStyle = `rgba(65,84,70,${(tone * leaf.opacity * .66).toFixed(3)})`;
  context.fill();
  context.strokeStyle = `rgba(37,53,44,${(tone * leaf.opacity).toFixed(3)})`;
  context.lineWidth = .62;
  context.stroke();
  context.beginPath();
  context.moveTo(1, 0);
  context.quadraticCurveTo(leaf.length * .52, -leaf.width * .1, leaf.length * .9, 0);
  context.strokeStyle = `rgba(243,240,231,${(tone * .52).toFixed(3)})`;
  context.lineWidth = .42;
  context.stroke();
  context.restore();
}

function bambooInkTone(stalk: BambooStalk, depth: number) {
  return Math.min(.48, stalk.tone * (.52 + depth * 1.22));
}

function bambooInkThickness(stalk: BambooStalk, depth: number) {
  return stalk.thickness * (.8 + depth * .28);
}

function drawBamboo(context: CanvasRenderingContext2D, stalks: BambooStalk[], shoots: BambooShoot[], width: number, height: number, now: number, reveal = 1) {
  context.clearRect(0, 0, width, height);
  context.save();
  context.beginPath();
  context.rect(0, height * (1 - reveal), width, height * reveal);
  context.clip();
  shoots.forEach((shoot) => drawBambooShoot(context, shoot, width, height));
  stalks.forEach((stalk) => {
    const nodes = stalk.nodes;
    for (let index = 0; index < nodes.length - 1; index += 1) {
      const current = nodes[index]!;
      const next = nodes[index + 1]!;
      const depth = index / Math.max(1, nodes.length - 2);
      const tone = bambooInkTone(stalk, depth);
      const thickness = bambooInkThickness(stalk, depth);
      context.beginPath();
      context.moveTo(current.x, current.y);
      context.lineTo(next.x, next.y);
      context.strokeStyle = `rgba(45,66,53,${tone.toFixed(3)})`;
      context.lineWidth = thickness;
      context.lineCap = "butt";
      context.stroke();
      context.beginPath();
      context.moveTo(current.x - thickness * .15, current.y);
      context.lineTo(next.x - thickness * .15, next.y);
      context.strokeStyle = `rgba(243,240,231,${(tone * .5).toFixed(3)})`;
      context.lineWidth = Math.max(.45, thickness * .16);
      context.stroke();
      if (index > 0) {
        const angle = Math.atan2(next.y - current.y, next.x - current.x);
        const normalX = Math.cos(angle + Math.PI / 2) * thickness * .72;
        const normalY = Math.sin(angle + Math.PI / 2) * thickness * .72;
        context.beginPath();
        context.moveTo(current.x - normalX, current.y - normalY);
        context.lineTo(current.x + normalX, current.y + normalY);
        context.strokeStyle = `rgba(34,51,41,${Math.min(.42, tone * 1.28).toFixed(3)})`;
        context.lineWidth = 1;
        context.lineCap = "round";
        context.stroke();
      }
    }
    stalk.leaves.forEach((leaf) => {
      const current = nodes[leaf.segment]!;
      const next = nodes[leaf.segment + 1]!;
      const x = current.x + (next.x - current.x) * leaf.amount;
      const y = current.y + (next.y - current.y) * leaf.amount;
      const leafDepth = (leaf.segment + leaf.amount) / Math.max(1, nodes.length - 2);
      const leafTone = bambooInkTone(stalk, leafDepth);
      const tangent = Math.atan2(next.y - current.y, next.x - current.x);
      const segmentVelocity = (next.x - next.oldX) - (current.x - current.oldX);
      const branchAngle = tangent + leaf.side * leaf.branchAngle;
      const branchX = x + Math.cos(branchAngle) * leaf.branchLength;
      const branchY = y + Math.sin(branchAngle) * leaf.branchLength;
      context.beginPath();
      context.moveTo(x, y);
      context.quadraticCurveTo(
        x + Math.cos(branchAngle) * leaf.branchLength * .48,
        y + Math.sin(branchAngle) * leaf.branchLength * .42,
        branchX,
        branchY
      );
      context.strokeStyle = `rgba(45,66,53,${(leafTone * .78).toFixed(3)})`;
      context.lineWidth = .72;
      context.lineCap = "round";
      context.stroke();
      const flutter = Math.sin(now * leaf.frequency + leaf.phase) * .008 + leaf.motion + Math.max(-.035, Math.min(.035, segmentVelocity * .03));
      drawBambooLeaf(context, branchX, branchY, branchAngle + leaf.side * .16, leaf, leafTone, flutter);
    });
  });
  context.restore();
}

export function growthBambooStage(growthPercent: number): BambooStage {
  if (growthPercent < 33) return "shoots";
  if (growthPercent <= 66) return "mixed";
  return "grove";
}

function GrowthBamboo({ stage, bambooCount }: { stage: BambooStage; bambooCount: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stalksRef = useRef<BambooStalk[]>([]);
  const shootsRef = useRef<BambooShoot[]>([]);
  const pointerRef = useRef<BambooPointer>({ x: -999, y: -999, velocityX: 0, velocityY: 0, lastX: 0, lastY: 0, updatedAt: 0, gusts: 0, inside: false });
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const landscape = canvas.closest(".growth-landscape");
    if (!(landscape instanceof HTMLElement)) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const context = canvas.getContext("2d");
    if (!context) return;
    let cssWidth = 0;
    let cssHeight = 0;
    let frame = 0;
    let last = performance.now();
    let visible = true;
    const revealStart = performance.now();
    const revealDuration = 1_200;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      cssWidth = Math.max(1, rect.width);
      cssHeight = Math.max(1, rect.height);
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(cssWidth * ratio);
      canvas.height = Math.round(cssHeight * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      stalksRef.current = buildBamboo(cssWidth, cssHeight, stage, bambooCount);
      shootsRef.current = buildBambooShoots(stage, bambooCount);
      drawBamboo(context, stalksRef.current, shootsRef.current, cssWidth, cssHeight, performance.now(), reducedMotion ? 1 : 0);
      canvas.dataset.motionEnergy = "0.000";
      canvas.dataset.gustPhase = "idle";
    };

    const constrain = (stalk: BambooStalk, recovery: number) => {
      const nodes = stalk.nodes;
      const root = bambooRootPoint(cssWidth, cssHeight, stalk.rootT);
      nodes[0]!.x = root.x;
      nodes[0]!.y = root.y;
      for (let pass = 0; pass < 5; pass += 1) {
        for (let index = 1; index < nodes.length; index += 1) {
          const parent = nodes[index - 1]!;
          const node = nodes[index]!;
          const dx = node.x - parent.x;
          const dy = node.y - parent.y;
          const distance = Math.max(.001, Math.hypot(dx, dy));
          const correction = (distance - stalk.restLengths[index - 1]!) / distance;
          const depth = index / (nodes.length - 1);
          const parentShare = index === 1 ? 0 : .22 + depth * .18;
          node.x -= dx * correction * (1 - parentShare);
          node.y -= dy * correction * (1 - parentShare);
          if (index > 1) {
            parent.x += dx * correction * parentShare;
            parent.y += dy * correction * parentShare;
          }
        }
        for (let index = 1; index < nodes.length - 1; index += 1) {
          const before = nodes[index - 1]!;
          const node = nodes[index]!;
          const after = nodes[index + 1]!;
          const depth = index / (nodes.length - 1);
          const bending = .115 * (1 - depth * .72);
          node.x += ((before.x + after.x) * .5 - node.x) * bending;
          node.y += ((before.y + after.y) * .5 - node.y) * bending;
          const shape = (.055 + recovery * .035) * (1 - depth) ** 2;
          node.x += (node.restX - node.x) * shape;
          node.y += (node.restY - node.y) * shape;
        }
        nodes[0]!.x = root.x;
        nodes[0]!.y = root.y;
      }
    };

    const tick = (now: number) => {
      frame = 0;
      if (!visible || reducedMotion) return;
      const dt = Math.min(1.6, (now - last) / 16.667);
      last = now;
      const pointer = pointerRef.current;
      const moving = now - pointer.updatedAt < 82;
      const sinceGust = pointer.updatedAt ? now - pointer.updatedAt : Number.POSITIVE_INFINITY;
      const recovery = Math.max(0, Math.min(1, (sinceGust - BAMBOO_GUST_HOLD_MS) / BAMBOO_SETTLE_MS));
      const gustPhase = sinceGust < BAMBOO_GUST_HOLD_MS ? "active" : recovery < 1 ? "settling" : "idle";
      let energy = 0;
      stalksRef.current.forEach((stalk) => {
        const natural = Math.sin(now * stalk.frequency + stalk.phase) + .28 * Math.sin(now * stalk.frequency * .47 + stalk.phase * 1.63);
        for (let index = 1; index < stalk.nodes.length; index += 1) {
          const node = stalk.nodes[index]!;
          const depth = index / (stalk.nodes.length - 1);
          const effectiveDamping = stalk.damping - recovery * .012;
          const velocityX = (node.x - node.oldX) * Math.pow(effectiveDamping, dt);
          const velocityY = (node.y - node.oldY) * Math.pow(effectiveDamping, dt);
          node.oldX = node.x;
          node.oldY = node.y;
          let forceX = natural * stalk.amplitude * depth ** 1.8;
          let forceY = 0;
          if (moving) {
            const distance = Math.hypot(pointer.x - node.x, pointer.y - node.y);
            if (distance < 150) {
              const falloff = (1 - distance / 150) ** 2 * (0.28 + depth * .72);
              forceX += pointer.velocityX * .018 * falloff;
              forceY += pointer.velocityY * .004 * falloff;
            }
          }
          node.x += velocityX + forceX * dt * dt;
          node.y += velocityY + forceY * dt * dt;
          energy += Math.abs(velocityX) + Math.abs(velocityY);
        }
        constrain(stalk, recovery);
        stalk.leaves.forEach((leaf) => {
          const current = stalk.nodes[leaf.segment]!;
          const next = stalk.nodes[leaf.segment + 1]!;
          const currentVelocity = current.x - current.oldX;
          const nextVelocity = next.x - next.oldX;
          const localVelocity = currentVelocity + (nextVelocity - currentVelocity) * leaf.amount;
          const bendVelocity = nextVelocity - currentVelocity;
          const target = Math.max(-.18, Math.min(.18, (localVelocity * .07 + bendVelocity * .11) * leaf.side));
          const spring = (target - leaf.motion) * .16;
          leaf.motionVelocity = (leaf.motionVelocity + spring * dt) * Math.pow(.84, dt);
          leaf.motion += leaf.motionVelocity * dt;
        });
      });
      const reveal = reducedMotion ? 1 : Math.min(1, (now - revealStart) / revealDuration);
      drawBamboo(context, stalksRef.current, shootsRef.current, cssWidth, cssHeight, now, reveal);
      if ((Math.round(now / 16) % 8) === 0) {
        canvas.dataset.motionEnergy = energy.toFixed(3);
        canvas.dataset.gustPhase = gustPhase;
      }
      if (reveal < 1 || stage !== "shoots") frame = requestAnimationFrame(tick);
    };

    const start = () => {
      if (frame || reducedMotion || !visible) return;
      last = performance.now();
      frame = requestAnimationFrame(tick);
    };
    const move = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const now = performance.now();
      const previous = pointerRef.current;
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const elapsed = Math.max(8, now - previous.updatedAt);
      const velocityX = previous.inside ? Math.max(-34, Math.min(34, (x - previous.lastX) / elapsed * 16.667)) : 0;
      const velocityY = previous.inside ? Math.max(-22, Math.min(22, (y - previous.lastY) / elapsed * 16.667)) : 0;
      pointerRef.current = { x, y, velocityX, velocityY, lastX: x, lastY: y, updatedAt: now, gusts: previous.gusts + 1, inside: true };
      canvas.dataset.gustCount = String(pointerRef.current.gusts);
      start();
    };
    const leave = () => {
      pointerRef.current = { ...pointerRef.current, x: -999, y: -999, velocityX: 0, velocityY: 0, inside: false };
    };
    const resizeObserver = new ResizeObserver(resize);
    const intersectionObserver = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? true;
      if (!visible && frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      } else if (visible) start();
    }, { threshold: .02 });
    resizeObserver.observe(canvas);
    intersectionObserver.observe(canvas);
    if (stage !== "shoots") {
      landscape.addEventListener("pointermove", move, { passive: true });
      landscape.addEventListener("pointerleave", leave);
    }
    resize();
    start();
    return () => {
      if (frame) cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      if (stage !== "shoots") {
        landscape.removeEventListener("pointermove", move);
        landscape.removeEventListener("pointerleave", leave);
      }
    };
  }, [bambooCount, stage]);
  const stalkCount = stage === "grove" ? bambooCount : stage === "mixed" ? Math.ceil(bambooCount / 2) : 0;
  const shootCount = stage === "grove" ? 0 : stage === "mixed" ? Math.floor(bambooCount / 2) : bambooCount;
  return <canvas
    ref={canvasRef}
    className="growth-bamboo"
    data-motion-model="pbd-bamboo-wind-field"
    data-growth-stage={stage}
    data-stalk-count={stalkCount}
    data-shoot-count={shootCount}
    data-node-range={`${BAMBOO_NODE_MIN}-${BAMBOO_NODE_MAX}`}
    data-leaf-shape="bezier-lanceolate"
    data-tone-order="bottom-to-top"
    data-leaf-response="greater-than-stalk"
    data-gust-hold-ms={BAMBOO_GUST_HOLD_MS}
    data-gust-phase="idle"
    data-gust-count="0"
    aria-hidden="true"
  />;
}

const API = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3000";
const WINDOW_OPTIONS: Array<{ days: WindowDays; label: string }> = [
  { days: 1, label: "日" },
  { days: 7, label: "周" },
  { days: 30, label: "月" }
];
const CHART_WIDTH = 720;
const CHART_HEIGHT = 220;
const CHART_PADDING = { top: 18, right: 18, bottom: 42, left: 48 };

const localDate = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
async function request<T>(path: string, method = "GET", body?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal
  });
  if (!response.ok) throw new Error((await response.json().catch(() => ({})) as { error?: string }).error ?? "growth_request_failed");
  return response.json() as Promise<T>;
}
const weekday = (value: string) => new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", weekday: "short" }).format(new Date(`${value}T12:00:00Z`)).replace("周", "");
const compactDate = (value: string) => `${Number(value.slice(5, 7))}/${Number(value.slice(8, 10))}`;
const dayLabel = (value: string, windowDays: WindowDays) => windowDays === 7 ? weekday(value) : `${Number(value.slice(5, 7))}/${Number(value.slice(8, 10))}`;
const stateTitle = (windowDays: WindowDays) => windowDays === 1 ? "当天留下的记录" : windowDays === 7 ? "一周留下的色块" : "一个月留下的色块";
function shiftDate(value: string, amount: number) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}
function dateTitle(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "long", day: "numeric", weekday: "short" }).format(new Date(`${value}T12:00:00+08:00`));
}
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
      {days.map((day) => <div key={day.localDate} className={`state-cell ${day.tone}`} title={`${day.localDate} · ${day.focusMinutes} 分钟 · ${day.completedTasks}/${day.plannedTasks} 项完成`}>
        <strong>{dayLabel(day.localDate, windowDays)}</strong><span>{day.focusMinutes}m</span><small>{day.completedTasks}/{day.plannedTasks} 项</small>
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
        aria-label={`${day.localDate}，有效专注 ${day.focusMinutes} 分钟，完成 ${day.completedTasks} 项任务，共计划 ${day.plannedTasks} 项`}
        title={`${day.localDate} · ${day.focusMinutes} 分钟 · ${day.completedTasks}/${day.plannedTasks} 项完成`}
      />)}
    </div>
  </div>;
}

function FeelingTraces({ satisfaction }: { satisfaction: Summary["satisfaction"] }) {
  const values = [
    { key: "satisfied", label: "满意", value: satisfaction.satisfied },
    { key: "neutral", label: "一般", value: satisfaction.neutral },
    { key: "dissatisfied", label: "不满意", value: satisfaction.dissatisfied }
  ] as const;
  const total = values.reduce((sum, item) => sum + item.value, 0);
  return <div className="feeling-traces" data-empty={total === 0 ? "true" : "false"}>
    {values.map((item) => <div className={`feeling-trace ${item.key}`} key={item.key}>
      <i className="feeling-trace-dot" aria-hidden="true" />
      <span>{item.label}</span>
      <span className="feeling-trace-track" aria-hidden="true"><b style={{ width: total > 0 ? `${item.value / total * 100}%` : "0%" }} /></span>
      <strong>{item.value}</strong>
    </div>)}
    {total === 0 ? <small>本周还没有留下主观反馈</small> : null}
  </div>;
}

function GrowthLandscape({ summary, windowDays }: { summary: Summary; windowDays: WindowDays }) {
  const [focusQuoteIndex, setFocusQuoteIndex] = useState(() => Math.floor(Math.random() * FOCUS_QUOTES.length));
  const feelingTotal = summary.satisfaction.satisfied + summary.satisfaction.neutral + summary.satisfaction.dissatisfied;
  const feelingBalance = feelingTotal === 0
    ? 0
    : (summary.satisfaction.satisfied - summary.satisfaction.dissatisfied) / feelingTotal;
  const growthPercent = summary.garden.growthPercent;
  const periodGrowthPercent = windowDays === 1 ? growthPercent : summary.periodGrowthPercent;
  const bambooStage = growthBambooStage(growthPercent);
  const focusQuote = FOCUS_QUOTES[focusQuoteIndex]!;

  useEffect(() => {
    const timer = window.setInterval(() => {
      setFocusQuoteIndex((current) => {
        const offset = 1 + Math.floor(Math.random() * (FOCUS_QUOTES.length - 1));
        return (current + offset) % FOCUS_QUOTES.length;
      });
    }, 12_000);
    return () => window.clearInterval(timer);
  }, []);

  return <section
    className="growth-landscape"
    data-tone={feelingBalance > .18 ? "bright" : feelingBalance < -.18 ? "strained" : feelingTotal ? "steady" : "quiet"}
    aria-label={`成长图景：${summary.garden.treeKind}，${summary.selectedDate} 成长评分 ${growthPercent}/100`}
  >
    <svg className="growth-landscape-ink" viewBox="0 0 1200 460" preserveAspectRatio="none" aria-hidden="true">
      <path className="growth-mountain-back" d="M-30 365C105 330 169 216 291 257C398 293 426 348 546 286C661 226 735 141 848 208C955 271 1011 328 1230 218V460H-30Z" />
      <path className="growth-mountain-front" d="M-30 407C111 368 238 321 360 362C478 401 562 361 665 315C785 263 883 333 987 359C1064 379 1135 347 1230 315V460H-30Z" />
      <path className="growth-river" d="M52 421C245 393 389 424 573 402C752 381 922 418 1148 388" />
    </svg>
    <div className="growth-scene-copy">
      <strong>成</strong>
      <p className="growth-focus-quote">
        <span>“{focusQuote.text}”</span>
        <cite>——{focusQuote.author}</cite>
      </p>
      <p className="growth-scene-description">每一笔都来自任务、专注、感受与主动复盘的真实记录。</p>
    </div>
    <GrowthBamboo stage={bambooStage} bambooCount={summary.garden.bambooCount} />
    <dl className="growth-scene-metrics" id="growth-scene-details">
      <div><dt>有效专注</dt><dd>{summary.focusMinutes}<small>分钟</small></dd></div>
      <div><dt>{windowDays === 1 ? "所选日任务完成" : windowDays === 7 ? "本周任务完成" : "本月任务完成"}</dt><dd>{summary.completedTasks}<small>/{summary.plannedTasks} 项</small></dd></div>
      <div><dt>{windowDays === 1 ? "所选日成长评分" : windowDays === 7 ? "本周成长评分" : "本月成长评分"}</dt><dd>{periodGrowthPercent}<small>/100</small></dd></div>
    </dl>
    <details className="growth-score-detail">
      <summary>查看今日评分</summary>
      <p>完成情况 {summary.garden.executionPercent}% · 满意程度 {summary.garden.satisfactionPercent}% · 任务数量上限 {summary.garden.growthCap} 分</p>
    </details>
  </section>;
}

export function GrowthWorkspace() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [windowDays, setWindowDays] = useState<WindowDays>(7);
  const [selectedDate, setSelectedDate] = useState(localDate);
  const [radarValues, setRadarValues] = useState<RadarValues>(() => numericRadarValues());
  const [radarSaving, setRadarSaving] = useState(false);
  const [radarSaved, setRadarSaved] = useState(false);
  const [radarError, setRadarError] = useState<string | null>(null);

  const loadSummary = useCallback(async (signal?: AbortSignal) => {
    const body = await request<{ summary: Summary }>(`/api/v1/growth/summary?endDate=${selectedDate}&days=${windowDays}`, "GET", undefined, signal);
    if (signal?.aborted) return;
    setSummary(body.summary);
    const radarInput = Object.fromEntries(body.summary.currentRadar.map((metric) => [metric.key, metric.value])) as Partial<Record<RadarKey, number | null>>;
    const hasCurrentSignal = body.summary.currentRadarSaved || body.summary.currentRadar.some((metric) => typeof metric.value === "number" && metric.value > 0);
    setRadarValues(hasCurrentSignal ? numericRadarValues(radarInput) : numericRadarValues());
    setRadarSaved(body.summary.currentRadarSaved);
  }, [selectedDate, windowDays]);

  useEffect(() => {
    const controller = new AbortController();
    setSummary(null);
    setError(null);
    void loadSummary(controller.signal).catch((loadError: unknown) => {
        if (loadError instanceof DOMException && loadError.name === "AbortError") return;
        setError("无法读取成长数据，请确认 API 正在运行。");
      });
    return () => controller.abort();
  }, [loadSummary]);

  async function saveRadar() {
    setRadarSaving(true); setRadarError(null);
    try {
      const review = await request<{ session: { id: string } }>(`/api/v1/reviews/${selectedDate}`);
      await request(`/api/v1/reviews/${review.session.id}/radar`, "POST", radarValues);
      setRadarSaved(true);
      await loadSummary();
    } catch {
      setRadarError("六维回看没有保存，请确认 API 正在运行后重试。");
    } finally { setRadarSaving(false); }
  }

  const rangeDescription = WINDOW_OPTIONS.find((option) => option.days === windowDays)?.label ?? "当前范围";
  const currentDate = localDate();
  const canMoveForward = selectedDate < currentDate;

  return <section className="page growth-page" aria-labelledby="growth-title" aria-busy={!summary && !error}>
    <div className="growth-heading">
      <div><p className="eyebrow">成长花园</p><h1 id="growth-title">生长来自留下的数据。</h1></div>
      <div className="growth-history-tools">
        <div className="growth-date-navigator" role="group" aria-label="历史日期">
          <button type="button" className="icon-button" aria-label="前一天" title="前一天" onClick={() => setSelectedDate((value) => shiftDate(value, -1))}><ChevronLeft /></button>
          <label><CalendarDays /><input type="date" value={selectedDate} max={currentDate} onChange={(event) => { if (event.target.value && event.target.value <= currentDate) setSelectedDate(event.target.value); }} /></label>
          <button type="button" className="icon-button" aria-label="后一天" title="后一天" disabled={!canMoveForward} onClick={() => setSelectedDate((value) => shiftDate(value, 1))}><ChevronRight /></button>
        </div>
        <div className="growth-time-ruler" role="group" aria-label="专注数据范围">
        {WINDOW_OPTIONS.map((option) => <button type="button" key={option.days} aria-pressed={windowDays === option.days} onClick={() => setWindowDays(option.days)}>{option.label}</button>)}
        </div>
      </div>
    </div>
    {!summary && !error ? <div className="growth-loading"><Leaf /><p>正在汇集{rangeDescription}的真实记录。</p></div> : summary ? <>
      <div className="growth-selected-date"><span>{dateTitle(summary.selectedDate)}</span><small>{rangeDescription}数据 · 可切换历史日期</small></div>
      <GrowthLandscape summary={summary} windowDays={windowDays} />
      <details className="growth-ledger">
        <summary><span>查看精确数据与积分账簿</span></summary>
        <section className="growth-score-ledger" aria-label="成长积分构成">
          <div><span>执行进度</span><strong>{summary.garden.pointsBreakdown.execution}/45</strong></div>
          <div><span>有效专注</span><strong>{summary.garden.pointsBreakdown.focus}/25</strong></div>
          <div><span>主观感受</span><strong>{summary.garden.pointsBreakdown.satisfaction}/20</strong></div>
          <div><span>主动复盘</span><strong>{summary.garden.pointsBreakdown.review}/10</strong></div>
          <small>{summary.garden.scoredDays > 0 ? `基于 ${summary.garden.scoredDays} 个有记录日期；任务数量本身不加分。` : "当前范围还没有可计分记录。"}</small>
        </section>
      </details>
      <div className="growth-record-sections">
        <section className="growth-record focus-trend">
          <div className="panel-heading"><div><p className="section-kicker">专注轨迹</p><h2>有效专注时长</h2></div><TrendingUp /></div>
          <FocusTrendChart trend={summary.focusTrend} />
        </section>
        <section className="growth-record">
          <div className="panel-heading"><div><p className="section-kicker">每日状态</p><h2>{stateTitle(windowDays)}</h2></div><Leaf /></div>
          <p className="growth-state-legend">绿色偏满意，黄色为混合或一般，红色偏不满意；灰色表示当天没有主观反馈。</p>
          <StateGrid days={summary.days} windowDays={windowDays} />
        </section>
        <section className="growth-record radar-panel">
          <div className="panel-heading"><div><p className="section-kicker">六维回看</p><h2>把所选日的体验拖成一张图</h2></div><span>{summary.garden.quality}%</span></div>
          <RadarEditor
            values={radarValues}
            onChange={(key, value) => { setRadarSaved(false); setRadarValues((current) => ({ ...current, [key]: value })); }}
            onSave={() => void saveRadar()}
            saving={radarSaving}
            saved={radarSaved}
          />
          {radarError && <p className="growth-radar-error" role="alert">{radarError}</p>}
        </section>
        <section className="growth-record feeling-panel">
          <div className="panel-heading"><div><p className="section-kicker">主观感受</p><h2>专注之后的声音</h2></div><Sparkles /></div>
          <FeelingTraces satisfaction={summary.satisfaction} />
        </section>
      </div>
    </> : null}
    {error && <div className="focus-error" role="alert">{error}</div>}
  </section>;
}
