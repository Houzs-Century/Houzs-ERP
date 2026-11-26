
/** Whole-MYR formatter. §10 Decision 9: integer RM only, never `.00`. */
export const fmtMoney = (n: number): string =>
  n.toLocaleString('en-MY', { maximumFractionDigits: 0 });

/** Returns "RM 2,990" — for inline copy where PriceTag is overkill. */
export const fmtRM = (n: number): string => `RM ${fmtMoney(n)}`;

/** ERP/centi money → "RM 2,990.00" (2dp). The centi-layer counterpart to
 *  {@link fmtRM} for cost/GL/document totals. Null-safe AND non-finite-safe
 *  ("—"). NOTE: assumes MYR — for documents that carry their own `currency`
 *  field, use {@link fmtMoneySen} instead of hardcoding the RM prefix. */
export const fmtSen = (centi: number | null | undefined): string => {
  const n = Number(centi);
  if (centi == null || !Number.isFinite(n)) return '—';
  return `RM ${(n / 100).toLocaleString('en-MY', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
};

/** Sen money with the document's OWN currency → "RM 2,990.00" / "USD 2,990.00" (2dp).
 *  The currency-carrying counterpart to {@link fmtSen}, and the ONE home for
 *  the `${currency} ${centi/100}` shape that was hand-copied into 16 page-local
 *  `fmtMoney` helpers (SO/DO/DR/SI detail + the purchase-side pages).
 *
 *  Unknown / unreadable number → "—", never the literal text "NaN" (owner's
 *  plain-language rule). Every local copy was `(centi / 100).toLocaleString(...)`
 *  with NO finite guard, so an absent or non-numeric field rendered "MYR NaN"
 *  straight at the user — a number the ERP does not have must read as blank, not
 *  as a broken one. Mobile's MobileModuleDetail.money() already had this guard;
 *  the desktop copies never got it. */
export const fmtMoneySen = (
  centi: number | null | undefined,
  currency = 'MYR',
): string => {
  const n = Number(centi);
  if (centi == null || !Number.isFinite(n)) return '—';
  // Ringgit reads "RM", on screen and on paper (owner 2026-09-27); a foreign
  // currency keeps its own code.
  const code = !currency || currency.toUpperCase() === 'MYR' ? 'RM' : currency;
  return `${code} ${(n / 100).toLocaleString('en-MY', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
};

/** Integer quantity with thousands separators → "1,250". Null-safe ("—"). */
export const fmtQty = (n: number | null | undefined): string => {
  if (n == null) return '—';
  return n.toLocaleString('en-MY', { maximumFractionDigits: 0 });
};


const MYT_OFFSET_MS = 8 * 60 * 60 * 1000;
const DASH = '—';

type DateParts = { yyyy: string; mm: string; dd: string; hh: string; mi: string; ss: string };

const pad2 = (n: number): string => String(n).padStart(2, '0');

function mytParts(date: Date): DateParts | null {
  const t = date.getTime();
  if (!Number.isFinite(t)) return null;
  const s = new Date(t + MYT_OFFSET_MS);
  return {
    yyyy: String(s.getUTCFullYear()),
    mm: pad2(s.getUTCMonth() + 1),
    dd: pad2(s.getUTCDate()),
    hh: pad2(s.getUTCHours()),
    mi: pad2(s.getUTCMinutes()),
    ss: pad2(s.getUTCSeconds()),
  };
}

function dateParts(d: Date | string | number | null | undefined): DateParts | null {
  if (d == null) return null;
  if (d instanceof Date) return mytParts(d);
  if (typeof d === 'number') return Number.isFinite(d) ? mytParts(new Date(d)) : null;

  const s = d.trim();
  if (s === '') return null;

  const ymd = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(s);
  if (ymd) return { yyyy: ymd[1], mm: ymd[2], dd: ymd[3], hh: '00', mi: '00', ss: '00' };
  const dmy = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
  if (dmy) return { yyyy: dmy[3], mm: dmy[2], dd: dmy[1], hh: '00', mi: '00', ss: '00' };

  const wall = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/.exec(s);
  if (wall && !/[Zz]$|[+-]\d{2}:?\d{2}$/.test(s)) {
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(s)) {
      return mytParts(new Date(s.replace(' ', 'T') + 'Z'));
    }
    const time = s.slice(11);
    return {
      yyyy: wall[1],
      mm: wall[2],
      dd: wall[3],
      hh: time.slice(0, 2) || '00',
      mi: time.slice(3, 5) || '00',
      ss: time.slice(6, 8) || '00',
    };
  }

  return mytParts(new Date(s));
}

/** THE date format: "2026/08/16" (year-first, owner 2026-09-25). Null-safe,
 *  invalid-safe, idempotent. Display only — never feed this to a date input, an
 *  API or AutoCount. */
export const fmtDate = (d: Date | string | number | null | undefined): string => {
  const p = dateParts(d);
  return p === null ? DASH : `${p.yyyy}/${p.mm}/${p.dd}`;
};

/** THE date+time format: "2026/08/16 14:30". 24-hour, no comma — the same
 *  numeric, unambiguous rule as {@link fmtDate}, one export further. */
export const fmtDateTime = (d: Date | string | number | null | undefined): string => {
  const p = dateParts(d);
  return p === null ? DASH : `${p.yyyy}/${p.mm}/${p.dd} ${p.hh}:${p.mi}`;
};

/** "13/08" — {@link fmtDate} with the YEAR trimmed, for a label that already
 *  sits inside a bounded window. Same digits in the same order as every other
 *  date in this app: a month NAME would be a SECOND format, which is the thing
 *  the owner ruled out on 2026-08-18 (*"全套系统的 date format 没有统一"*) and
 *  which `check-date-formatting.mjs` fails a build over. Null / unparseable is
 *  "—", exactly as {@link fmtDate}. */
export const fmtDayMonth = (d: Date | string | number | null | undefined): string => {
  const p = dateParts(d);
  return p === null ? DASH : `${p.mm}/${p.dd}`;
};

/** A PERIOD as one label: "13/08 - 17/08", and just "13/08" when it is one day.
 *
 *  Built for the SO fair picker, where the owner asked for the year dropped
 *  (2026-09-19) because that list only ever spans the 28 days behind the order
 *  date — a year cannot disambiguate anything inside it. It lives HERE, beside
 *  the format it is a variant of, rather than inside the picker: a date shape
 *  with its own private home is how this tree grew five of them and needed a
 *  gate to find them again.
 *
 *  BOTH ENDS ARE RENDERED IN FULL. "13/08 - 17" saves three characters and costs
 *  the reader the month on the end that is most likely to differ.
 *
 *  An unreadable end falls back to the start rather than printing "13/08 - —",
 *  which reads as a fair that never finished. */
export const fmtDayMonthRange = (
  from: Date | string | number | null | undefined,
  to: Date | string | number | null | undefined,
): string => {
  const start = fmtDayMonth(from);
  const end = to == null ? start : fmtDayMonth(to);
  return end === start || end === DASH ? start : `${start} - ${end}`;
};

/** "14:30" — the time half of the one rule, for rows that already show the day. */
export const fmtTime = (d: Date | string | number | null | undefined): string => {
  const p = dateParts(d);
  return p === null ? DASH : `${p.hh}:${p.mi}`;
};

/** "16/08/2026 14:30:05" — the one rule to the second, for audit trails where
 *  the second is the evidence (activity log, attachment uploaded_at). */
export const fmtTimestamp = (d: Date | string | number | null | undefined): string => {
  const p = dateParts(d);
  return p === null ? DASH : `${p.yyyy}/${p.mm}/${p.dd} ${p.hh}:${p.mi}:${p.ss}`;
};

/** The display rule, normalised for export — "2026/08/16" → "2026-08-16";
 *  anything else is returned untouched.
 *
 *  WHY THIS EXISTS. Export is not display: the sheet gets the storage shape
 *  (ISO `YYYY-MM-DD`, dash-separated), which is what the DB and every API carry
 *  and which imports back cleanly. The year-first display (owner 2026-09-25)
 *  already sorts as text, so this is now just swapping the separators — but a
 *  column keeps rendering `fmtDate` on screen and the CSV boundary (DataGrid /
 *  DataTable) applies this so nobody has to remember it per column. */
export const isoForExport = (v: string | number | null | undefined): string | number => {
  if (typeof v !== 'string') return v ?? '';
  const m = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(v.trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : v;
};

/** Null-safe date. Kept as the name 62 call sites already use; `fmtDate` is
 *  null-safe itself now, so this is exactly the same rule under an older name. */
export const fmtDateOrDash = (d: Date | string | number | null | undefined): string => fmtDate(d);

/** Canonical Malaysian "today" as ISO `YYYY-MM-DD` (UTC+8), timezone-stable
 *  regardless of where the code runs (browser MYT vs Workers UTC). Use this for
 *  date-input `value`/`min` and API payloads — NOT {@link fmtDate} (display). */
export const todayMY = (): string => new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);

/** "3 days ago" / "today" / "yesterday" / "in 2 days". */
export const daysAgo = (d: Date | string | number, now: Date = new Date()): string => {
  const date = d instanceof Date ? d : new Date(d);
  const ms = now.getTime() - date.getTime();
  const days = Math.round(ms / (24 * 60 * 60 * 1000));
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days === -1) return 'tomorrow';
  if (days > 0) return `${days} days ago`;
  return `in ${-days} days`;
};

