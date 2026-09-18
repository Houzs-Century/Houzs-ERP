// ----------------------------------------------------------------------------
// report-layout — the layout a Finance report is drawn on (owner 2026-09-14,
// docs/bugs/0911: 我想要有 level，父子 account 分层 … 我要能自己调动排版，然后能自己加大
// categories … 做公用然后选要不要，类似 chart of account). The shapes mirror the
// server's acc/report-layout.ts; the reads and writes go to
// /accounting/reports/layout; the pure operations below are what the editor
// does to a tree between opening it and pressing Save — every one returns a
// NEW layout and leaves the one it was given alone.
// ----------------------------------------------------------------------------

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';

export type ReportKey = 'pnl' | 'balance_sheet' | 'performance' | 'rp';

export const REPORT_TITLES: Record<ReportKey, string> = {
  pnl: 'P&L', balance_sheet: 'Balance Sheet', performance: 'Performance P&L', rp: 'Cash Flow',
};

/** Cash Flow: which way a line reads — money in, money out, or in − out. */
export type Flow = 'in' | 'out' | 'net';
/** Cash Flow: a top category's side — it feeds Total Cash In or Total Cash Out. */
export type Side = 'in' | 'out';

export type LayoutAccount = {
  kind: 'account';
  code: string;
  /** Cash Flow only: the line's direction. */
  flow?: Flow;
};
export type LayoutCategory = {
  kind: 'category';
  id: string;
  label: string;
  /** The header account the category was born from. */
  code?: string;
  /** Companies that UNTICKED it — absent means every company shows it. */
  hiddenFor?: number[];
  /** Cash Flow only: a TOP category's side (sub-categories follow their parent). */
  flow?: Side;
  /** Cash Flow only: what the category's subtotal line prints; absent = "Total <label>". */
  totalLabel?: string;
  children: LayoutItem[];
};
/** Cash Flow only: a running-sum line at the top level — everything above it, In less Out. */
export type LayoutSubtotal = { kind: 'subtotal'; id: string; label: string };
export type LayoutItem = LayoutAccount | LayoutCategory | LayoutSubtotal;
export type Layout = { version: 1; blocks: Record<string, LayoutItem[]> };

export type LayoutBlockDef = { key: string; title: string; sections: string[] };
export type LayoutAccountRow = {
  code: string; name: string; type: string; parentCode: string | null; section: string | null;
  perCompany: Partial<Record<number, { active: boolean }>>;
};
export type LayoutCompany = { id: number; code: string };

export type ReportLayoutResponse = {
  report: ReportKey;
  blocks: LayoutBlockDef[];
  stored: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
  layout: Layout;
  companies: LayoutCompany[];
  accounts: LayoutAccountRow[];
};

/** A block of the report as the server laid the period on the tree. */
export type LaidNode = {
  kind: 'category' | 'account' | 'unassigned' | 'subtotal';
  id: string;
  label: string;
  code?: string;
  /** The row's key on a line (Cash Flow: the drill-down's handle). */
  key?: string;
  amountSen: number;
  pct: number | null;
  /** A figure per money column (Cash Flow), summed on a category. */
  cells?: Record<string, number>;
  /** Cash Flow: an account line's direction; a top category's or unassigned group's side. */
  flow?: Flow;
  /** Cash Flow: what a top category's subtotal line prints. */
  totalLabel?: string;
  children: LaidNode[];
};

/** The keys of every line under a node — a category's drill-down is all of its rows. */
export const leafKeys = (n: LaidNode): string[] =>
  n.children.length === 0 ? (n.key ? [n.key] : []) : n.children.flatMap(leafKeys);

/** The account codes a node stands for — its own when it is an account, else
    every account beneath it (the general ledger opens on them; docs/bugs/0924). */
export const leafCodes = (n: LaidNode): string[] =>
  n.kind === 'account' && n.code ? [n.code] : n.children.flatMap(leafCodes);

/** Where the general ledger opens for these accounts and this period. */
export const ledgerHref = (codes: string[], from: string, to: string): string =>
  `/scm/accounting?tab=gl&accounts=${encodeURIComponent(codes.join(','))}&from=${from}&to=${to}`;

/** A laid tree as a flat list with each node's depth — for a CSV, a PDF, or
    a screen that folds by level (a node prints while its depth ≤ the level). */
export type FlatLaid = { node: LaidNode; depth: number };
export const flattenLaid = (nodes: LaidNode[], depth = 1): FlatLaid[] =>
  nodes.flatMap((node) => [{ node, depth }, ...flattenLaid(node.children, depth + 1)]);

/** A line of a flattened tree, as the fold rule reads it. */
export type FoldableLine = { id: string; depth: number };

