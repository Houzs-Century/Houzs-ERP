// Pure formatting helpers. Lifted from prototype per PORT_DESIGN.md §11.2 Issue 8.
// SOLE source of truth — no inline duplicates anywhere in client OR server.

/** Whole-MYR formatter. §10 Decision 9: integer RM only, never `.00`. */
export const fmtMoney = (n: number): string =>
  n.toLocaleString('en-MY', { maximumFractionDigits: 0 });

/** Returns "RM 2,990" — for inline copy where PriceTag is overkill. */
export const fmtRM = (n: number): string => `RM ${fmtMoney(n)}`;

/* ── THE ONE DATE RULE ───────────────────────────────────────────────────────
   DD/MM/YYYY, numeric, day-first (Malaysian standard). Ruled twice by the
   owner and written into the tree both times:
     · frontend/src/lib/utils.ts — "House style is numeric DD/MM/YYYY (owner
       requirement — no 'Jun'/'Jul' month names anywhere on the desktop app)"
     · this file, below — "System-wide canonical display format
       (Commander 2026-06-18)"
   and then re-derived by hand ~30 more times in four other spellings, which is
   why one screen could show "Aug 16, 2026" in the header and "12/09/2026" on
   the line beneath it. `fmtDate` / `fmtDateTime` are now the ONLY place the
   shape is written. backend/scripts/check-date-formatting.mjs fails the build
   on a new hand-rolled one.

   WHY THE PARSING IS EXPLICIT AND NOT `new Date(x)`. The previous body was
   `new Date(d).toLocaleDateString('en-GB', …)` and it was wrong twice over:

   1. `new Date('2026-08-16')` is parsed by the spec as UTC MIDNIGHT. Rendered
      in any negative-offset zone that is 15 August. Malaysia is UTC+8 so it
      looked right in the office and was wrong for anyone else — the exact trap
      SalesOrderDetail.tsx documents dodging by hand.
   2. `toLocaleDateString` with NO `timeZone` renders in the VIEWER's zone, so a
      real instant near midnight showed a different day per machine.

   So: a value that carries NO zone (a date-only column, a datetime-local
   wall-clock field) is displayed VERBATIM — never round-tripped through a Date,
   never converted. A value that IS a real instant is converted ONCE, into
   Malaysian time, by fixed +08:00 arithmetic rather than an ICU timezone
   lookup. Malaysia has had no DST and no offset change since 1982, the same
   assumption `todayMY` below already makes, and it gives byte-identical output
   in a browser, in Workers and under vitest.

   DISPLAY ONLY. Never feed the output to a date input, an API payload or
   AutoCount — those stay ISO. Use `todayMY` / the raw ISO value for those. */

const MYT_OFFSET_MS = 8 * 60 * 60 * 1000;
const DASH = '—';

type DateParts = { yyyy: string; mm: string; dd: string; hh: string; mi: string; ss: string };

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** A real instant → its Malaysian wall-clock fields. `null` if not a real date. */
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

/** Everything the app stores or receives → display fields, or `null` for
 *  "nothing to show" (null / undefined / '' / unparseable). */
function dateParts(d: Date | string | number | null | undefined): DateParts | null {
  if (d == null) return null;
  if (d instanceof Date) return mytParts(d);
  if (typeof d === 'number') return Number.isFinite(d) ? mytParts(new Date(d)) : null;

  const s = d.trim();
  if (s === '') return null;

  /* Already in house shape. Formatting a formatted string must be a no-op —
     a display helper that corrupts its own output is how "16/08/2026" became
     "Invalid Date" when a second caller wrapped a first. */
  const dmy = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
  if (dmy) return { yyyy: dmy[3], mm: dmy[2], dd: dmy[1], hh: '00', mi: '00', ss: '00' };

  /* NO ZONE IN THE VALUE → NO CONVERSION. Covers the two shapes this ERP
     actually stores: a date-only `date`/`text` column (`2026-08-16`) and a
     datetime-local wall-clock field (`2026-08-16T14:30`). Also covers
     AutoCount's zone-less `2026-08-12T00:00:00`. Displaying these verbatim is
     what makes the output identical on every machine. */
  const wall = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/.exec(s);
  if (wall && !/[Zz]$|[+-]\d{2}:?\d{2}$/.test(s)) {
    /* A bare SQL timestamp `YYYY-MM-DD HH:MM:SS` IS an instant — SQLite's
       `datetime('now')` returns unzoned UTC — so the space form with seconds
       goes through the UTC branch instead. Everything else is wall clock. */
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(s)) {
      return mytParts(new Date(s.replace(' ', 'T') + 'Z'));
    }
    /* Sliced, not read off the optional capture groups. TypeScript types
       `wall[4]` as `string` (this tsconfig has no noUncheckedIndexedAccess)
       while at RUNTIME an unmatched group is `undefined` — so the `?? '00'`
       that shape needs reads as dead code to eslint and as load-bearing to the
       engine. The regex above has already proven the layout; slicing the
       validated string states the same thing without the disagreement. */
    const time = s.slice(11); // '' when the value is date-only
    return {
      yyyy: wall[1],
      mm: wall[2],
      dd: wall[3],
      hh: time.slice(0, 2) || '00',
      mi: time.slice(3, 5) || '00',
      ss: time.slice(6, 8) || '00',
    };
  }

  /* A zoned ISO instant (`…Z`, `…+08:00`) or anything else Date understands. */
  return mytParts(new Date(s));
}

/** THE date format: "16/08/2026". Null-safe, invalid-safe, idempotent.
 *  Display only — never feed this to a date input, an API or AutoCount. */
export const fmtDate = (d: Date | string | number | null | undefined): string => {
  const p = dateParts(d);
  return p === null ? DASH : `${p.dd}/${p.mm}/${p.yyyy}`;
};

/** THE date+time format: "16/08/2026 14:30". 24-hour, no comma — the same
 *  numeric, unambiguous rule as {@link fmtDate}, one export further. */
export const fmtDateTime = (d: Date | string | number | null | undefined): string => {
  const p = dateParts(d);
  return p === null ? DASH : `${p.dd}/${p.mm}/${p.yyyy} ${p.hh}:${p.mi}`;
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
  return p === null ? DASH : `${p.dd}/${p.mm}/${p.yyyy} ${p.hh}:${p.mi}:${p.ss}`;
};

/** The one rule, INVERTED — "16/08/2026" → "2026-08-16"; anything else is
 *  returned untouched.
 *
 *  WHY THIS EXISTS. A spreadsheet sorts text, and `16/08/2026` sorts under
 *  "1" next to `1/1/2027`. The V2 list pages used to export `2026/08/16` and
 *  sorted correctly BY ACCIDENT — converging them onto the display rule would
 *  have silently broken every operator who exports and sorts. Export is not
 *  display: the sheet gets the storage shape, which sorts, which is what the
 *  DB and every API already carry, and which imports back cleanly.
 *
 *  Applied at the CSV boundary (DataGrid / DataTable), so a column keeps
 *  rendering `fmtDate` on screen and nobody has to remember this per column. */
export const isoForExport = (v: string | number | null | undefined): string | number => {
  if (typeof v !== 'string') return v ?? '';
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v.trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : v;
};

/** Null-safe date. Kept as the name 62 call sites already use; `fmtDate` is
 *  null-safe itself now, so this is exactly the same rule under an older name. */
export const fmtDateOrDash = (d: Date | string | number | null | undefined): string => fmtDate(d);

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
