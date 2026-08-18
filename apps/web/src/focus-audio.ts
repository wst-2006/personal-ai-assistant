export type FocusSoundCue = "flip" | "focusStart" | "breakStart" | "breakEnd" | "focusEnd";
export type FocusSoundPreferences = Record<FocusSoundCue, boolean>;

export const defaultFocusSoundPreferences: FocusSoundPreferences = {
  flip: true,
  focusStart: true,
  breakStart: true,
  breakEnd: true,
  focusEnd: true
};

let context: AudioContext | null = null;

function audioContext() {
  context ??= new AudioContext();
  return context;
}

function tone(ctx: AudioContext, at: number, frequency: number, duration: number, gainValue: number, type: OscillatorType = "sine") {
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, at);
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(gainValue, at + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
  oscillator.connect(gain).connect(ctx.destination);
  oscillator.start(at);
  oscillator.stop(at + duration + 0.03);
}

function paperFlip(ctx: AudioContext, at: number) {
  const length = Math.floor(ctx.sampleRate * 0.15);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let index = 0; index < length; index += 1) {
    const progress = index / length;
    const envelope = Math.sin(Math.PI * progress) * (1 - progress);
    data[index] = (Math.random() * 2 - 1) * envelope * 0.18;
  }
  const source = ctx.createBufferSource();
  const filter = ctx.createBiquadFilter();
  const gain = ctx.createGain();
  filter.type = "bandpass";
  filter.frequency.setValueAtTime(1550, at);
  filter.Q.setValueAtTime(0.7, at);
  gain.gain.setValueAtTime(0.7, at);
  source.buffer = buffer;
  source.connect(filter).connect(gain).connect(ctx.destination);
  source.start(at);
}

export async function playFocusCue(cue: FocusSoundCue, enabled = true): Promise<void> {
  if (!enabled || typeof window === "undefined" || !("AudioContext" in window)) return;
  const ctx = audioContext();
  if (ctx.state === "suspended") await ctx.resume().catch(() => undefined);
  const at = ctx.currentTime + 0.01;
  if (cue === "flip") { paperFlip(ctx, at); return; }
  if (cue === "focusStart") {
    tone(ctx, at, 392, 0.32, 0.055);
    tone(ctx, at + 0.12, 523.25, 0.44, 0.045);
    return;
  }
  if (cue === "breakStart") {
    tone(ctx, at, 440, 0.34, 0.045);
    tone(ctx, at + 0.14, 329.63, 0.48, 0.04);
    return;
  }
  if (cue === "breakEnd") {
    tone(ctx, at, 329.63, 0.28, 0.04);
    tone(ctx, at + 0.1, 440, 0.38, 0.05);
    tone(ctx, at + 0.2, 587.33, 0.46, 0.04);
    return;
  }
  tone(ctx, at, 523.25, 0.42, 0.05);
  tone(ctx, at + 0.14, 659.25, 0.48, 0.05);
  tone(ctx, at + 0.3, 783.99, 0.72, 0.04);
}
