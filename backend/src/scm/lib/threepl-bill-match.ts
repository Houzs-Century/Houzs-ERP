// ----------------------------------------------------------------------------
// threepl-bill-match — from the lines read off a transport bill
// (threepl-bill-read.ts) to what the carrier charged PER DELIVERY ORDER (owner
// 2026-10-23: 「所以你要根据我的系统的do 对比supplier charge 我的amount对比」).
//
// PURE. The route resolves the numbers against the database; this module
// decides everything else, so the rules can be read and tested in one place:
//
//   * which system numbers a printed one may stand for — "6/10-SO-013216" is
//     HC-SO-013216 (the date in front is the trip's day), "SO-2609-003" is the
//     Houzs or the 2990 order of that number, "DO-010676" is HC-DO-010676,
//     "ZNT6656" is the customer's slip (the order's Ref No.). A handwritten SO
//     the scan reads as "80-" / "S0-" / "50-" after the day is still an SO;
//   * which lines are priced per DO — a delivery; setup, dismantle, dispose,
//     storage and handling are listed beside them and never counted into a DO
//     (「仓储，搬运不算」);
//   * a trip's ONE price over its DOs (NEST LIVING) — split in proportion to
//     what the rate card says each DO costs, evenly when a DO has no card
//     price, so the trip still tallies to the sen;
//   * an order delivered in two DOs — the DO dated nearest the line's day.
// ----------------------------------------------------------------------------
import { fmtSen } from '../shared/format';
import { extractRefTokens } from '../shared/sales-report-parse';
import type { BillLineKind, PrintedOrder, TransportBillLine } from './threepl-bill-read';

/** The system numbers a printed order may stand for. */
export type OrderKeys = {
  /** mfg_sales_orders.doc_no candidates. */
  soNos: string[];
  /** delivery_orders.do_number candidates. */
  doNos: string[];
  /** The customer's slip (Ref No.) tokens, normalised as the evening report's. */
  slips: string[];
  /** After-sales service numbers (ASSR/2607-047) — a service case, not a DO. */
  assr: string[];
};

/* A handwritten "SO" after the day ("3/10-80-010540", "7|0-S0-003361"). */
const SO_MISREAD = /(^|[^A-Z0-9])(?:S0|5O|50|80|S8|SD)-(?=\d)/g;
/* Prefixes the slip tokenizer must not take for a customer's slip. */
const NOT_A_SLIP = /^(SO|DO|IV|INV|CN|DN|PO|GR|ASSR|RM|NO|SVC)\d/;

const pad6 = (digits: string): string => digits.padStart(6, '0');

export function orderKeys(o: PrintedOrder): OrderKeys {
  const t = [o.soNo, o.doNo, o.ref].filter(Boolean).join(' ').toUpperCase().replace(SO_MISREAD, '$1SO-');
  const soNos = new Set<string>();
  const doNos = new Set<string>();
  const assr = new Set<string>();
  /* A number printed with its company is that company's; only a bare one is
     either company's. */
  const PREFIXED = /\b(2990|HC)-(SO|DO)-(\d{4}-\d{3})\b/g;
  for (const m of t.matchAll(PREFIXED)) (m[2] === 'SO' ? soNos : doNos).add(`${m[1]}-${m[2]}-${m[3]}`);
  const bare = t.replace(PREFIXED, ' ');
  for (const m of bare.matchAll(/(?:^|[^A-Z0-9])SO-?(\d{4}-\d{3})\b/g)) { soNos.add(`HC-SO-${m[1]}`); soNos.add(`2990-SO-${m[1]}`); }
  for (const m of bare.matchAll(/SO-?0*(\d{4,6})\b(?!-\d)/g)) soNos.add(`HC-SO-${pad6(m[1]!)}`);
  for (const m of bare.matchAll(/(?:^|[^A-Z0-9])DO-?(\d{4}-\d{3})\b/g)) { doNos.add(`HC-DO-${m[1]}`); doNos.add(`2990-DO-${m[1]}`); }
  for (const m of bare.matchAll(/DO-?0*(\d{5,6})\b(?!-\d)/g)) doNos.add(`HC-DO-${pad6(m[1]!)}`);
  for (const m of t.matchAll(/ASSR\s*[/-]?\s*(\d{4}-\d{3})/g)) assr.add(m[1]!);
  const slips = extractRefTokens(t.replace(/ASSR\s*[/-]?\s*\d{4}-\d{3}/g, ' '))
    .filter((k) => !NOT_A_SLIP.test(k) && soNos.size + doNos.size === 0);
  return { soNos: [...soNos], doNos: [...doNos], slips, assr: [...assr] };
}

