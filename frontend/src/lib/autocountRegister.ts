// ----------------------------------------------------------------------------
// autocountRegister — the AutoCount Sync REGISTER, shared by both surfaces.
//
// SAME LOGIC LAYER AS `autocountOutbox.ts`, second file. CLAUDE.md's standing
// rule is one shared logic layer with the two surfaces differing only in
// presentation, and that rule is about who OWNS a decision, not about how many
// files hold it: everything here is imported by the desktop page and by the
// phone screen, and by nothing else. It is a separate file only because
// `autocountOutbox.ts` is 1,767 lines against this repo's 2,000-line ceiling
// (`scripts/file-size-ceilings.json`), and the repo's own instruction when a
// file is at its ceiling is a new module, never a bigger number.
//
// WHAT IS IN HERE. The list became a TABLE on 2026-08-21: the owner reviewed a
// mockup at the size the queue actually is — the sales order slice alone is
// 2,726 documents — and chose the dense-register direction over the card list.
// This file is the part both surfaces share: which columns exist, what the
// account book's answer to a document MEANS, which day a document belongs to,
// how the register is ordered and narrowed, and the sentence that closes it.
// The desktop draws them as a grid; the phone keeps its cards and reads the
// same verdicts, because a table does not fit 375 px.
//
// NO POLICY HERE EITHER, for the same reason `autocountOutbox.ts` says it
// carries none: every value below is derived from a field the SERVER decided.
// The one comparison this file makes — the ERP's document number against the
// account book's — is not a classification of the row; it is two strings the
// response already carries, held up against each other, which is the thing no
// screen was doing when `HC-PO-2608-001` sat in `AED_HOUZS` as `PO-009968` for
// three days.
//
// NOTHING THE PAGE ALREADY RULED ON MOVED. The headline is still on a problem
// row unclicked, the page still opens on what is stuck, and a document already
// in the account book still has nothing to open. Those are rulings, not layout.
// ----------------------------------------------------------------------------
import { fmtDate, fmtTime } from "../vendor/shared/format";

import type { AcDocGroup, AcOutboxRow } from "./autocountOutbox";

/** `dd/mm/yyyy`, which is what `fmtDate` produces for anything it can read. */
const AC_DMY = /^(\d{2})\/(\d{2})\/(\d{4})$/;

/** The mark for a cell with no value. One constant so no column picks its own,
 *  and so a test can ask for it by name rather than by glyph. */
export const AC_NO_VALUE = "—";

/**
 * THE EIGHT COLUMNS, in order, as the owner approved them.
 *
 * Here rather than in the page because the NAMES are words a reader reads, like
 * every other string in this file — and because the column set is the contract
 * the mockup was signed off on, so it should be assertable without rendering
 * anything. The last one has no heading: an action column labelled "Action"
 * spends a heading saying what the button under it already says.
 */
export const AC_REGISTER_COLUMNS = [
  { key: "status", label: "Status" },
  { key: "document", label: "Document" },
  { key: "type", label: "Type" },
  { key: "op", label: "What was sent" },
  { key: "book", label: "In the book as" },
  { key: "sends", label: "Sends" },
  { key: "when", label: "When" },
  { key: "action", label: "" },
] as const;

/**
 * WHAT AUTOCOUNT ANSWERED WITH, and whether that answer is news.
 *
 * This is the column that earns the table its keep. Since the change written up
 * in `docs/modules/autocount-writeback.md` §7g the ERP sends its OWN number as
 * the document number on all six types, so the book's number and the ERP's
 * number are normally the same string and the cell should be silent. When they
 * differ, the account book has filed the document under a number nobody in this
 * building would recognise — `HC-PO-2608-001` is in `AED_HOUZS` as `PO-009968`,
 * and that went three days unnoticed, because no screen compared the two.
 *
 * FOUR ANSWERS, not two, because "the book has it and we did not write down as
 * what" is a different fact from "the book does not have it", and keeping facts
 * like that apart is the whole job of this page:
 *
 * - `same` — quiet. The number on the paperwork is the number in the book.
 * - `different` — LOUD. Flagged on the row, unclicked.
 * - `not-recorded` — it is in the book and the ERP kept no number for it. NOT
 *   flagged: that is a gap in our record, not a disagreement between two.
 * - `not-yet` — it is not in the book at all, which the Status column has
 *   already said. It must stay quiet; saying it twice is not saying it better.
 */
export type AcBookVerdict = "same" | "different" | "not-recorded" | "not-yet";

export interface AcBookNumber {
  verdict: AcBookVerdict;
  /** What the account book answered with. Null when it has not answered. */
  number: string | null;
  /** Whether the row must be loud about it. True for `different` only. */
  flagged: boolean;
}

