/* Actual clocking (HC-0125): a work day is a list of clock-in/out segments
 * (clock 1-4), each with its own evidence, so presence is proven per punch. Pure,
 * no DB. The day's clock_in_at / clock_out_at stay the FIRST in and LAST out
 * (daySummary), so every existing reader and the OT / late / shortfall maths are
 * unchanged — they still read that span; segments is the recorded detail. */
import type { GeoResult, PunchSource } from "../../scm/shared/hr-attendance";

export const MAX_PUNCH_PAIRS = 4;

/** One clock-in or clock-out tap: its instant and the evidence of where it was. */
export type PunchMark = {
  at: string;
  source: PunchSource | null;
  lat: number | null;
  lng: number | null;
  accuracyM: number | null;
  geo: GeoResult | null;
  siteId: number | null;
  distanceM: number | null;
  photoKey: string | null;
};

/** One clock pair: an in, and an out once it is closed (null while on the clock). */
export type Segment = { in: PunchMark; out: PunchMark | null };

/** The day is open when its newest segment has an in and no out yet. */
export const dayIsOpen = (segments: ReadonlyArray<Segment>): boolean => {
  const last = segments[segments.length - 1];
  return !!last && last.out == null;
};

export type ApplyResult =
  | { ok: true; segments: Segment[] }
  | { ok: false; reason: "already-in" | "no-open-punch" | "max-pairs" };

export function applyPunch(segments: ReadonlyArray<Segment>, action: "CLOCK_IN" | "CLOCK_OUT", mark: PunchMark): ApplyResult {
  const segs = segments.map((s) => ({ in: s.in, out: s.out }));
  if (action === "CLOCK_IN") {
    if (dayIsOpen(segs)) return { ok: false, reason: "already-in" };
    if (segs.length >= MAX_PUNCH_PAIRS) return { ok: false, reason: "max-pairs" };
    segs.push({ in: mark, out: null });
    return { ok: true, segments: segs };
  }
  if (!dayIsOpen(segs)) return { ok: false, reason: "no-open-punch" };
  segs[segs.length - 1] = { in: segs[segs.length - 1].in, out: mark };
  return { ok: true, segments: segs };
}

/** Close the day's open segment with this out (e.g. the auto clock-out of a
 *  forgotten punch). A day with no open segment is returned unchanged. */
export function closeOpenSegment(segments: ReadonlyArray<Segment>, out: PunchMark): Segment[] {
  const segs = segments.map((s) => ({ in: s.in, out: s.out }));
  if (!dayIsOpen(segs)) return segs;
  segs[segs.length - 1] = { in: segs[segs.length - 1].in, out };
  return segs;
}

/** The summary the day row keeps for every existing reader: the first clock-in
 *  and the last clock-out (null while the day is still open). */
export function daySummary(segments: ReadonlyArray<Segment>): { firstIn: PunchMark | null; lastOut: PunchMark | null; open: boolean } {
  const firstIn = segments.length ? segments[0].in : null;
  const open = dayIsOpen(segments);
  const lastOut = open || !segments.length ? null : segments[segments.length - 1].out;
  return { firstIn, lastOut, open };
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

function asMark(v: unknown): PunchMark | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const at = str(r.at);
  if (!at) return null;
  return {
    at,
    source: str(r.source) as PunchSource | null,
    lat: num(r.lat),
    lng: num(r.lng),
    accuracyM: num(r.accuracyM),
    geo: str(r.geo) as GeoResult | null,
    siteId: num(r.siteId),
    distanceM: num(r.distanceM),
    photoKey: str(r.photoKey),
  };
}

/** Parse the stored JSONB (untrusted shape) into clean segments; a bad shape or
 *  a segment without an in is dropped, so a stored garbage value never throws. */
export function normalizeSegments(raw: unknown): Segment[] {
  if (!Array.isArray(raw)) return [];
  const out: Segment[] = [];
  for (const r of raw) {
    const inMark = asMark((r as Record<string, unknown> | null)?.in);
    if (!inMark) continue;
    out.push({ in: inMark, out: asMark((r as Record<string, unknown>).out) });
  }
  return out;
}
