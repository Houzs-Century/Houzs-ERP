/* Burn the job number and the time into the corner of a field photo (POD, job
   stop) before it is uploaded, so the photo carries them wherever it is sent -
   a customer or supplier on WhatsApp sees which delivery and when.

   The time is the SERVER's: read from the Date header of an existing cheap,
   same-origin API response and cached for a few minutes, so a phone with its
   clock set back cannot stamp another day. When the server cannot be asked
   (offline, or a cross-origin dev API whose Date header the browser hides),
   the phone's own clock is used and the stamp says "phone time" - never passed
   off as the server's.

   The stamped image is what goes into the normal upload pipeline
   (imagePipeline.ts via uploadFieldPhoto), which still does the compression.
   A file the browser cannot draw goes up unstamped rather than not at all. */
import { fmtDateTime } from "@2990s/shared";
import { correlatedFetch } from "./requestCorrelation";

export type StampClock = { at: Date; source: "server" | "device" };

/** How long one server reading is trusted before asking again. */
export const CLOCK_TTL_MS = 5 * 60_000;
/** Long edge of the stamped image; matches the upload pipeline's own ceiling
 *  (imagePipeline.ts maxDimension) so the pipeline never scales it again. */
export const STAMP_EDGE = 2000;

let cached: { offsetMs: number; readAt: number } | null = null;

/** Test seam: forget the cached server offset. */
export function resetStampClock(): void {
  cached = null;
}

/* /api/auth/status is public, tiny, and already called on every app start. It
   lives on the same origin in production (the Pages proxy), so its Date header
   is readable. */
function clockProbeUrl(): string {
  const base = (import.meta.env.VITE_API_URL as string | undefined) || (import.meta.env.PROD ? "" : "https://autocount-sync-api.houzs-erp.workers.dev");
  return `${base}/api/auth/status`;
}

export async function stampNow(
  fetcher: (url: string) => Promise<{ headers: { get(name: string): string | null } }> = (url) => correlatedFetch(url, { cache: "no-store" }),
  nowMs: () => number = Date.now,
): Promise<StampClock> {
  if (!cached || nowMs() - cached.readAt > CLOCK_TTL_MS) {
    try {
      const res = await fetcher(clockProbeUrl());
      const server = Date.parse(res.headers.get("Date") ?? "");
      if (!Number.isNaN(server)) cached = { offsetMs: server - nowMs(), readAt: nowMs() };
    } catch {
      // Offline: fall through to the cached offset or the phone's clock.
    }
  }
  // A reading older than the TTL is still better than the phone's own clock.
  if (cached) return { at: new Date(nowMs() + cached.offsetMs), source: "server" };
  return { at: new Date(nowMs()), source: "device" };
}

/** The lines burned into the photo: the job label, then the Malaysia date and
 *  time (marked when it is only the phone's clock). */
export function stampLines(label: string | null, clock: StampClock): string[] {
  // The house date format (Malaysia time), the same one every screen prints.
  const when = `${fmtDateTime(clock.at)}${clock.source === "device" ? " (phone time)" : ""}`;
  return [label?.trim() ?? "", when].filter(Boolean);
}

/** Draw the photo upright, scaled to STAMP_EDGE, with the stamp bottom-right.
 *  Returns the original file when the browser cannot decode or encode it. */
export async function stampPhoto(file: File, lines: string[]): Promise<File> {
  if (!file.type.startsWith("image/") || typeof createImageBitmap !== "function" || typeof document === "undefined") return file;
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, STAMP_EDGE / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    const g = canvas.getContext("2d");
    if (!g) { bmp.close(); return file; }
    g.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();

    const size = Math.max(14, Math.round(Math.min(canvas.width, canvas.height) * 0.032));
    const pad = Math.round(size * 0.6);
    const gap = Math.round(size * 0.3);
    g.font = `600 ${size}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    const w = Math.max(...lines.map((l) => g.measureText(l).width)) + pad * 2;
    const h = lines.length * size + (lines.length - 1) * gap + pad * 2;
    const x = canvas.width - w - pad;
    const y = canvas.height - h - pad;
    g.fillStyle = "rgba(0, 0, 0, 0.55)";
    g.fillRect(x, y, w, h);
    g.fillStyle = "#fff";
    g.textBaseline = "top";
    g.textAlign = "right";
    lines.forEach((l, i) => g.fillText(l, x + w - pad, y + pad + i * (size + gap)));

    const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, "image/jpeg", 0.88));
    if (!blob || blob.type !== "image/jpeg") return file;
    return new File([blob], `${file.name.replace(/\.[^.]*$/, "") || "photo"}.jpg`, { type: "image/jpeg" });
  } catch {
    return file;
  }
}
