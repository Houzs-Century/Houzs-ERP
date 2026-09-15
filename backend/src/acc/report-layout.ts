// ----------------------------------------------------------------------------
// report-layout — a Finance report's LAYOUT: the tree of categories the owner
// arranges over his chart of accounts (owner 2026-09-14: 我想要有 level，父子
// account 分层 … 我要能自己调动排版，然后能自己加大 categories; docs/bugs/0911).
//
// ONE tree per report, SHARED by every company (做公用然后选要不要，类似 chart of
// account): a category carries the ids of the companies that UNTICKED it, and
// an account a company's chart does not carry, or that booked nothing in the
// period, simply never prints there. The tree is presentation only — the
// chart's SECTION still decides which block an account's money belongs to
// (accounting-reports.ts), so a layout can never move a ringgit between gross
// profit and net; it can only group, order and name.
//
// The default tree is the chart's own: a header account (one with children)
// becomes a category named after it, its sub-accounts beneath, the leaves as
// lines; a block that spans more than one section (trading income = SALES +
// SALES ADJUSTMENTS) gets one category per section first. Whatever a stored
// tree does not place — a code created after it was saved, one moved to
// another section on the chart page, one under a category this company
// unticked — prints under "Unassigned" at the block's foot, never vanishes.
//
// Four reports draw on it (docs/bugs/0912 added the last three): the P&L
// (% of sales), the Balance Sheet (% of total assets, both sides), the
// Performance P&L's account part — its other income and its expenses, the
// computed operating expense standing where the account it replaces sits —
// and Receipts & Payments, whose one block is the whole chart laid out twice,
// receipts and payments, each row carrying a figure per money column.
// ----------------------------------------------------------------------------

import { ACCOUNT_SECTIONS, defaultSectionFor } from '../scm/lib/account-sections';

export type ReportKey = 'pnl' | 'balance_sheet' | 'performance' | 'rp';

export type BlockDef = { key: string; title: string; sections: string[] };

const sectionsOfType = (type: string): string[] => ACCOUNT_SECTIONS.filter((s) => s.type === type).map((s) => s.section);
const ALL_SECTIONS: string[] = ACCOUNT_SECTIONS.map((s) => s.section);

/* The blocks a report is made of — the arithmetic's own skeleton, never
   editable. The layout arranges categories INSIDE a block; the sections say
   which accounts' money a block reads. */
export const REPORT_BLOCKS: Record<ReportKey, BlockDef[]> = {
  pnl: [
    { key: 'tradingIncome', title: 'Trading income', sections: ['SALES', 'SALES ADJUSTMENTS'] },
    { key: 'costOfSales', title: 'Cost of sales', sections: ['COST OF GOODS SOLD'] },
    { key: 'otherIncome', title: 'Other income', sections: ['OTHER INCOMES', 'EXTRA-ORDINARY INCOME'] },
    { key: 'expenses', title: 'Expenses', sections: ['EXPENSES'] },
    { key: 'taxation', title: 'Taxation', sections: ['TAXATION'] },
  ],
  balance_sheet: [
    { key: 'assets', title: 'Assets', sections: sectionsOfType('ASSET') },
    { key: 'liabilities', title: 'Liabilities', sections: sectionsOfType('LIABILITY') },
    { key: 'equity', title: 'Equity', sections: sectionsOfType('EQUITY') },
  ],
  performance: [
    { key: 'otherIncome', title: 'Other income', sections: ['OTHER INCOMES', 'EXTRA-ORDINARY INCOME'] },
    { key: 'expenses', title: 'Expenses', sections: ['EXPENSES'] },
  ],
  /* One tree for both sides: a receipt and a payment on the same account
     sit under the same category, whichever way the money moved. */
  rp: [
    { key: 'accounts', title: 'Accounts — receipts and payments', sections: ALL_SECTIONS },
  ],
};

export const isReportKey = (s: unknown): s is ReportKey =>
  typeof s === 'string' && Object.prototype.hasOwnProperty.call(REPORT_BLOCKS, s);