/* Trimmed and case-folded: a document number travels as text through two
   systems and a difference of case or a trailing space is not a different
   document. A mismatch this comparison MISSES is far cheaper than one it
   invents — a false flag on a healthy row teaches everyone to ignore the flag,
   and then the real one is invisible too. */
const acSameNumber = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

export function acBookNumber(row: AcOutboxRow): AcBookNumber {
  const answered = row.ac_doc_no === null ? "" : row.ac_doc_no.trim();
  if (answered === "") {
    /* `sent` is the ERP saying the document reached the book, so "not yet"
       would contradict the Status pill sitting on the same row. */
    return {
      verdict: row.state === "sent" ? "not-recorded" : "not-yet",
      number: null,
      flagged: false,
    };
  }
  const same = acSameNumber(answered, row.doc_no);
  return { verdict: same ? "same" : "different", number: answered, flagged: !same };
}

/** The short mark beside a flagged number — it has to fit inside the cell. */
export const AC_BOOK_DIFFERENT_FLAG = "Different number";

/** The whole sentence, for the row's title and for the phone, which has room. */
export function acBookDifferentNote(docNo: string, acDocNo: string): string {
  return `AutoCount filed this under its own number, ${acDocNo}. Anybody looking for`
    + ` ${docNo} in the account book will not find it.`;
}

export const AC_BOOK_NOT_RECORDED_NOTE =
  "It is in the account book, and the ERP kept no note of the number it went in under.";

/**
 * The multiplication mark and a count — when a document has been offered to
 * AutoCount more than once.
 *
 * Blank at one, which is the overwhelming majority: a column printing a 1 on
 * three thousand rows is three thousand characters of ink saying nothing. It
 * counts SENDS, not attempts — `acGroupByDocument` folds an append-only queue
 * into one row per document, and this is the row saying how many it folded.
 */
export function acSendsMark(sends: number): string | null {
  return sends > 1 ? `×${sends}` : null;
}

/** ARRIVED, or last tried. `sent_at` is only ever set once a document is in. */
export const acWhenIso = (row: AcOutboxRow): string | null => row.sent_at ?? row.created_at;

/** The day a row belongs to, in the app's own date rule (`fmtDate`). */
export const acDayKey = (row: AcOutboxRow): string => fmtDate(acWhenIso(row));

/**
 * "21/08 22:04" — the app's date rule with the YEAR taken off.
 *
 * The separator above the row carries the full date, so repeating the year in
 * every cell spends the column's width on four characters that never change.
 * Sliced off `fmtDate`'s own output rather than formatted a second way: ONE
 * rule means the cell and the separator cannot disagree about which day a row
 * is on, which two independent formatters eventually would.
 */
export function acWhenText(row: AcOutboxRow): string {
  const key = acDayKey(row);
  return AC_DMY.test(key) ? `${key.slice(0, 5)} ${fmtTime(acWhenIso(row))}` : AC_NO_VALUE;
}

/** A row whose timestamp cannot be read still belongs somewhere, and it says so
 *  rather than being quietly filed under today. */
export const AC_NO_DAY_LABEL = "No date recorded";

/**
 * "Today · 21/08/2026" / "Yesterday · 20/08/2026" / "19/08/2026".
 *
 * Cheap and quiet by design — a separator that shouts is one more thing between
 * the reader and the row it is introducing. `now` is a parameter so the label is
 * testable without a clock, and so both surfaces bucket against one instant.
 *
 * THE DATE IS NUMERIC, and that is a decision rather than a shortcut. The
 * approved mockup wrote *"Today · 21 Aug"*, and a month ABBREVIATION needs a
 * twelve-name list — which `backend/scripts/check-duplicated-decisions.mjs`
 * correctly refused, because two already exist (`routes/finance.ts`,
 * `routes/projects_print.ts`) and a third home for the Gregorian calendar in a
 * file nothing else imports is exactly the shape that gate watches for. Neither
 * of those can be imported from the frontend, so the honest choices were a third
 * copy on an allowlist or no copy at all.
 *
 * No copy at all is also the more consistent answer: `fmtDate` is THE date
 * format in this app — numeric, unambiguous, DD/MM/YYYY on every other screen —
 * and taking the separator off it means the separator, the When cell and every
 * other date the operator sees are one rule with one implementation. The cost is
 * four characters that read slightly less warmly.
 */
export function acDayLabel(key: string, now: number = Date.now()): string {
  if (!AC_DMY.test(key)) return AC_NO_DAY_LABEL;
  const today = fmtDate(new Date(now));
  if (key === today) return `Today · ${key}`;
  if (key === fmtDate(new Date(now - 86_400_000))) return `Yesterday · ${key}`;
  return key;
}

