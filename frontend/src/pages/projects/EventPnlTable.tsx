// ----------------------------------------------------------------------------
// EventPnlTable — the event's TWO P&Ls side by side (owner 2026-10-16: 「这样下面
// 的 P&L 就要分成两个了，一个是我的 total sales 的，一个是根据 SO 的」).
//
// Every figure is the server's (services/eventPnl.ts); this only lays them out
// and lets the typed rows be set, exactly as the single snapshot did: a typed
// row (Rental, Setup, Transport S&D, the COGS rows) is clicked in the Total
// Sales column and saving consolidates that category into one line. The Sales
// Orders column is never typed into — it is what the orders say.
//
// THREE LAYERS (owner 2026-11-18, forecastLayers.ts): when the server sends
// `layers`, the Total Sales column shows each line's best figure so far — the
// actual, else the typed Forecast, else the last same-organiser-venue-and-brand
// event's actual — tagged "Forecast" / "Last event", and its totals say when
// they include an estimate. A line's label opens its Forecast to set or clear.
// ----------------------------------------------------------------------------

import { useState } from "react";
import { cn, formatCurrency } from "../../lib/utils";
import type { EventPnl, PnlColumn, PnlPctRow } from "./types";
import { ESTIMATE_NOTE, FORECAST_LINE_LABELS, parseForecastInput, sourceTag, type DetailForecast, type ForecastLine, type LineSource } from "./forecastLayers";

type Editable = { onSave: (n: number) => Promise<void> } | undefined;

const pct = (n: number): string => `${Number.isInteger(n) ? n.toFixed(0) : String(n)}%`;

/** Where a % row's figure came from, in a few words. */
function pctNote(r: PnlPctRow & { boost?: boolean }): string | undefined {
  if (r.from === "books") return "booked";
  if (r.from === "typed") return "typed";
  if (r.from === "rate" && r.pct != null) return `${pct(r.pct)} of sales${r.boost ? " · boost" : ""}`;
  return undefined;
}