export type LayoutAccount = { kind: 'account'; code: string };
export type LayoutCategory = {
  kind: 'category';
  id: string;
  label: string;
  /** The header account the category was born from (Reset finds it again). */
  code?: string;
  /** Companies that UNTICKED the category — absent means every company shows it. */
  hiddenFor?: number[];
  children: LayoutItem[];
};
export type LayoutItem = LayoutAccount | LayoutCategory;
export type Layout = { version: 1; blocks: Record<string, LayoutItem[]> };

/** One chart definition, as the union across companies hands it over. */
export type ChartAccount = { code: string; name: string; type: string; parentCode: string | null; section: string | null };

export const LAYOUT_MAX_DEPTH = 8;
export const LAYOUT_MAX_ITEMS = 5000;
export const LAYOUT_MAX_LABEL = 80;

const sectionOf = (a: ChartAccount): string => a.section ?? defaultSectionFor(a.type, a.code);
const SECTION_ORDER = new Map(ACCOUNT_SECTIONS.map((s, i) => [s.section, i]));
const bySectionThenCode = (sections: string[]) => (a: ChartAccount, b: ChartAccount): number =>
  ((SECTION_ORDER.get(sectionOf(a)) ?? sections.indexOf(sectionOf(a))) - (SECTION_ORDER.get(sectionOf(b)) ?? sections.indexOf(sectionOf(b))))
  || a.code.localeCompare(b.code);

/* ── The chart's own tree, as a layout ──────────────────────────────────── */
export function defaultLayout(report: ReportKey, accounts: ChartAccount[]): Layout {
  const blocks: Record<string, LayoutItem[]> = {};
  for (const block of REPORT_BLOCKS[report]) {
    const mine = accounts.filter((a) => block.sections.includes(sectionOf(a)));
    const codes = new Set(mine.map((a) => a.code));
    /* A parent outside the block (another section, or gone) makes its child a
       root here — the section, not the chart's parent line, files an account. */
    const under = new Map<string | null, ChartAccount[]>();
    for (const a of mine) {
      const parent = a.parentCode && codes.has(a.parentCode) && a.parentCode !== a.code ? a.parentCode : null;
      const list = under.get(parent) ?? [];
      list.push(a);
      under.set(parent, list);
    }
    for (const list of under.values()) list.sort(bySectionThenCode(block.sections));
    const seen = new Set<string>();
    const build = (a: ChartAccount, depth: number): LayoutItem => {
      seen.add(a.code);
      const kids = (under.get(a.code) ?? []).filter((k) => !seen.has(k.code));
      if (kids.length === 0 || depth >= LAYOUT_MAX_DEPTH - 1) return { kind: 'account', code: a.code };
      return { kind: 'category', id: `acc:${a.code}`, label: a.name, code: a.code, children: kids.map((k) => build(k, depth + 1)) };
    };
    const roots = under.get(null) ?? [];
    if (block.sections.length > 1) {
      /* One category per section, in the chart's order, only where the
         section has anything to show. */
      blocks[block.key] = block.sections
        .map((s) => ({ kind: 'category' as const, id: `sec:${s}`, label: s, children: roots.filter((a) => sectionOf(a) === s).map((a) => build(a, 1)) }))
        .filter((c) => c.children.length > 0);
    } else {
      blocks[block.key] = roots.map((a) => build(a, 0));
    }
  }
  return { version: 1, blocks };
}

/* ── A tree somebody sent, checked and normalised ───────────────────────── */
export type LayoutCheck = { ok: true; layout: Layout } | { ok: false; reason: string };

/* A category id: the default tree names its section layer after the section
   itself ("sec:SALES ADJUSTMENTS", "sec:APPROPRIATION A/C"), so spaces, dots
   and slashes are in — a tree the chart built must always be savable. */
const ID_RE = /^[A-Za-z0-9:_./ -]{1,64}$/;

