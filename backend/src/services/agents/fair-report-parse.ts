// ----------------------------------------------------------------------------
// fair-report-parse.ts — PMS Roadshow Agent (Job B): parse an owner's FAIR
// REPORT worksheet into the per-event P&L the agent fills into a project.
//
// The FAIR REPORT (owner's "raw data") is one worksheet PER EVENT, named
// `<date><BRAND>@<VENUE>` (e.g. "19-2411AKEMI@SUTERA MALL"). Each sheet lists
// one row PER ORDER with the columns (labels live across a 2-row header):
//   AMOUNT (list) · MATTRESS (cost) · BEDFRAME (cost) · ACCESSORIES · SELLING
//   (the ACTUAL sold price = revenue) · MARGIN · payment split · SALES PERSON
//
// Column semantics were VERIFIED against the report's own MARGIN column:
// for every order, MARGIN == (SELLING - (MATTRESS + BEDFRAME)) / SELLING, which
// pins revenue = SELLING, product COGS = MATTRESS (matt/sofa) + BEDFRAME. See
// fair-report-parse.test.ts, which asserts this on the real figures.
//
// This module is PURE (cell arrays in, structured event out) so it is unit-
// tested with no DB. The frontend reads the .xlsx with SheetJS and hands each
// sheet's rows here; the caller then matches the event to a `projects` row and
// writes `project_finance_lines` via createLedgerLine (gated by the PMS agent's
// autonomy stage). This module writes NOTHING.
//
// COGS categories map 1:1 to the system's LEDGER_COST_CATEGORIES:
//   SELLING     -> income  / sales
//   MATTRESS    -> cost    / cogs_matt_sofa
//   BEDFRAME    -> cost    / cogs_bedframe
//   ACCESSORIES -> cost    / cogs_accessories   (see ACCESSORIES note below)
// rental / setup are NOT in these detail sheets (they come from the setup
// invoice, Job E) and transport/commission/merchandise are auto-derived by the
// existing recomputeAutoCostLines engine — so this parser never emits them.
// ----------------------------------------------------------------------------

export type Cell = string | number | null | undefined;
export type SheetRows = Cell[][];

export interface SalespersonTotal {
  name: string;
  sales: number; // whole RM (SELLING summed for this person)
}

export interface FairEvent {
  brand: string;
  venue: string;
  /** First / last order date seen in the sheet, as printed (e.g. "27/6"). */
  dateFirst: string | null;
  dateLast: string | null;
  orders: number;
  sales: number;            // revenue = sum(SELLING), whole RM
  cogsMattSofa: number;     // sum(MATTRESS)
  cogsBedframe: number;     // sum(BEDFRAME)
  cogsAccessories: number;  // sum(ACCESSORIES cost)
  salespeople: SalespersonTotal[];
}

export interface FinanceLine {
  kind: 'income' | 'cost';
  category: string;
  amount: number; // whole RM, non-negative
}

const norm = (v: Cell): string => (v == null ? '' : String(v).trim());
const up = (v: Cell): string => norm(v).toUpperCase();

