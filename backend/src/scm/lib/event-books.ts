// ----------------------------------------------------------------------------
// event-books.ts — the books on the PMS event page (owner 2026-10-01,
// payment-request item 5: 付款接进这页). PV 批准后，或 AP 单入账后，这笔钱会自动进
// 那场活动；进哪一行，看它记在哪个户口；某一行只要有了入账，就用入账的数字，取代
// 原本手填的或自动算的.
//
// READ LIVE, NEVER COPIED. Every journal leg carrying the event
// (journal_entry_lines.project_id — a voucher or AP invoice line's own leg,
// acc/rules.ts), counted only while its entry is posted and on neither side of
// a reversal pair (acc/reversal-pairs.ts — the rule every statement keeps), net
// Dr − Cr. A cancelled voucher drops out on its own and the typed figure it
// replaced comes back; nothing on the event page has to be told.
//
// THE ROW IS THE ACCOUNT'S. scm.accounts.pms_row (the chart, item 4) names the
// row; an EXPENSE account Finance left without one fills Others Costing; any
// other account without one is not a cost (a refundable deposit is an asset)
// and stays off the page — as on the Event costs report (event-costs.ts).
//
// A ROW THE BOOKS FILL REPLACES that row's typed and auto lines, so a fair is
// never counted twice (typed AND paid). They are set aside, not deleted: the
// payload hands them back as `replaced`, and the page shows them struck out.
// Every reader of finance_lines — the PC snapshot, the phone, the printed
// debrief — therefore sums the books without having to know they exist.
// ----------------------------------------------------------------------------

import { countsInTheBooks } from '../../acc/reversal-pairs';
import { PMS_ROWS, isPmsRow, type PmsRow } from './event-accounts';

/** One tagged leg, as the event page reads it. */
export type BooksLeg = {
  leg_id: string;
  account_code: string;
  debit_sen: number | null;
  credit_sen: number | null;
  notes: string | null;
  je_no: string;
  entry_date: string | null;
  source_type: string | null;
  source_doc_no: string | null;
  posted: boolean | null;
  reversed: boolean | null;
  reversed_by_je: string | null;
  account_name: string | null;
  account_type: string | null;
  pms_row: string | null;
};

export type BooksRead = { ok: true; legs: BooksLeg[] } | { ok: false; reason: string };

/** The event's tagged legs through env.DB, the event page's own connection. A
    failed read is reported, never guessed: the page then shows the typed
    figures and says the books could not be read. */