/** A line's kind, its own words outranking the reader's guess. */
export function effectiveKind(line: Pick<TransportBillLine, 'kind' | 'text'>): BillLineKind {
  const t = line.text.toUpperCase();
  if (/STORAGE/.test(t)) return 'storage';
  if (/HANDLING/.test(t)) return 'handling';
  if (/DISPOS/.test(t)) return 'dispose';
  if (/DISMANTL/.test(t)) return 'dismantle';
  if (/SET\s?UP/.test(t)) return 'setup';
  return line.kind;
}

export type DoCandidate = {
  id: string;
  doNumber: string;
  doDate: string | null;
  soDocNo: string | null;
  companyId: number;
  customer: string | null;
};

const dayNo = (iso: string | null): number | null => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? Date.parse(iso.slice(0, 10)) / 86400000 : null);

/** An order delivered in several DOs: the one dated nearest the line's day
 *  (the latest when the line has none). */
export function pickDo(candidates: readonly DoCandidate[], lineDate: string | null): DoCandidate | null {
  if (candidates.length <= 1) return candidates[0] ?? null;
  const day = dayNo(lineDate);
  const sorted = [...candidates].sort((a, b) => String(b.doDate ?? '').localeCompare(String(a.doDate ?? '')));
  if (day == null) return sorted[0]!;
  return sorted.reduce((best, d) => {
    const gap = Math.abs((dayNo(d.doDate) ?? Infinity) - day);
    const bestGap = Math.abs((dayNo(best.doDate) ?? Infinity) - day);
    return gap < bestGap ? d : best;
  });
}

export type LineStatus = 'matched' | 'not_found' | 'no_number' | 'service_case' | 'not_delivery';

export type MatchedLine = {
  index: number;
  text: string;
  date: string | null;
  kind: BillLineKind;
  amountSen: number | null;
  /** The numbers as printed, for the screen. */
  printed: string[];
  dos: DoCandidate[];
  status: LineStatus;
};

/** Every line's status, once its numbers are resolved. `resolve` answers the
 *  DOs one printed order stands for (none when nothing in the system has it). */
export function matchLines(
  lines: readonly TransportBillLine[],
  resolve: (keys: OrderKeys, lineDate: string | null) => DoCandidate[],
): MatchedLine[] {
  return lines.map((l, index) => {
    const kind = effectiveKind(l);
    const keys = l.orders.map(orderKeys);
    const printed = l.orders.map((o) => [o.soNo, o.doNo, o.ref].filter(Boolean).join(' ')).filter(Boolean);
    const numbered = keys.some((k) => k.soNos.length + k.doNos.length + k.slips.length > 0);
    const serviceOnly = !numbered && keys.some((k) => k.assr.length > 0);
    const perDo = kind === 'delivery' || (kind === 'other' && numbered);
    const seen = new Set<string>();
    const dos = perDo
      ? keys.flatMap((k) => resolve(k, l.date)).filter((d) => (seen.has(d.id) ? false : (seen.add(d.id), true)))
      : [];
    const status: LineStatus = !perDo && !serviceOnly ? 'not_delivery'
      : dos.length > 0 ? 'matched'
        : serviceOnly ? 'service_case'
          : numbered ? 'not_found' : 'no_number';
    return { index, text: l.text, date: l.date, kind, amountSen: l.amountSen, printed, dos, status };
  });
}

/** A trip printed as one priced row and further rows naming only its other
 *  DOs (no price of their own): those DOs join the priced row before it, on
 *  the same day, so the trip's one price covers them all. */
export function foldTrips(lines: readonly MatchedLine[]): MatchedLine[] {
  const out: MatchedLine[] = [];
  for (const l of lines) {
    const unpriced = l.status === 'matched' && !l.amountSen;
    const prev = out.at(-1);
    if (unpriced && prev && prev.status === 'matched' && prev.amountSen && (l.date == null || prev.date == null || l.date === prev.date)) {
      const ids = new Set(prev.dos.map((d) => d.id));
      out[out.length - 1] = { ...prev, dos: [...prev.dos, ...l.dos.filter((d) => !ids.has(d.id))], printed: [...prev.printed, ...l.printed] };
      continue;
    }
    out.push(l);
  }
  return out;
}

export type DoCharge = {
  doId: string;
  billedSen: number;
  /** The bill's own words for this DO, one per line it appears on. */
  lines: string[];
  /** Part of one price shared with other DOs (a trip). */
  split: boolean;
};

/** What the carrier charged each DO. A line naming one DO charges it all; a
 *  line covering several shares its one price in proportion to each DO's
 *  rate-card amount — evenly when any of them has none — the rounding put on
 *  the last, so the shares add up to the line to the sen. A DO on two lines
 *  carries both. */