export function validateLayout(report: ReportKey, raw: unknown): LayoutCheck {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'The layout must be an object.' };
  const top = raw as { version?: unknown; blocks?: unknown };
  if (top.version !== 1) return { ok: false, reason: 'The layout version must be 1.' };
  if (!top.blocks || typeof top.blocks !== 'object' || Array.isArray(top.blocks)) return { ok: false, reason: 'The layout needs its blocks.' };
  const wanted = REPORT_BLOCKS[report].map((b) => b.key);
  const given = Object.keys(top.blocks as object);
  const extra = given.filter((k) => !wanted.includes(k));
  if (extra.length > 0) return { ok: false, reason: `Unknown block: ${extra.join(', ')}.` };
  const ids = new Set<string>();
  const codes = new Set<string>();
  let count = 0;
  const walk = (items: unknown, depth: number, where: string): LayoutItem[] | string => {
    if (!Array.isArray(items)) return `${where}: children must be a list.`;
    if (depth > LAYOUT_MAX_DEPTH) return `${where}: deeper than ${LAYOUT_MAX_DEPTH} levels.`;
    const out: LayoutItem[] = [];
    for (const it of items) {
      count += 1;
      if (count > LAYOUT_MAX_ITEMS) return `More than ${LAYOUT_MAX_ITEMS} items.`;
      if (!it || typeof it !== 'object') return `${where}: an item is not an object.`;
      const o = it as Record<string, unknown>;
      if (o.kind === 'account') {
        const code = typeof o.code === 'string' ? o.code.trim() : '';
        if (!code || code.length > 32) return `${where}: an account needs its code.`;
        if (codes.has(code)) return `${code} is placed twice.`;
        codes.add(code);
        out.push({ kind: 'account', code });
      } else if (o.kind === 'category') {
        const id = typeof o.id === 'string' ? o.id.trim() : '';
        if (!ID_RE.test(id)) return `${where}: a category needs an id (letters, digits, spaces, : _ . / -).`;
        if (ids.has(id)) return `Category id ${id} is used twice.`;
        ids.add(id);
        const label = typeof o.label === 'string' ? o.label.trim() : '';
        if (!label) return `Category ${id} has no name.`;
        if (label.length > LAYOUT_MAX_LABEL) return `Category ${id}: the name is longer than ${LAYOUT_MAX_LABEL} characters.`;
        const code = typeof o.code === 'string' && o.code.trim() ? o.code.trim() : undefined;
        let hiddenFor: number[] | undefined;
        if (o.hiddenFor !== undefined) {
          if (!Array.isArray(o.hiddenFor) || !o.hiddenFor.every((n) => Number.isInteger(n))) return `Category ${id}: hiddenFor must list company ids.`;
          hiddenFor = [...new Set(o.hiddenFor as number[])].sort((a, b) => a - b);
        }
        const children = walk(o.children ?? [], depth + 1, `Category ${label}`);
        if (typeof children === 'string') return children;
        const cat: LayoutCategory = { kind: 'category', id, label, children };
        if (code) cat.code = code;
        if (hiddenFor && hiddenFor.length > 0) cat.hiddenFor = hiddenFor;
        out.push(cat);
      } else {
        return `${where}: an item must be an account or a category.`;
      }
    }
    return out;
  };
  const blocks: Record<string, LayoutItem[]> = {};
  for (const key of wanted) {
    const items = walk((top.blocks as Record<string, unknown>)[key] ?? [], 1, `Block ${key}`);
    if (typeof items === 'string') return { ok: false, reason: items };
    blocks[key] = items;
  }
  return { ok: true, layout: { version: 1, blocks } };
}

/* ── The period's figures, arranged on the tree ─────────────────────────── */
export type LaidLine = {
  code: string;
  name: string;
  amountSen: number;
  /** The row's own key where one code carries several rows (a control
      account by party, a transfer) — the code when absent. */
  key?: string;
  /** What to print instead of "code — name". */
  label?: string;
  /** A figure per money column (Receipts & Payments); amountSen is their total. */
  cells?: Record<string, number>;
};
export type LaidNode = {
  kind: 'category' | 'account' | 'unassigned';
  id: string;
  label: string;
  code?: string;
  /** The row's key on a line (the drill-down's handle). */
  key?: string;
  amountSen: number;
  /** % of the report's base (the P&L: sales; the Balance Sheet: total assets), one decimal; null when there is no base. */
  pct: number | null;
  /** Per-column figures, summed on a category, where the lines carry them. */
  cells?: Record<string, number>;
  children: LaidNode[];
};

