
type AudioCtor = typeof AudioContext;
let audio: AudioContext | null = null;

async function wake(ctx: AudioContext): Promise<void> {
  try {
    await ctx.resume();
  } catch {
  }
}

function beep(): void {
  const Ctor: AudioCtor | undefined =
    (window as unknown as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor }).AudioContext
    ?? (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext;
  if (!Ctor) return;
  audio ??= new Ctor();
  const ctx = audio;
  if (ctx.state === 'suspended') void wake(ctx);
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = 1760;
  gain.gain.setValueAtTime(0.15, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.09);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + 0.1);
}

/** Best-effort buzz and tone. Houzs has no sound setting to respect yet. */
export function scanHitFeedback(): void {
  try {
    if (typeof navigator.vibrate === 'function') navigator.vibrate(60);
  } catch {
  }
  try {
    beep();
  } catch {
  }
}