export function chargesPerDo(lines: readonly MatchedLine[], expectedOf: (doId: string) => number | null): DoCharge[] {
  const by = new Map<string, DoCharge>();
  for (const l of lines) {
    if (l.status !== 'matched' || !l.amountSen) continue;
    const n = l.dos.length;
    const weights = l.dos.map((d) => expectedOf(d.id));
    const weighted = n > 1 && weights.every((w) => w != null && w > 0);
    const total = weighted ? weights.reduce<number>((s, w) => s + (w ?? 0), 0) : n;
    let given = 0;
    l.dos.forEach((d, i) => {
      const share = i === n - 1 ? l.amountSen! - given : Math.round((l.amountSen! * (weighted ? weights[i]! : 1)) / total);
      given += share;
      const words = l.printed.length > 0 ? `${l.text} — ${fmtSen(l.amountSen)}${n > 1 ? ` for ${n} DOs` : ''}` : l.text;
      const c = by.get(d.id) ?? { doId: d.id, billedSen: 0, lines: [], split: false };
      c.billedSen += share;
      c.lines.push(words);
      c.split = c.split || n > 1;
      by.set(d.id, c);
    });
  }
  return [...by.values()];
}

/** The note a saved charge carries: where on the bill it came from. */
export function chargeNote(c: DoCharge, apInvoiceNumber: string): string {
  const head = c.split ? `${apInvoiceNumber} · one price for a trip, shared by the rate card` : apInvoiceNumber;
  return `${head}: ${c.lines.join(' / ')}`.slice(0, 500);
}

/* ── Where a line goes (owner 2026-10-24) ────────────────────────────────────
   「对不上的 … 我想要assign 看这个是去哪里，可能是service, 可能是setup dismantle，
   可能不算」: every line is kept and assigned — to DOs (compared with the rate
   card), to a service case, to a fair (setup / dismantle) or to nothing
   (storage, handling, dispose). The reader assigns what it can tell; a line
   it cannot — a number the system does not have, no number, a fair it cannot
   name — waits for a person. */
export type LineAssign = 'do' | 'service' | 'event' | 'none';
export type Assignment = { assign: LineAssign | null; doIds: string[]; serviceRef: string | null; projectId: number | null };

const UNASSIGNED: Assignment = { assign: null, doIds: [], serviceRef: null, projectId: null };

/** The reader's assignment of one line. A setup / dismantle takes the fair of
 *  the AP invoice line of the same amount when exactly one fair carries it. */
export function preselect(line: Pick<MatchedLine, 'status' | 'kind' | 'amountSen' | 'printed' | 'dos'>, apLines: ReadonlyArray<{ amountSen: number | null; projectId: number | null }>): Assignment {
  if (line.status === 'matched') return { ...UNASSIGNED, assign: 'do', doIds: line.dos.map((d) => d.id) };
  if (line.status === 'service_case') return { ...UNASSIGNED, assign: 'service', serviceRef: line.printed.find((p) => /ASSR/i.test(p)) ?? null };
  if (line.kind === 'setup' || line.kind === 'dismantle') {
    const fairs = [...new Set(apLines.filter((a) => a.projectId != null && line.amountSen != null && a.amountSen === line.amountSen).map((a) => a.projectId as number))];
    return { ...UNASSIGNED, assign: 'event', projectId: fairs.length === 1 ? fairs[0]! : null };
  }
  if (line.kind === 'storage' || line.kind === 'handling' || line.kind === 'dispose') return { ...UNASSIGNED, assign: 'none' };
  return UNASSIGNED;
}

/** A line still waiting for a person: nothing assigned, a DO line with no DO,
 *  a setup / dismantle with no fair. */
export function isOpenLine(a: { assign: string | null; doIds: readonly string[]; projectId: number | null }): boolean {
  return a.assign == null || (a.assign === 'do' && a.doIds.length === 0) || (a.assign === 'event' && a.projectId == null);
}

/** A bill's lines summed by where they went — the parts add up to the bill. */
export function billBreakdown(lines: ReadonlyArray<{ assign: string | null; doIds: readonly string[]; projectId: number | null; amountSen: number | null }>) {
  const t = { do: 0, service: 0, event: 0, none: 0, open: 0, openLines: 0 };
  for (const l of lines) {
    const v = l.amountSen ?? 0;
    if (isOpenLine(l)) { t.open += v; t.openLines += 1; continue; }
    t[l.assign as LineAssign] += v;
  }
  return t;
}

/** Sen per status, and the bill's total as read. */
export function lineTotals(lines: readonly MatchedLine[]): Record<LineStatus | 'all', number> {
  const t: Record<LineStatus | 'all', number> = { all: 0, matched: 0, not_found: 0, no_number: 0, service_case: 0, not_delivery: 0 };
  for (const l of lines) {
    const v = l.amountSen ?? 0;
    t.all += v;
    t[l.status] += v;
  }
  return t;
}