/**
 * ONE FLAT LIST of separators and documents.
 *
 * Flat because the register is WINDOWED: a separator living outside the
 * virtualiser would either scroll away from its own day or force the whole
 * table back into the DOM, and the second is the defect this page was rebuilt
 * to fix. Both surfaces build the list here, so a day that breaks on the
 * desktop breaks in the same place on the phone.
 */
export type AcRegisterItem =
  | { kind: "day"; key: string; label: string }
  | { kind: "document"; key: string; group: AcDocGroup };

export function acRegisterItems(
  groups: AcDocGroup[],
  now: number = Date.now(),
): AcRegisterItem[] {
  const out: AcRegisterItem[] = [];
  let day: string | null = null;
  for (const g of groups) {
    const key = acDayKey(g.current);
    if (key !== day) {
      day = key;
      /* Prefixed, because `acDocumentKey` is free to produce any string and a
         separator sharing a key with a document would unmount one of them. */
      out.push({ kind: "day", key: `day ${key}`, label: acDayLabel(key, now) });
    }
    out.push({ kind: "document", key: g.key, group: g });
  }
  return out;
}

/** Newest first is the default: a register is read from the top for what has
 *  just happened. The reverse is for reconciling a month from its start. */
export const AC_SORTS = ["newest", "oldest"] as const;
export type AcSort = (typeof AC_SORTS)[number];
export const AC_DEFAULT_SORT: AcSort = "newest";

export const AC_SORT_LABEL: Record<AcSort, string> = {
  newest: "Newest first",
  oldest: "Oldest first",
};

/** The right-hand half of the footer, so nobody has to infer the order from
 *  the rows — which is exactly what a reader does wrong on a filtered list. */
export const AC_SORTED_BY_LINE: Record<AcSort, string> = {
  newest: "Sorted by When, newest first",
  oldest: "Sorted by When, oldest first",
};

/* An unreadable or absent timestamp is treated as oldest — the same convention
   `sendTime` above already uses — so the two orderings in this file cannot
   disagree about a row neither of them can date. */
const acWhenTime = (row: AcOutboxRow): number => {
  const iso = acWhenIso(row);
  const t = iso === null ? NaN : new Date(iso).getTime();
  return Number.isFinite(t) ? t : -Infinity;
};

export function acSortGroups(groups: AcDocGroup[], sort: AcSort): AcDocGroup[] {
  const dir = sort === "newest" ? -1 : 1;
  return [...groups].sort((a, b) => dir * (acWhenTime(a.current) - acWhenTime(b.current)));
}

/**
 * The date lens, beside the document chips.
 *
 * A LENS ON THE LOADED PAGE, exactly like the type strip and for the same
 * reason: the route pages by recency and cannot be asked "how many in August"
 * without every other chip reading zero. So this narrows what is on screen and
 * never what was asked for — which is why `all` is the default. A range that
 * opened on This month would hide a document stuck since July from the one
 * screen whose whole job is finding it.
 */
export const AC_DATE_RANGES = ["all", "today", "week", "month"] as const;
export type AcDateRange = (typeof AC_DATE_RANGES)[number];
export const AC_DEFAULT_DATE_RANGE: AcDateRange = "all";

export const AC_DATE_RANGE_LABEL: Record<AcDateRange, string> = {
  all: "All time",
  today: "Today",
  week: "Last 7 days",
  month: "This month",
};

export function acGroupsInRange(
  groups: AcDocGroup[],
  range: AcDateRange,
  now: number = Date.now(),
): AcDocGroup[] {
  if (range === "all") return groups;
  const today = fmtDate(new Date(now));
  /* Compared as the app's own `dd/mm/yyyy` strings rather than as instants, so
     the range, the day separator and the When cell are one rule and cannot
     disagree at a day boundary. A row whose timestamp cannot be read matches no
     window and is honestly dropped from every range except All time. */
  if (range === "month") {
    const mm = today.slice(3);
    return groups.filter((g) => acDayKey(g.current).slice(3) === mm);
  }
  const days = range === "today" ? 1 : 7;
  const keys = new Set(
    Array.from({ length: days }, (_, i) => fmtDate(new Date(now - i * 86_400_000))),
  );
  return groups.filter((g) => keys.has(acDayKey(g.current)));
}

/**
 * The line that closes the table: how much of the company is on screen.
 *
 * A SECOND sentence beside `acListCountLine`, not a replacement for it. That
 * one sits in the filter strip and answers "how much did the filters leave";
 * this one closes the register and answers "am I looking at all of it" — the
 * question a table is read with, and the one a scrollbar cannot answer honestly
 * in a windowed list, because the scrollbar is drawn from estimates. Both count
 * DOCUMENTS and both say the word.
 */
export function acShowingLine(shown: number, total: number): string {
  const noun = `document${total === 1 ? "" : "s"}`;
  return shown === 0
    ? `Showing none of ${total} ${noun}`
    : `Showing 1–${shown} of ${total} ${noun}`;
}