/** Whether the line at `i` folds lines under it (the next line sits deeper). */
export const foldsChildren = (lines: FoldableLine[], i: number): boolean => {
  return i + 1 < lines.length && lines[i + 1]!.depth > lines[i]!.depth;
};

/** Whether a folder is open: the person's own choice first, else the level
    (L1 shows depth-1 rows folded, All shows everything). */
export const folderOpen = (line: FoldableLine, level: number | 'all', open: Record<string, boolean>): boolean =>
  open[line.id] ?? (level === 'all' || line.depth < level);

/** The lines a screen shows: a line shows while every folder above it is
    open. Depth 0 lines (block titles, totals) are never folded away. */
export const linesVisible = <L extends FoldableLine>(lines: L[], level: number | 'all', open: Record<string, boolean>): L[] => {
  const shown: L[] = [];
  const stack: Array<{ depth: number; open: boolean }> = [];
  lines.forEach((l, i) => {
    while (stack.length > 0 && stack[stack.length - 1]!.depth >= l.depth) stack.pop();
    if (stack.every((s) => s.open)) shown.push(l);
    if (foldsChildren(lines, i)) stack.push({ depth: l.depth, open: folderOpen(l, level, open) });
  });
  return shown;
};

/* ── reads and writes ─────────────────────────────────────────────────────── */

export const useReportLayout = (report: ReportKey, enabled = true) => useQuery({
  queryKey: ['report-layout', report],
  queryFn: () => authedFetch<ReportLayoutResponse>(`/accounting/reports/layout?report=${report}`),
  enabled,
  staleTime: 30_000,
});

type SaveResponse = { ok: boolean; stored: boolean; layout: Layout; updatedAt: string | null; updatedBy: string | null };

/** The report queries that draw on the tree — every one re-reads after a save. */
const REPORT_QUERY_KEYS: Record<ReportKey, string> = {
  pnl: 'report-pnl', balance_sheet: 'report-bs', performance: 'report-performance', rp: 'report-rp',
};

export const useSaveReportLayout = (report: ReportKey) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (layout: Layout) =>
      authedFetch<SaveResponse>(`/accounting/reports/layout?report=${report}`, { method: 'PUT', body: JSON.stringify({ layout }) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['report-layout', report] });
      void qc.invalidateQueries({ queryKey: [REPORT_QUERY_KEYS[report]] });
    },
  });
};