/** % of a base, one decimal, null when the base is nothing — the one
    rounding every line, subtotal and total share. */
export const pctOf = (sen: number, baseSen: number | null): number | null =>
  baseSen === null || baseSen === 0 ? null : Math.round((sen / baseSen) * 1000) / 10;

const keyOf = (l: LaidLine): string => l.key ?? l.code;

/** One line as a leaf of the tree. */
export const laidLineNode = (l: LaidLine, baseSen: number | null): LaidNode => {
  const key = keyOf(l);
  const node: LaidNode = {
    kind: 'account', id: `acc:${key}`, label: l.label ?? `${l.code} — ${l.name}`, code: l.code, key,
    amountSen: l.amountSen, pct: pctOf(l.amountSen, baseSen), children: [],
  };
  if (l.cells) node.cells = { ...l.cells };
  return node;
};

const sumCells = (nodes: LaidNode[]): Record<string, number> | undefined => {
  let any = false;
  const out: Record<string, number> = {};
  for (const n of nodes) {
    if (!n.cells) continue;
    any = true;
    for (const [k, v] of Object.entries(n.cells)) out[k] = (out[k] ?? 0) + v;
  }
  return any ? out : undefined;
};

const groupNode = (kind: 'category' | 'unassigned', id: string, label: string, kids: LaidNode[], baseSen: number | null): LaidNode => {
  const amountSen = kids.reduce((s, n) => s + n.amountSen, 0);
  const node: LaidNode = { kind, id, label, amountSen, pct: pctOf(amountSen, baseSen), children: kids };
  const cells = sumCells(kids);
  if (cells) node.cells = cells;
  return node;
};

/**
 * Lay one block's lines (the flat, sectioned figures the report computed)
 * onto that block's tree for ONE company. A category prints only when
 * something under it did (a category with no figures never appears, as on
 * AutoCount's statements); a category this company unticked is skipped
 * with its subtree; every line the tree did not place — new code, moved
 * section, unticked category — goes under "Unassigned" at the foot, so the
 * block's total is always the sum of what is printed. A code that carries
 * several rows (a control account by party, a transfer) prints them all
 * where the code sits.
 */
export function layOutBlock(items: LayoutItem[], lines: LaidLine[], companyId: number, baseSen: number | null): LaidNode[] {
  const byCode = new Map<string, LaidLine[]>();
  for (const l of lines) byCode.set(l.code, [...(byCode.get(l.code) ?? []), l]);
  const placed = new Set<string>();
  const take = (code: string | undefined): LaidNode[] => {
    if (!code) return [];
    const ls = (byCode.get(code) ?? []).filter((l) => !placed.has(keyOf(l)));
    for (const l of ls) placed.add(keyOf(l));
    return ls.map((l) => laidLineNode(l, baseSen));
  };
  const walk = (list: LayoutItem[]): LaidNode[] => {
    const out: LaidNode[] = [];
    for (const it of list) {
      if (it.kind === 'account') {
        out.push(...take(it.code));
        continue;
      }
      if (it.hiddenFor?.includes(companyId)) continue;
      /* A header that booked something itself (older than 父户不记账) prints
         first inside its own category. */
      const kids: LaidNode[] = [...take(it.code), ...walk(it.children)];
      if (kids.length === 0) continue;
      const node = groupNode('category', it.id, it.label, kids, baseSen);
      if (it.code) node.code = it.code;
      out.push(node);
    }
    return out;
  };
  const nodes = walk(items);
  const rest = lines.filter((l) => !placed.has(keyOf(l))).map((l) => laidLineNode(l, baseSen));
  if (rest.length > 0) nodes.push(groupNode('unassigned', 'unassigned', 'Unassigned', rest, baseSen));
  return nodes;
}

/** How deep a laid-out tree goes (1 = only top-level rows) — the L1..Ln buttons. */
export const laidDepth = (nodes: LaidNode[]): number =>
  nodes.reduce((d, n) => Math.max(d, 1 + (n.children.length > 0 ? laidDepth(n.children) : 0)), 0);