export async function readEventBooks(db: D1Database, projectId: number, companyId: number | null): Promise<BooksRead> {
  try {
    const res = await db.prepare(
      `SELECT l.id::text AS leg_id, l.account_code, l.debit_sen, l.credit_sen, l.notes,
              je.je_no, to_char(je.entry_date, 'YYYY-MM-DD') AS entry_date, je.source_type, je.source_doc_no,
              je.posted, je.reversed, je.reversed_by_je::text AS reversed_by_je,
              a.account_name, a.account_type, a.pms_row
         FROM scm.journal_entry_lines l
         JOIN scm.journal_entries je ON je.id = l.journal_entry_id
         LEFT JOIN scm.accounts a ON a.company_id = l.company_id AND a.account_code = l.account_code
        WHERE l.project_id = ?${companyId != null ? ' AND l.company_id = ?' : ''}
        ORDER BY je.entry_date, je.je_no, l.line_no`
    ).bind(projectId, ...(companyId != null ? [companyId] : [])).all<BooksLeg>();
    return { ok: true, legs: res.results ?? [] };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** The row a typed or auto category sits in on the event page. COGS and
    Merchandise are rows no account fills; every category without a row of its
    own is Others Costing — the rows of the snapshot this feeds (Projects.tsx,
    NAMED_COSTS), pinned over every picker category by tests/eventBooks.test.ts. */
export function rowOfCategory(category: string | null | undefined): PmsRow | null {
  switch ((category ?? '').trim()) {
    case 'rental': return 'rental';
    case 'setup': return 'setup';
    case 'transport':
    case 'transport_fee': return 'transport_fee';
    case 'transport_setup_dismantle': return 'transport_setup_dismantle';
    case 'commission': return 'commission';
    case 'cogs':
    case 'cogs_matt_sofa':
    case 'cogs_bedframe':
    case 'cogs_accessories':
    case 'merchandise': return null;
    default: return 'others';
  }
}

/** The row a leg fills, or null when it is not an event cost. */
export function rowOfLeg(leg: Pick<BooksLeg, 'pms_row' | 'account_type'>): PmsRow | null {
  if (isPmsRow(leg.pms_row)) return leg.pms_row;
  return String(leg.account_type ?? '').toUpperCase() === 'EXPENSE' ? 'others' : null;
}

/** A stored line's id is positive and a sales entry's is its negation; the
    books run below both. */
const BOOKS_ID_BASE = 1_000_000_000;

/** A leg on the event page: a cost line nobody there can edit, carrying the
    number of the document that posted it. */
export type BooksLine = {
  id: number;
  project_id: number;
  kind: 'cost';
  category: PmsRow;
  description: string;
  amount: number;
  occurred_at: string | null;
  r2_key: null;
  file_name: null;
  mime_type: null;
  notes: null;
  created_by_name: null;
  created_at: string | null;
  archived_at: null;
  auto_source: null;
  source: 'books';
  doc_no: string;
  account_code: string;
  account_name: string | null;
};

export function booksLinesFor(projectId: number, legs: BooksLeg[]): BooksLine[] {
  const out: BooksLine[] = [];
  for (const leg of legs) {
    if (!countsInTheBooks(leg)) continue;
    const row = rowOfLeg(leg);
    if (!row) continue;
    out.push({
      id: -(BOOKS_ID_BASE + out.length),
      project_id: projectId,
      kind: 'cost',
      category: row,
      description: leg.notes?.trim() || leg.account_name || leg.account_code,
      amount: (Number(leg.debit_sen ?? 0) - Number(leg.credit_sen ?? 0)) / 100,
      occurred_at: leg.entry_date,
      r2_key: null,
      file_name: null,
      mime_type: null,
      notes: null,
      created_by_name: null,
      created_at: leg.entry_date,
      archived_at: null,
      auto_source: null,
      source: 'books',
      doc_no: leg.source_doc_no || leg.je_no,
      account_code: leg.account_code,
      account_name: leg.account_name,
    });
  }
  return out;
}

type LedgerLine = { kind?: string | null; category?: string | null; source?: string | null };

export type EventBooks<L> = {
  ok: boolean;
  /** Why the ledger could not be read — the page's figures are the typed ones. */
  reason: string | null;
  /** The rows the books fill, in the page's order. */
  rows: PmsRow[];
  /** Picker categories whose row the books fill — a line typed there would not count. */
  closed_categories: string[];
  /** The typed and auto lines the books replaced, kept aside. */
  replaced: L[];
};

/** The event page's lines with the books in: each row the books fill gives
    up its typed and auto lines, and the books' own lines join the rest. */
export function applyEventBooks<L extends LedgerLine>(
  projectId: number,
  ledger: L[],
  read: BooksRead,
  pickerCategories: readonly string[],
): { lines: Array<L | BooksLine>; books: EventBooks<L> } {
  if (!read.ok) {
    return { lines: ledger, books: { ok: false, reason: read.reason, rows: [], closed_categories: [], replaced: [] } };
  }
  const booksLines = booksLinesFor(projectId, read.legs);
  const filled = new Set<PmsRow>(booksLines.map((l) => l.category));
  const isFilled = (category: string | null | undefined) => {
    const row = rowOfCategory(category);
    return row != null && filled.has(row);
  };
  const kept: L[] = [];
  const replaced: L[] = [];
  for (const line of ledger) {
    if (line.kind === 'cost' && !line.source && isFilled(line.category)) replaced.push(line);
    else kept.push(line);
  }
  return {
    lines: [...kept, ...booksLines],
    books: {
      ok: true,
      reason: null,
      rows: PMS_ROWS.filter((r) => filled.has(r)),
      closed_categories: pickerCategories.filter((c) => isFilled(c)),
      replaced,
    },
  };
}