/** Parse a money cell to a finite non-negative number; blank / junk -> 0. */
export function num(v: Cell): number {
  if (v == null || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Split a sheet NAME "<date><BRAND>@<VENUE>" into brand + venue. The brand is
 *  the text before '@' with any leading date digits/hyphens stripped
 *  ("27-296AKEMI" -> "AKEMI"); venue is the text after '@'. */
export function parseSheetName(name: string): { brand: string; venue: string } {
  const at = name.indexOf('@');
  if (at < 0) return { brand: '', venue: norm(name) };
  const left = name.slice(0, at);
  const brand = left.replace(/^[0-9\-]+/, '').trim().toUpperCase();
  const venue = name.slice(at + 1).trim().toUpperCase();
  return { brand, venue };
}

interface Cols {
  selling: number; mattress: number; bedframe: number; accessories: number;
  salesperson: number; date: number;
}

/** Locate the columns by scanning the header band (first ~6 rows) for labels.
 *  Returns -1 for any column not found. ACCESSORIES takes the FIRST match
 *  (the cost column; a second ACCESSORIES column, when present, is the
 *  accessories selling price and is intentionally ignored here). */
export function findColumns(rows: SheetRows): Cols {
  const cols: Cols = { selling: -1, mattress: -1, bedframe: -1, accessories: -1, salesperson: -1, date: -1 };
  const band = rows.slice(0, 6);
  for (const row of band) {
    for (let j = 0; j < row.length; j++) {
      const c = up(row[j]);
      if (!c) continue;
      if (cols.selling < 0 && c === 'SELLING') cols.selling = j;
      if (cols.mattress < 0 && c === 'MATTRESS') cols.mattress = j;
      if (cols.bedframe < 0 && c === 'BEDFRAME') cols.bedframe = j;
      if (cols.accessories < 0 && c === 'ACCESSORIES') cols.accessories = j;
      if (cols.salesperson < 0 && (c === 'SALES PERSON' || c === 'SALESPERSON')) cols.salesperson = j;
      if (cols.date < 0 && c === 'DATE') cols.date = j;
    }
  }
  return cols;
}

/** Parse one event worksheet into its aggregated P&L. Returns null when the
 *  sheet has no recognisable SELLING column or no order rows (blank / non-data
 *  tabs degrade to skipped, never a throw). */
export function parseFairSheet(name: string, rows: SheetRows): FairEvent | null {
  const cols = findColumns(rows);
  if (cols.selling < 0) return null;

  const { brand, venue } = parseSheetName(name);
  const byPerson = new Map<string, number>();
  let sales = 0, cogsMattSofa = 0, cogsBedframe = 0, cogsAccessories = 0, orders = 0;
  let dateFirst: string | null = null, dateLast: string | null = null;

  for (const row of rows) {
    const selling = num(row[cols.selling]);
    if (selling <= 0) continue; // not an order row (header / total / blank)
    orders += 1;
    sales += selling;
    if (cols.mattress >= 0) cogsMattSofa += num(row[cols.mattress]);
    if (cols.bedframe >= 0) cogsBedframe += num(row[cols.bedframe]);
    if (cols.accessories >= 0) cogsAccessories += num(row[cols.accessories]);
    if (cols.salesperson >= 0) {
      const who = norm(row[cols.salesperson]).toUpperCase();
      if (who) byPerson.set(who, (byPerson.get(who) ?? 0) + selling);
    }
    if (cols.date >= 0) {
      const d = norm(row[cols.date]);
      if (d) { if (dateFirst == null) dateFirst = d; dateLast = d; }
    }
  }

  if (orders === 0) return null;

  const salespeople = [...byPerson.entries()]
    .map(([name2, s]) => ({ name: name2, sales: Math.round(s) }))
    .sort((a, b) => b.sales - a.sales);

  return {
    brand, venue, dateFirst, dateLast, orders,
    sales: Math.round(sales),
    cogsMattSofa: Math.round(cogsMattSofa),
    cogsBedframe: Math.round(cogsBedframe),
    cogsAccessories: Math.round(cogsAccessories),
    salespeople,
  };
}

/** The finance lines the agent proposes for an event: revenue + the three
 *  product-COGS categories. Zero-value categories are dropped (no empty line).
 *  Amounts are whole RM to match project_finance_lines (NOT sen). */
export function eventToFinanceLines(ev: FairEvent): FinanceLine[] {
  const lines: FinanceLine[] = [];
  if (ev.sales > 0) lines.push({ kind: 'income', category: 'sales', amount: ev.sales });
  if (ev.cogsMattSofa > 0) lines.push({ kind: 'cost', category: 'cogs_matt_sofa', amount: ev.cogsMattSofa });
  if (ev.cogsBedframe > 0) lines.push({ kind: 'cost', category: 'cogs_bedframe', amount: ev.cogsBedframe });
  if (ev.cogsAccessories > 0) lines.push({ kind: 'cost', category: 'cogs_accessories', amount: ev.cogsAccessories });
  return lines;
}