export const useResetReportLayout = (report: ReportKey) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => authedFetch<SaveResponse>(`/accounting/reports/layout?report=${report}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['report-layout', report] });
      void qc.invalidateQueries({ queryKey: [REPORT_QUERY_KEYS[report]] });
    },
  });
};

/* ── figures ──────────────────────────────────────────────────────────────── */

/** % of a base, one decimal, null when there is no base — the server's rounding. */
export const pctOf = (sen: number, baseSen: number | null): number | null =>
  baseSen === null || baseSen === 0 ? null : Math.round((sen / baseSen) * 1000) / 10;

export const fmtPct = (pct: number | null): string => (pct === null ? '—' : `${pct.toFixed(1)}%`);

/** How deep a laid-out tree goes (1 = only top-level rows) — the L1..Ln buttons. */
export const laidDepth = (nodes: LaidNode[]): number =>
  nodes.reduce((d, n) => Math.max(d, 1 + (n.children.length > 0 ? laidDepth(n.children) : 0)), 0);

/* ── the editor's operations ──────────────────────────────────────────────── */

/** One key per item: a category or a subtotal by its id, an account by its
    code — and on the Cash Flow by its direction too, since one account may
    sit twice (its money in, its money out). */
export const accountKey = (code: string, flow?: Flow): string => (flow ? `a:${flow}:${code}` : `a:${code}`);
export const itemKey = (it: LayoutItem): string => (it.kind === 'account' ? accountKey(it.code, it.flow) : it.id);

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

type Located = { list: LayoutItem[]; index: number; item: LayoutItem };

const locate = (items: LayoutItem[], key: string): Located | null => {
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i]!;
    if (itemKey(it) === key) return { list: items, index: i, item: it };
    if (it.kind === 'category') {
      const hit = locate(it.children, key);
      if (hit) return hit;
    }
  }
  return null;
};

const contains = (it: LayoutItem, key: string): boolean =>
  it.kind === 'category' && it.children.some((k) => itemKey(k) === key || contains(k, key));

/** The block that holds the key, or null. */
export const blockOfKey = (layout: Layout, key: string): string | null => {
  for (const [block, items] of Object.entries(layout.blocks)) if (locate(items, key)) return block;
  return null;
};

/** Up or down one place among its siblings; the ends stay put. */
export function moveWithinSiblings(layout: Layout, block: string, key: string, delta: -1 | 1): Layout {
  const next = clone(layout);
  const hit = locate(next.blocks[block] ?? [], key);
  if (!hit) return layout;
  const to = hit.index + delta;
  if (to < 0 || to >= hit.list.length) return layout;
  const [item] = hit.list.splice(hit.index, 1);
  hit.list.splice(to, 0, item!);
  return next;
}

export function renameCategory(layout: Layout, id: string, label: string): Layout {
  const next = clone(layout);
  for (const items of Object.values(next.blocks)) {
    const hit = locate(items, id);
    if (hit && (hit.item.kind === 'category' || hit.item.kind === 'subtotal')) { hit.item.label = label; return next; }
  }
  return layout;
}

/** A new, empty category at the end of the block, or of the parent category. */
export function addCategory(layout: Layout, block: string, parentId: string | null, label: string, id: string): Layout {
  const next = clone(layout);
  const items = next.blocks[block] ?? (next.blocks[block] = []);
  const cat: LayoutCategory = { kind: 'category', id, label, children: [] };
  if (parentId === null) { items.push(cat); return next; }
  const hit = locate(items, parentId);
  if (!hit || hit.item.kind !== 'category') return layout;
  hit.item.children.push(cat);
  return next;
}

/** The category goes; whatever it held takes its place, in order — an
    account is never lost by deleting the shelf it sat on. */
export function removeCategory(layout: Layout, id: string): Layout {
  const next = clone(layout);
  for (const items of Object.values(next.blocks)) {
    const hit = locate(items, id);
    if (hit && hit.item.kind === 'category') {
      hit.list.splice(hit.index, 1, ...hit.item.children);
      return next;
    }
  }
  return layout;
}

/** Tick (shown) or untick (hidden) a category for one company. */
export function setCategoryTick(layout: Layout, id: string, companyId: number, shown: boolean): Layout {
  const next = clone(layout);
  for (const items of Object.values(next.blocks)) {
    const hit = locate(items, id);
    if (!hit || hit.item.kind !== 'category') continue;
    const hidden = new Set(hit.item.hiddenFor ?? []);
    if (shown) hidden.delete(companyId); else hidden.add(companyId);
    if (hidden.size > 0) hit.item.hiddenFor = [...hidden].sort((a, b) => a - b);
    else delete hit.item.hiddenFor;
    return next;
  }
  return layout;
}

export type DropTarget =
  | { kind: 'into'; categoryId: string }   // the last child of that category
  | { kind: 'before'; key: string }        // just above that item
  | { kind: 'end' };                       // the end of the block's top level

/**
 * Put an item somewhere in a block — dragged from elsewhere in the block, or
 * from the block's Unassigned list (then it is not in the tree yet). A
 * category can never be dropped into itself or into anything under it.
 */
export function placeItem(layout: Layout, block: string, item: LayoutItem, target: DropTarget): Layout {
  const key = itemKey(item);
  if (target.kind === 'into' && (target.categoryId === key || contains(item, target.categoryId))) return layout;
  if (target.kind === 'before' && (target.key === key || contains(item, target.key))) return layout;
  /* A subtotal line lives at the top level only — never inside a category. */
  if (item.kind === 'subtotal' && (target.kind === 'into' || (target.kind === 'before' && !(layout.blocks[block] ?? []).some((it) => itemKey(it) === target.key)))) return layout;
  const next = clone(layout);
  const items = next.blocks[block] ?? (next.blocks[block] = []);
  const was = locate(items, key);
  const moving: LayoutItem = was ? was.item : clone(item);
  if (was) was.list.splice(was.index, 1);
  if (target.kind === 'end') { items.push(moving); return next; }
  if (target.kind === 'into') {
    const cat = locate(items, target.categoryId);
    if (!cat || cat.item.kind !== 'category') return layout;
    cat.item.children.push(moving);
    return next;
  }
  const at = locate(items, target.key);
  if (!at) return layout;
  at.list.splice(at.index, 0, moving);
  return next;
}

/** An account leaf out of the tree — it goes back to Unassigned, never away. */
export function unplaceAccount(layout: Layout, block: string, code: string, flow?: Flow): Layout {
  const next = clone(layout);
  const hit = locate(next.blocks[block] ?? [], accountKey(code, flow));
  if (!hit || hit.item.kind !== 'account') return layout;
  hit.list.splice(hit.index, 1);
  return next;
}

/** Every account code the block's tree places — as a leaf or as a category's header. */
const placedCodes = (items: LayoutItem[], into = new Set<string>()): Set<string> => {
  for (const it of items) {
    if (it.kind === 'account') into.add(it.code);
    else if (it.kind === 'category') { if (it.code) into.add(it.code); placedCodes(it.children, into); }
  }
  return into;
};

/** Cash Flow: the account codes whose money on `side` the tree already
    places — an account line reading that way (or Net, which reads both), or a
    category's header account on a top category of that side. */
const placedOnSide = (items: LayoutItem[], wanted: Side): Set<string> => {
  const into = new Set<string>();
  const walk = (list: LayoutItem[], side: Side): void => {
    for (const it of list) {
      if (it.kind === 'subtotal') continue;
      if (it.kind === 'account') { const f = it.flow ?? side; if (f === wanted || f === 'net') into.add(it.code); continue; }
      if (it.code && side === wanted) into.add(it.code);
      walk(it.children, side);
    }
  };
  for (const it of items) if (it.kind === 'category') walk([it], it.flow ?? 'in');
  return into;
};

/** The block's accounts (by the chart's section) the tree does not place —
    what the report prints under Unassigned, and what the editor offers to
    drag in. On the Cash Flow a side is asked for: the accounts whose money
    in (or out) no line reads yet. */
export function unplacedAccounts(layout: Layout, block: LayoutBlockDef, accounts: LayoutAccountRow[], side?: Side): LayoutAccountRow[] {
  const items = layout.blocks[block.key] ?? [];
  const placed = side ? placedOnSide(items, side) : placedCodes(items);
  return accounts
    .filter((a) => a.section !== null && block.sections.includes(a.section) && !placed.has(a.code))
    .sort((a, b) => a.code.localeCompare(b.code));
}

/* ── the Cash Flow's own operations (owner 2026-09-18) ───────────────────── */

/** A top category's side — In feeds Total Cash In, Out feeds Total Cash Out;
    a category deeper down follows its parent, so it is left alone. */
export function setCategoryFlow(layout: Layout, id: string, side: Side): Layout {
  const next = clone(layout);
  for (const items of Object.values(next.blocks)) {
    const top = items.find((it) => it.kind === 'category' && it.id === id);
    if (top && top.kind === 'category') { top.flow = side; return next; }
  }
  return layout;
}

/** What a category's subtotal line prints (Total Cash In, Net Loan …); a
    blank name goes back to "Total <label>". Kept as typed — the server trims. */
export function setTotalLabel(layout: Layout, id: string, label: string): Layout {
  const next = clone(layout);
  for (const items of Object.values(next.blocks)) {
    const hit = locate(items, id);
    if (!hit || hit.item.kind !== 'category') continue;
    if (label.trim()) hit.item.totalLabel = label; else delete hit.item.totalLabel;
    return next;
  }
  return layout;
}

/** An account line's direction: In, Out, or Net (in − out). Its key changes
    with it — one account's In line and Out line are two lines. */
export function setAccountFlow(layout: Layout, block: string, key: string, flow: Flow): Layout {
  const next = clone(layout);
  const hit = locate(next.blocks[block] ?? [], key);
  if (!hit || hit.item.kind !== 'account') return layout;
  hit.item.flow = flow;
  return next;
}

/** A running subtotal at the end of the block's top level — everything above it, In less Out. */
export function addSubtotal(layout: Layout, block: string, label: string, id: string): Layout {
  const next = clone(layout);
  const items = next.blocks[block] ?? (next.blocks[block] = []);
  items.push({ kind: 'subtotal', id, label });
  return next;
}

/** A subtotal line goes; it held nothing. */
export function removeSubtotal(layout: Layout, id: string): Layout {
  const next = clone(layout);
  for (const items of Object.values(next.blocks)) {
    const at = items.findIndex((it) => it.kind === 'subtotal' && it.id === id);
    if (at >= 0) { items.splice(at, 1); return next; }
  }
  return layout;
}

/** A fresh subtotal id — the category scheme, its own prefix. */
export const newSubtotalId = (now = Date.now(), salt = Math.floor(Math.random() * 46_656)): string =>
  `sub:${now.toString(36)}${salt.toString(36).padStart(3, '0')}`;

/** Every category id of a tree — Fold all / Unfold all in the editor. */
export const categoryIds = (layout: Layout): string[] => {
  const out: string[] = [];
  const walk = (items: LayoutItem[]): void => {
    for (const it of items) if (it.kind === 'category') { out.push(it.id); walk(it.children); }
  };
  for (const items of Object.values(layout.blocks)) walk(items);
  return out;
};

/** A fresh category id — time-ordered, never a chart code's shape. */
export const newCategoryId = (now = Date.now(), salt = Math.floor(Math.random() * 46_656)): string =>
  `cat:${now.toString(36)}${salt.toString(36).padStart(3, '0')}`;
