// ----------------------------------------------------------------------------
// EventPnlTable — the event's TWO P&Ls side by side (owner 2026-10-16: 「这样下面
// 的 P&L 就要分成两个了，一个是我的 total sales 的，一个是根据 SO 的」).
//
// Every figure is the server's (services/eventPnl.ts); this only lays them out
// and lets the typed rows be set, exactly as the single snapshot did: a typed
// row (Rental, Setup, Transport S&D, the COGS rows) is clicked in the Total
// Sales column and saving consolidates that category into one line. The Sales
// Orders column is never typed into — it is what the orders say.
// ----------------------------------------------------------------------------

import { useState } from "react";
import { cn, formatCurrency } from "../../lib/utils";
import type { EventPnl, PnlColumn, PnlPctRow } from "./types";

type Editable = { onSave: (n: number) => Promise<void> } | undefined;

const pct = (n: number): string => `${Number.isInteger(n) ? n.toFixed(0) : String(n)}%`;

/** Where a % row's figure came from, in a few words. */
function pctNote(r: PnlPctRow & { boost?: boolean }): string | undefined {
  if (r.from === "books") return "入账";
  if (r.from === "typed") return "typed";
  if (r.from === "rate" && r.pct != null) return `${pct(r.pct)} of sales${r.boost ? " · boost" : ""}`;
  return undefined;
}

function cogsNote(c: PnlColumn, so: PnlColumn | null): string | undefined {
  if (c.cogs.from === "typed") return "typed";
  if (c.cogs.from === "so") return "orders' cost";
  if (c.cogs.from === "so_ratio" && so && so.sales > 0) {
    return `est. at the orders' cost ${((so.cogs.total / so.sales) * 100).toFixed(1)}%`;
  }
  return undefined;
}

const SALES_FROM: Record<PnlColumn["salesFrom"], string | undefined> = {
  box: "Total Sales box",
  lines: "sales entries",
  so: "orders' total (box empty)",
  none: undefined,
};

function Cell({ value, note, editable, busy, tone, bold }: {
  value: number | null;
  note?: string;
  editable?: Editable;
  busy?: boolean;
  tone?: "synced" | "err";
  bold?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  if (value == null) {
    return (
      <td className="px-3 py-1.5 text-right align-top font-mono text-ink-muted">
        —{note && <div className="text-[9.5px]">{note}</div>}
      </td>
    );
  }
  async function commit() {
    if (!editable) return;
    const n = parseFloat(draft.replace(/,/g, ""));
    setEditing(false);
    if (!Number.isFinite(n) || n < 0 || Math.abs(n - (value ?? 0)) < 0.005) return;
    await editable.onSave(n);
  }
  return (
    <td
      className={cn("px-3 py-1.5 text-right align-top", editable && !editing && !busy && "cursor-pointer hover:bg-accent-soft/30")}
      onClick={editable && !editing ? () => { setDraft(value > 0 ? String(value) : ""); setEditing(true); } : undefined}
      title={editable ? "Click to edit" : undefined}
    >
      {editing ? (
        <input
          type="number" step="0.01" min="0" autoFocus value={draft}
          onChange={(e) => setDraft(e.target.value)} onBlur={commit} onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => { if (e.key === "Enter") void commit(); else if (e.key === "Escape") setEditing(false); }}
          className="w-28 rounded border border-accent bg-surface px-2 py-0.5 text-right font-mono tabular-nums outline-none"
          aria-label="Amount"
        />
      ) : (
        <span className={cn("font-mono tabular-nums", bold && "font-bold", tone === "synced" && "text-synced", tone === "err" && "text-err", !tone && "text-ink", busy && "opacity-50")}>
          {busy ? "…" : formatCurrency(value)}
        </span>
      )}
      {note && !editing && <div className="font-mono text-[9.5px] text-ink-muted">{note}</div>}
    </td>
  );
}