/** "RM 1,490 – 2,990" or "from RM 1,490" if max is missing. */
export const pricingRange = (min: number | null, max?: number | null): string => {
  if (min === null || min === undefined) return 'TBC';
  if (max === null || max === undefined || max === min) return `from RM ${fmtMoney(min)}`;
  return `RM ${fmtMoney(min)} – ${fmtMoney(max)}`;
};

/** Money on a statement (docs/bugs/0910): a negative figure in parentheses,
    "(RM 1,139.19)" — never a minus sign after the RM. Expenses and costs are
    shown as the positive figures they are; only a period whose credits beat
    its debits (a reversal) turns a line negative, and that is what the
    parentheses mean. A loss is a negative net and reads the same way. */
export const fmtSenParen = (centi: number | null | undefined): string => {
  const n = Number(centi);
  if (centi == null || !Number.isFinite(n)) return '—';
  return n < 0 ? `(${fmtSen(-n)})` : fmtSen(n);
};

/** 1,234.56 with a bracketed negative and NO currency — the Finance reports'
    one money dress, the Cash Flow's own (owner 2026-09-19: P&L 的 RM 前缀拿掉，
    和 cash flow 一样): the P&L, the Balance Sheet, the Performance P&L and the
    Cash Flow, on the screen, By month, in Excel and on paper alike. */
export const fmtSenPlain = (centi: number | null | undefined): string => {
  const n = Number(centi);
  if (centi == null || !Number.isFinite(n)) return '—';
  const s = (Math.abs(n) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 ? `(${s})` : s;
};