/** The rate-card note, plus the orders' service cost the row carries. */
function transportNote(r: PnlPctRow & { serviceCost: number }): string | undefined {
  const base = pctNote(r);
  if (!r.serviceCost) return base;
  const svc = `incl. RM ${r.serviceCost.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} service cost`;
  return base ? `${base} · ${svc}` : svc;
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

/** The layer tag under a figure: muted for the last event, warm for a forecast. */
export function SourceTag({ source }: { source: LineSource }) {
  const label = sourceTag(source);
  if (!label) return null;
  return (
    <span
      className={cn(
        "ml-1 inline-block rounded px-1 py-px font-sans text-[9.5px] font-semibold",
        "bg-warning-bg text-warning-text",
      )}
      title={source === "forecast" ? "Forecast typed for this line, until the real figure is in" : "Forecast from the last event with the same organiser, venue and brand (its actual), until the real figure is in"}
    >
      {label}
    </span>
  );
}

/** Set or clear one line's Forecast, inline under its label. Shows its failure. */
function ForecastEditor({ line, current, onForecast }: {
  line: ForecastLine;
  current: number | null;
  onForecast: (line: ForecastLine, amount: number | null) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(amount: number | null) {
    setBusy(true);
    setError(null);
    try {
      await onForecast(line, amount);
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The forecast was not saved.");
    } finally {
      setBusy(false);
    }
  }
  function save() {
    const parsed = parseForecastInput(draft);
    if (!parsed.ok) { setError(parsed.error); return; }
    void run(parsed.amount);
  }
  if (!open) {
    return (
      <button
        type="button"
        className="ml-1.5 rounded px-1 text-[10px] font-semibold text-accent hover:bg-accent-soft/40"
        onClick={() => { setDraft(current != null ? String(current) : ""); setError(null); setOpen(true); }}
        title="Set or clear the Forecast for this line"
      >
        {current != null ? `Forecast ${formatCurrency(current)}` : "+ Forecast"}
      </button>
    );
  }
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5 font-normal">
      <input
        type="text" inputMode="decimal" autoFocus value={draft} disabled={busy}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") save(); else if (e.key === "Escape") setOpen(false); }}
        className="w-28 rounded border border-accent bg-surface px-2 py-0.5 text-right font-mono tabular-nums outline-none"
        aria-label="Forecast amount" placeholder="RM"
      />
      <button type="button" disabled={busy} onClick={save} className="rounded bg-accent px-2 py-0.5 text-[11px] font-semibold text-white disabled:opacity-50">Save</button>
      {current != null && <button type="button" disabled={busy} onClick={() => void run(null)} className="rounded border border-border px-2 py-0.5 text-[11px] disabled:opacity-50">Clear</button>}
      <button type="button" disabled={busy} onClick={() => setOpen(false)} className="px-1 text-[11px] text-ink-muted">Cancel</button>
      {error && <div role="alert" className="w-full text-[11px] text-err">{error}</div>}
    </div>
  );
}

function Cell({ value, note, editable, busy, tone, bold, source, draftFrom }: {
  value: number | null;
  note?: string;
  editable?: Editable;
  busy?: boolean;
  tone?: "synced" | "err";
  bold?: boolean;
  /** The layer the shown figure came from; an actual shows no tag. */
  source?: LineSource;
  /** What the typed-row editor starts from (the actual, not an estimate). */
  draftFrom?: number;
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
      onClick={editable && !editing ? () => { const v = draftFrom ?? value; setDraft(v > 0 ? String(v) : ""); setEditing(true); } : undefined}
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
      {source && !editing && <SourceTag source={source} />}
      {note && !editing && <div className="font-mono text-[9.5px] text-ink-muted">{note}</div>}
    </td>
  );
}

type TotalKey = keyof DetailForecast["totals"];

export function EventPnlTable({ pnl, editable, busyCategory, books, rentalNote, layers, onForecast }: {
  pnl: EventPnl;
  /** The three layers over the Total Sales column; null = actuals only. */
  layers: DetailForecast | null;
  /** Set / clear a line's Forecast; null when the caller may not. */
  onForecast: ((line: ForecastLine, amount: number | null) => Promise<void>) | null;
  /** The typed row's save, or undefined when the books fill it. */
  editable: (category: string, row: string) => Editable;
  busyCategory: string | null;
  /** Rows the books fill. */
  books: ReadonlySet<string>;
  rentalNote?: string;
}) {
  const a = pnl.by_sales;
  const b = pnl.by_so;
  /* Every Forecast at once, one Save (owner 2026-11-20: 不能放完figure了 全部一次save？).
     null = not editing; else the draft per line, prefilled with today's Forecast. */
  const [batch, setBatch] = useState<Partial<Record<ForecastLine, string>> | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchErr, setBatchErr] = useState<string | null>(null);
  const canBatch = !!layers && !!onForecast;
  function startBatch() {
    if (!layers) return;
    const draft: Partial<Record<ForecastLine, string>> = {};
    for (const [k, v] of Object.entries(layers.lines) as Array<[ForecastLine, { forecast: number | null }]>) {
      draft[k] = v.forecast != null ? String(v.forecast) : "";
    }
    setBatchErr(null);
    setBatch(draft);
  }
  async function saveBatch() {
    if (!batch || !layers || !onForecast) return;
    const changes: Array<[ForecastLine, number | null]> = [];
    for (const [k, text] of Object.entries(batch) as Array<[ForecastLine, string]>) {
      const parsed = parseForecastInput(text ?? "");
      if (!parsed.ok) { setBatchErr(`${FORECAST_LINE_LABELS[k]}: ${parsed.error}`); return; }
      if (parsed.amount !== layers.lines[k].forecast) changes.push([k, parsed.amount]);
    }
    setBatchBusy(true);
    setBatchErr(null);
    const failed: string[] = [];
    for (const [k, amount] of changes) {
      try { await onForecast(k, amount); } catch (e) {
        failed.push(`${FORECAST_LINE_LABELS[k]}: ${e instanceof Error ? e.message : "not saved"}`);
      }
    }
    setBatchBusy(false);
    if (failed.length > 0) setBatchErr(`Not saved - ${failed.join("; ")}`);
    else setBatch(null);
  }
  const row = (label: string, pick: (c: PnlColumn) => number, opts: {
    category?: string; bookRow?: string; noteA?: string; noteB?: string; sub?: boolean; indent?: boolean; tone?: (n: number) => "synced" | "err" | undefined;
    line?: ForecastLine; total?: TotalKey;
  } = {}) => {
    const actualA = pick(a);
    const layered = layers && opts.line ? layers.lines[opts.line] : null;
    const total = layers && opts.total ? layers.totals[opts.total] : null;
    const va = layered ? layered.amount : total ? total.amount : actualA;
    const noteA = total?.estimated ? [opts.noteA, ESTIMATE_NOTE].filter(Boolean).join(" · ") : layered && layered.source !== "actual" ? undefined : opts.noteA;
    const vb = b ? pick(b) : null;
    return (
      <tr key={label} className={cn("border-b border-border-subtle", opts.sub && "bg-bg/50")}>
        <th scope="row" className={cn("py-1.5 text-left font-normal", opts.indent ? "pl-8 pr-3" : "px-4", opts.sub ? "font-bold text-ink" : "text-ink-secondary")}>
          {label}
          {opts.bookRow && books.has(opts.bookRow) && (
            <span className="ml-1.5 rounded bg-accent-soft px-1 py-px text-[10px] font-semibold text-accent" title="From the books — Finance's figure replaces the typed one">Booked</span>
          )}
          {layers && opts.line && onForecast && batch && (
            <div className="mt-1 font-normal">
              <input
                type="text" inputMode="decimal" disabled={batchBusy} value={batch[opts.line] ?? ""}
                onChange={(e) => { const v = e.target.value; const k = opts.line as ForecastLine; setBatch((d) => (d ? { ...d, [k]: v } : d)); }}
                onKeyDown={(e) => { if (e.key === "Enter") void saveBatch(); }}
                className="w-28 rounded border border-accent bg-surface px-2 py-0.5 text-right font-mono tabular-nums outline-none"
                aria-label={`${label} forecast`} placeholder="Forecast RM"
              />
            </div>
          )}
          {layers && opts.line && onForecast && !batch && (
            <ForecastEditor line={opts.line} current={layers.lines[opts.line].forecast} onForecast={onForecast} />
          )}
        </th>
        <Cell value={va} note={noteA} bold={opts.sub} tone={opts.tone?.(va)}
          editable={opts.category ? editable(opts.category, opts.bookRow ?? opts.category) : undefined}
          busy={!!opts.category && busyCategory === opts.category}
          source={layered?.source} draftFrom={actualA} />
        <Cell value={vb} note={opts.noteB} bold={opts.sub} tone={vb == null ? undefined : opts.tone?.(vb)} />
      </tr>
    );
  };
  const profitTone = (n: number): "synced" | "err" => (n >= 0 ? "synced" : "err");
  /* The Total Sales column's own figures — the layered ones when sent. */
  const salesA = layers ? layers.lines.sales.amount : a.sales;
  const gpA = layers ? layers.totals.gross_profit.amount : a.grossProfit;
  const npA = layers ? layers.totals.net_profit.amount : a.netProfit;
  const gpOf = (sales: number, g: number) => (sales > 0 ? `(${((g / sales) * 100).toFixed(1)}%)` : undefined);
  const npOf = (sales: number, n: number) => (sales > 0 ? `${((n / sales) * 100).toFixed(1)}% bottom line` : undefined);
  const showOther = a.cogs.other !== 0 || (b?.cogs.other ?? 0) !== 0;

  return (
    <>
    {canBatch && (
      <div className="flex flex-wrap items-center gap-2 border-b border-border-subtle px-4 py-2 text-[12px]">
        {batch ? (
          <>
            <span className="text-ink-secondary">Type every Forecast, then save once. Leave a box empty to clear it.</span>
            <button type="button" disabled={batchBusy} onClick={() => void saveBatch()} className="ml-auto rounded bg-accent px-3 py-1 font-semibold text-white disabled:opacity-50">
              {batchBusy ? "Saving..." : "Save all"}
            </button>
            <button type="button" disabled={batchBusy} onClick={() => { setBatch(null); setBatchErr(null); }} className="rounded border border-border px-3 py-1">Cancel</button>
          </>
        ) : (
          <button type="button" onClick={startBatch} className="ml-auto rounded border border-accent px-3 py-1 font-semibold text-accent hover:bg-accent-soft/40">Edit all forecasts</button>
        )}
        {batchErr && <div role="alert" className="w-full text-[11.5px] text-err">{batchErr}</div>}
      </div>
    )}
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
        {row("Total Sales", (c) => c.sales, { line: "sales", noteA: SALES_FROM[a.salesFrom], noteB: b ? "goods, service lines apart" : "no order opened", sub: true })}
        {(a.serviceRevenue !== 0 || (b?.serviceRevenue ?? 0) !== 0) && row("Service Revenue", (c) => c.serviceRevenue, { indent: true, noteB: "orders' service lines" })}
        {row("COGS — Matt/Sofa", (c) => c.cogs.mattSofa, { category: "cogs_matt_sofa", line: "cogs_matt_sofa", indent: true })}
        {row("COGS — Bedframe", (c) => c.cogs.bedframe, { category: "cogs_bedframe", line: "cogs_bedframe", indent: true })}
        {row("COGS — Accessories", (c) => c.cogs.accessories, { category: "cogs_accessories", line: "cogs_accessories", indent: true })}
        {showOther && row("COGS — Other", (c) => c.cogs.other, { indent: true })}
        {row("COGS Total", (c) => c.cogs.total, { sub: true, total: "cogs_total", noteA: cogsNote(a, b), noteB: b ? cogsNote(b, b) : undefined })}
        {row("Gross Profit", (c) => c.grossProfit, { sub: true, total: "gross_profit", tone: profitTone, noteA: gpOf(salesA, gpA), noteB: b ? gpOf(b.sales, b.grossProfit) : undefined })}
        {row("Rental", (c) => c.rental, { category: "rental", bookRow: "rental", line: "rental", noteA: rentalNote })}
        {row("Setup", (c) => c.setup, { category: "setup", bookRow: "setup", line: "setup" })}
        {row("Transport Fee", (c) => c.transportFee.amount, { bookRow: "transport_fee", line: "transport_fee", noteA: transportNote(a.transportFee), noteB: b ? transportNote(b.transportFee) : undefined })}
        {row("Transport Setup & Dismantle", (c) => c.transportSetupDismantle, { category: "transport_setup_dismantle", bookRow: "transport_setup_dismantle", line: "transport_setup_dismantle" })}
        {row("Commission", (c) => c.commission.amount, { bookRow: "commission", line: "commission", noteA: pctNote(a.commission), noteB: b ? pctNote(b.commission) : undefined })}
        {row("Merchandise", (c) => c.merchandise.amount, { line: "merchandise", noteA: pctNote(a.merchandise), noteB: b ? pctNote(b.merchandise) : undefined })}
        {row("Others Costing", (c) => c.others, { bookRow: "others", line: "others" })}
        {row("Total Cost", (c) => c.totalCost, { sub: true, total: "total_cost" })}
        {row("Net Profit", (c) => c.netProfit, { sub: true, total: "net_profit", tone: profitTone, noteA: npOf(salesA, npA), noteB: b ? npOf(b.sales, b.netProfit) : undefined })}
      </tbody>
    </table>
    </>
  );
}
