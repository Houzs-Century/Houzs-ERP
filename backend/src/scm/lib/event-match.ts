// ----------------------------------------------------------------------------
// event-match.ts — which events a scanned bill is probably for (owner
// 2026-09-29/30: ocr 要有办法 detect 相关的 event; 6a — SUGGEST, never bind).
//
// The house rule for the bill reader: the model reads what is PRINTED
// (acc/bill-extract.ts — the event's name, venue, booth, dates), and plain code
// decides what that points at. This is that code, pure: the printed hints and
// the vendor's name against the company's events, scored on what can be
// checked — a booth number both sides carry, the venue, the organiser, the
// event days, the brand — each reason named, so a person sees WHY an event is
// offered before they take it.
//
// An event row is one brand at one fair, so one bill (a shared booth, one
// organiser invoice) can point at several rows equally; they are all offered
// and the person picks, or splits the lines.
// ----------------------------------------------------------------------------

import type { BillEventHint } from '../../acc/bill-extract';
import type { EventRow } from './event-tags';

export type EventSuggestion = { id: number; score: number; reasons: string[]; event: EventRow };

/* Letters and digits only, upper case — "Setia SPICE Conv. Centre" and
   "SETIA SPICE CONVENTION CENTRE" compare on what they spell. */
const fold = (s: string | null | undefined): string => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
const tokens = (s: string | null | undefined): string[] => fold(s).split(' ').filter(Boolean);

/* Booth numbers as tokens: "1129-1132, 1139-1142" → 1129 1132 1139 1142;
   "Y17 & Y10a" → Y17 Y10A. A one-character token is too common to count. */
const boothTokens = (s: string | null | undefined): Set<string> => new Set(tokens(s).filter((t) => t.length >= 2));

/* Venue words that name no place on their own. */
const VENUE_NOISE = new Set(['CONVENTION', 'CENTRE', 'CENTER', 'EXHIBITION', 'HALL', 'MALL', 'THE', 'AND', 'OF', 'AT', 'EXPO', 'INTERNATIONAL', 'KUALA', 'LUMPUR', 'LEVEL', 'FLOOR']);
const placeWords = (s: string | null | undefined): string[] => tokens(s).filter((t) => t.length >= 3 && !VENUE_NOISE.has(t) && !/^\d+$/.test(t));

const dayDiff = (a: string, b: string): number => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);

/** The score an event earns and why, or null when nothing ties it to the bill. */
export function scoreEvent(
  input: { hint: BillEventHint | null; vendorName: string | null; lineText: string; billDate: string | null },
  e: EventRow,
): { score: number; reasons: string[] } | null {
  const hint = input.hint;
  const reasons: string[] = [];
  let score = 0;

  // Booth — the strongest tie: a number both the bill and the event carry.
  if (hint?.booth && e.boothNo) {
    const ours = boothTokens(e.boothNo);
    const hit = [...boothTokens(hint.booth)].find((t) => ours.has(t));
    if (hit) { score += 40; reasons.push(`booth ${hit}`); }
  }

  // Venue — the printed venue (or event name) sharing the event's place words.
  const placeOfEvent = placeWords(e.venue);
  if (placeOfEvent.length > 0) {
    const printed = new Set([...placeWords(hint?.venue), ...placeWords(hint?.name)]);
    const shared = placeOfEvent.filter((w) => printed.has(w));
    if (shared.length > 0 && shared.length >= Math.min(2, placeOfEvent.length)) {
      score += 30; reasons.push(`venue ${e.venue ?? ''}`.trim());
    }
  }

  // Organiser — "MLE EVENTS SDN BHD" issuing a bill for an MLE fair.
  const org = fold(e.organizer);
  if (org && org.length >= 2 && !['SOLO', 'MALL MGT', 'MALL MGMT'].includes(org)) {
    const printed = ` ${fold(input.vendorName)} ${fold(hint?.name)} `;
    if (printed.includes(` ${org} `)) { score += 20; reasons.push(`organiser ${e.organizer ?? ''}`.trim()); }
  }

  // Days — the printed event days overlapping the event's own.
  const start = e.startDate;
  const end = e.endDate ?? e.startDate;
  if (start && end && hint?.dateFrom) {
    const to = hint.dateTo ?? hint.dateFrom;
    if (hint.dateFrom <= end && to >= start) { score += 25; reasons.push('same days'); }
  }

  // Brand — the event row is one brand; a bill that names it points at that row.
  const brand = fold(e.brand);
  if (brand && brand.length >= 3) {
    const printed = ` ${fold(input.lineText)} ${fold(hint?.name)} `;
    if (printed.includes(` ${brand} `)) { score += 10; reasons.push(`brand ${e.brand ?? ''}`.trim()); }
  }

  if (score === 0) return null;

  // Nearness — a small nudge toward the event closest to the bill's date, so
  // two equally matched fairs a year apart are not a coin toss.
  if (start && input.billDate) {
    const d = Math.abs(dayDiff(start, input.billDate));
    score += Math.max(0, 5 - Math.floor(d / 30));
  }
  return { score, reasons };
}

/** Suggestions strong enough to offer — a booth, a venue, or two weaker ties —
    best first, at most `limit`. */
export function suggestEvents(
  input: { hint: BillEventHint | null; vendorName: string | null; lineText: string; billDate: string | null },
  events: EventRow[],
  limit = 3,
): EventSuggestion[] {
  const out: EventSuggestion[] = [];
  for (const e of events) {
    if (e.archived) continue;
    const s = scoreEvent(input, e);
    if (s && s.score >= 30) out.push({ id: e.id, score: s.score, reasons: s.reasons, event: e });
  }
  return out.sort((a, b) => b.score - a.score || String(a.event.startDate ?? '').localeCompare(String(b.event.startDate ?? ''))).slice(0, limit);
}
