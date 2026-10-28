import { useEffect, useRef } from "react";

/** Ambient drifting snow — the mobile login's background particles (pale-teal
 *  flakes with an occasional brass one, gentle sway, soft glow), extracted so
 *  the desktop auth shell can share the exact same effect. Renders a
 *  full-bleed absolutely-positioned canvas; the parent must be
 *  position: relative (or fixed). Honors prefers-reduced-motion by rendering
 *  nothing. */
export function AmbientSnow() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;
    let W = 0, H = 0, DPR = 1, last = 0, raf = 0;
    let parts: { x: number; y: number; r: number; sp: number; sw: number; ph: number; a: number; brass: boolean }[] = [];
    const mk = (any: boolean) => ({
      x: Math.random() * W, y: any ? Math.random() * H : -6,
      r: 0.6 + Math.random() * 2.0, sp: 4 + Math.random() * 12, sw: 0.25 + Math.random() * 0.7,
      ph: Math.random() * 6.28, a: 0.05 + Math.random() * 0.2, brass: Math.random() < 0.16,
    });
    const resize = () => {
      DPR = Math.min(window.devicePixelRatio || 1, 2);
      const r = cv.getBoundingClientRect();
      W = r.width || 366; H = r.height || 760;
      cv.width = W * DPR; cv.height = H * DPR;
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    };
    const seed = () => {
      // Density scales with area; the max is generous enough that a desktop
      // viewport doesn't look sparse (a phone lands well under it).
      const n = Math.max(34, Math.min(110, Math.round((W * H) / 9000)));
      parts = Array.from({ length: n }, () => mk(true));
    };
    const frame = (t: number) => {
      const dt = Math.min(0.05, (t - last) / 1000); last = t;
      ctx.clearRect(0, 0, W, H);
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        p.y += p.sp * dt; p.x += Math.sin((t / 1000) * p.sw + p.ph) * 0.2;
        if (p.y > H + 6) parts[i] = mk(false);
        ctx.beginPath(); ctx.globalAlpha = p.a;
        ctx.fillStyle = p.brass ? "#d8a85a" : "#cfe6df";
        ctx.shadowColor = p.brass ? "rgba(216,168,90,.5)" : "rgba(180,220,210,.5)";
        ctx.shadowBlur = p.r * 2.6;
        ctx.arc(p.x, p.y, p.r, 0, 6.2832); ctx.fill();
      }
      ctx.globalAlpha = 1; ctx.shadowBlur = 0;
      raf = requestAnimationFrame(frame);
    };
    resize(); seed();
    const onResize = () => { resize(); seed(); };
    window.addEventListener("resize", onResize);
    last = performance.now();
    raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); window.removeEventListener("resize", onResize); };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}
    />
  );
}
