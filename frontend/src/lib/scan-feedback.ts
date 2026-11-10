// A read confirms itself the way a handheld scanner does: a buzz and a short
// tone, so the storekeeper can keep their eyes on the pile instead of the
// screen. Both are best-effort — iOS Safari has no navigator.vibrate and an
// AudioContext can be refused — and neither may ever throw into the scan loop.
// After Hookka's ScanSheet (hookka-erp-testing#528).

type AudioCtor = typeof AudioContext;
let audio: AudioContext | null = null;

async function wake(ctx: AudioContext): Promise<void> {
  try {
    await ctx.resume();
  } catch {
    /* a refused resume only loses the tone; the buzz still confirms the read */
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
    /* not supported here */
  }
  try {
    beep();
  } catch {
    /* audio refused here */
  }
}
