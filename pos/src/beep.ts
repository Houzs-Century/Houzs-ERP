/* A short beep on a successful scan (Printer & Scanner setting). WebAudio,
 * no file; silent where audio is blocked. */
let ctx: AudioContext | null = null;

export function beep(kind: "ok" | "error" = "ok"): void {
  try {
    ctx ??= new AudioContext();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "square";
    o.frequency.value = kind === "ok" ? 1760 : 330;
    g.gain.value = 0.08;
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + (kind === "ok" ? 0.08 : 0.25));
  } catch {
    /* no audio */
  }
}