export function EventPnlTable({ pnl, editable, busyCategory, books, rentalNote }: {
  pnl: EventPnl;
  /** The typed row's save, or undefined when the books fill it. */
  editable: (category: string, row: string) => Editable;
  busyCategory: string | null;
  /** Rows the books fill. */
  books: ReadonlySet<string>;
  rentalNote?: string;
}) {
  const a = pnl.by_sales;
  const b = pnl.by_so;
  const row = (label: string, pick: (c: PnlColumn) => number, opts: {
    category?: string; bookRow?: string; noteA?: string; noteB?: string; sub?: boolean; indent?: boolean; tone?: (n: number) => "synced" | "err" | undefined;
  } = {}) => {
    const va = pick(a);
    const vb = b ? pick(b) : null;
    return (
      <tr key={label} className={cn("border-b border-border-subtle", opts.sub && "bg-bg/50")}>
        <th scope="row" className={cn("py-1.5 text-left font-normal", opts.indent ? "pl-8 pr-3" : "px-4", opts.sub ? "font-bold text-ink" : "text-ink-secondary")}>
          {label}
          {opts.bookRow && books.has(opts.bookRow) && (
            <span className="ml-1.5 rounded bg-accent-soft px-1 py-px text-[10px] font-semibold text-accent" title="From the books — Finance's figure replaces the typed one">入账</span>
          )}
        </th>
        <Cell value={va} note={opts.noteA} bold={opts.sub} tone={opts.tone?.(va)}
          editable={opts.category ? editable(opts.category, opts.bookRow ?? opts.category) : undefined}
          busy={!!opts.category && busyCategory === opts.category} />
        <Cell value={vb} note={opts.noteB} bold={opts.sub} tone={vb == null ? undefined : opts.tone?.(vb)} />
      </tr>
    );
  };
  const profitTone = (n: number): "synced" | "err" => (n >= 0 ? "synced" : "err");
  const gp = (c: PnlColumn | null) => (c && c.sales > 0 ? ` (${((c.grossProfit / c.sales) * 100).toFixed(1)}%)` : "");
  const np = (c: PnlColumn | null) => (c && c.sales > 0 ? `${((c.netProfit / c.sales) * 100).toFixed(1)}% bottom line` : undefined);
  const showOther = a.cogs.other !== 0 || (b?.cogs.other ?? 0) !== 0;

  return (
    <table className="w-full text-[12px]">
      <thead>
        <tr className="border-b border-border text-left font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
          <th scope="col" className="px-4 py-1.5"> </th>
          <th scope="col" className="px-3 py-1.5 text-right">By Total Sales</th>
          <th scope="col" className="px-3 py-1.5 text-right">
            By Sales Orders{pnl.so_count > 0 ? ` (${pnl.so_count})` : ""}
          </th>
        </tr>
      </thead>
      <tbody>
        {row("Total Sales", (c) => c.sales, { noteA: SALES_FROM[a.salesFrom], noteB: b ? undefined : "no order opened", sub: true })}
        {row("COGS — Matt/Sofa", (c) => c.cogs.mattSofa, { category: "cogs_matt_sofa", indent: true })}
        {row("COGS — Bedframe", (c) => c.cogs.bedframe, { category: "cogs_bedframe", indent: true })}
        {row("COGS — Accessories", (c) => c.cogs.accessories, { category: "cogs_accessories", indent: true })}
        {showOther && row("COGS — Other", (c) => c.cogs.other, { indent: true })}
        {row("COGS Total", (c) => c.cogs.total, { sub: true, noteA: cogsNote(a, b), noteB: b ? cogsNote(b, b) : undefined })}
        {row("Gross Profit", (c) => c.grossProfit, { sub: true, tone: profitTone, noteA: gp(a).trim() || undefined, noteB: gp(b).trim() || undefined })}
        {row("Rental", (c) => c.rental, { category: "rental", bookRow: "rental", noteA: rentalNote })}
        {row("Setup", (c) => c.setup, { category: "setup", bookRow: "setup" })}
        {row("Transport Fee", (c) => c.transportFee.amount, { bookRow: "transport_fee", noteA: pctNote(a.transportFee), noteB: b ? pctNote(b.transportFee) : undefined })}
        {row("Transport Setup & Dismantle", (c) => c.transportSetupDismantle, { category: "transport_setup_dismantle", bookRow: "transport_setup_dismantle" })}
        {row("Commission", (c) => c.commission.amount, { bookRow: "commission", noteA: pctNote(a.commission), noteB: b ? pctNote(b.commission) : undefined })}
        {row("Merchandise", (c) => c.merchandise.amount, { noteA: pctNote(a.merchandise), noteB: b ? pctNote(b.merchandise) : undefined })}
        {row("Others Costing", (c) => c.others, { bookRow: "others" })}
        {row("Total Cost", (c) => c.totalCost, { sub: true })}
        {row("Net Profit", (c) => c.netProfit, { sub: true, tone: profitTone, noteA: np(a), noteB: np(b) })}
      </tbody>
    </table>
  );
}
