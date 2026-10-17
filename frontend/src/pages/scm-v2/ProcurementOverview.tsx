// Procurement Overview (owner, 2026-10-16/17) — replaces the PO CHASING LIST
// sheet. Every figure follows the period picked at the top: PO raised, due,
// received and billed in it; what was still to come and how late at its last
// day; the overdue and arriving-soon lists; how long suppliers really take and
// how early we order against the customer's date; and dead stock.
// By category and By supplier are one switch over the same layout.
// Data: GET /api/scm/procurement-overview (backend lib/procurement-period.ts).
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { PageHeader } from "../../components/Layout";
import { authedFetch } from "../../vendor/scm/lib/authed-fetch";
import { fmtSen, todayMY } from "../../vendor/shared/format";
import { cn } from "../../lib/utils";
import { Th, Td, Panel, Toggle } from "../../components/scm-v2/OverviewKit";
import { DashboardPeriodPicker, useDashboardPeriod } from "../../components/scm-v2/DashboardPeriod";
import { Columns, Donut, SplitBar, Tile, TONE, PALETTE } from "../../components/scm-v2/Charts";
import { useUpdateCategoryLeadTime, type LeadCategory } from "../../vendor/scm/lib/mrp-queries";

type BucketKey = "late5" | "late0to4" | "due2to7" | "due8plus";
type Group = {
  key: string;
  raised: { pos: number; lines: number; sen: number; receivedSen: number; openSen: number };
  due: { lines: number; sen: number; receivedSen: number; openSen: number };
  receivedSen: number;
  open: { lines: number; sen: number; late: number; lateSen: number; buckets: Record<BucketKey, { lines: number; sen: number }> };
  supplierLead: { receipts: number; avgDays: number | null; p80Days: number | null; onTimePct: number | null; latePct: number | null; onTimeAmountPct: number | null; avgDaysLate: number | null };
  ordering: { lines: number; avgOrderAheadDays: number | null; avgDueBeforeNeedDays: number | null; measured: number; avgOrderBeforeNeedDays: number | null; avgArrivedBeforeNeedDays: number | null; p20ArrivedBeforeNeedDays: number | null; canOrderLaterDays: number | null };
};
type OpenLine = { poId: string; poNumber: string; poDate: string; supplier: string; category: string; itemCode: string | null; itemDesc: string | null; soDocNo: string | null; openQty: number; openSen: number; originalDue: string | null; promised: string | null; needDate: string | null; daysLate: number };
type Ages = { d0to90: number; d91to180: number; d181to365: number; d365plus: number };
type StockGroup = { key: string; skus: number; valueSen: number; deadSkus: number; deadSen: number; ages: Ages };
type TurnRow = { key: string; stockSen: number; outSen: number; turnsPerYear: number | null; daysOfStock: number | null };
type Turnover = {
  firstOut: string | null; turnFrom: string; turnTo: string; days: number; sellerDays: number; zeroCostOuts: number;
  total: { stockSen: number; outSen: number; turnsPerYear: number | null; daysOfStock: number | null };
  byCategory: TurnRow[]; byWarehouse: TurnRow[];
  topSellers: Array<{ itemCode: string; name: string | null; category: string; qty: number; salesSen: number; stockQty: number; coverDays: number | null }>;
  lowSellers: Array<{ itemCode: string; name: string | null; category: string; stockQty: number; stockSen: number; soldQty: number }>;
};
type Payload = {
  turnover: Turnover;
  today: string; from: string; to: string; asOf: string; basis: "original" | "promised";
  categories: string[]; currentLead: Partial<Record<string, number>>; leadOverrides: Partial<Record<string, Array<{ warehouse: string; days: number }>>>;
  billed: { totalSen: number; count: number; bySupplier: Record<string, number>; byCategory: Record<string, number> };
  total: Group; byCategory: Group[]; bySupplier: Group[]; overdue: OpenLine[]; dueSoon: OpenLine[];
  deadStock: { asOf: string; totalSen: number; skus: number; deadSen: number; deadSkus: number; byCategory: StockGroup[]; byWarehouse: StockGroup[]; top: Array<{ warehouse: string; category: string; itemCode: string; name: string | null; qty: number; valueSen: number; idleDays: number | null }> };
};

const BUCKETS: Array<{ k: BucketKey; label: string; color: string }> = [
  { k: "late5", label: "Late 5+ days", color: TONE.bad },
  { k: "late0to4", label: "Late up to 4 days, or due tomorrow", color: TONE.warn },
  { k: "due2to7", label: "Due in 2–7 days", color: "#8fb3ae" },
  { k: "due8plus", label: "Due in 8+ days", color: TONE.good },
];
const AGES: Array<{ k: keyof Ages; label: string; color: string }> = [
  { k: "d91to180", label: "91–180 days", color: TONE.warn },
  { k: "d181to365", label: "181–365 days", color: "#c2603d" },
  { k: "d365plus", label: "Over a year", color: TONE.bad },
];
const CAT_LABEL: Record<string, string> = { MATTRESS: "Mattress", BEDFRAME: "Bedframe", SOFA: "Sofa", ACCESSORY: "Accessories", DINING: "Dining", OTHERS: "Others" };
const rm = fmtSen;
const days = (x: number | null) => (x == null ? "—" : `${x}`);
const pctTxt = (x: number | null) => (x == null ? "—" : `${x}%`);
const share = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—");
const MIN_RECEIPTS = 10;
/* The MRP categories a lead time can be set for (mrp-lead-times). */
const MRP_CATEGORY: Partial<Record<string, LeadCategory>> = { MATTRESS: "mattress", BEDFRAME: "bedframe", SOFA: "sofa", ACCESSORY: "accessory" };

/** `embedded`: inside the phone shell, which draws its own header. */
export function ProcurementOverview({ embedded }: { embedded: boolean }) {
  const today = todayMY();
  const [period, setPeriod] = useDashboardPeriod(today, "from", "to", []);
  /* Decision A (owner 2026-10-17): late and on time are counted against the
     date first put on the PO, never the latest revised one. */
  const basis = "original";
  const [by, setBy] = useState<"category" | "supplier">("category");
  const [focus, setFocus] = useState<string | null>(null);
  /* Two tabs (owner 2026-10-17, "too long"): the PO money and lists, and the
     slower-moving lead time, dead stock and turnover. */
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "stock" ? "stock" : "overview";
  const setTab = (v: "overview" | "stock") => setParams((p) => { const n = new URLSearchParams(p); if (v === "overview") n.delete("tab"); else n.set("tab", v); return n; }, { replace: true });
  const q = useQuery({
    queryKey: ["procurement-overview", period.from, period.to, basis],
    queryFn: () => authedFetch<Payload>(`/procurement-overview?from=${period.from}&to=${period.to}&basis=${basis}`),
    staleTime: 60_000,
  });
  const d = q.data;
  /* Decision C (owner 2026-10-17): the system only suggests a lead time; it
     changes when someone presses Apply. */
  const applyLead = useUpdateCategoryLeadTime();
  const label = (k: string) => (by === "category" ? CAT_LABEL[k] ?? k : k);
  const groups = (by === "category" ? d?.byCategory : d?.bySupplier) ?? [];
  const billedOf = (k: string) => (by === "category" ? d?.billed.byCategory[k] : d?.billed.bySupplier[k]) ?? 0;
  const t = d?.total;
  const matches = (l: OpenLine) => !focus || (by === "category" ? l.category === focus : l.supplier === focus);
  const overdue = (d?.overdue ?? []).filter(matches);
  const dueSoon = (d?.dueSoon ?? []).filter(matches);
  /* "this month" / "this quarter" / "in 2026-08" — the period in plain words. */
  const when = period.key === "month" ? "this month" : period.key === "quarter" ? "this quarter" : period.key === "year" ? "this year" : `in ${period.label}`;
  const When = when.charAt(0).toUpperCase() + when.slice(1);
  const asOfNote = d ? (d.asOf === today ? "as of today" : `as of ${d.asOf}, the period's last day`) : "";

  const insights = useMemo(() => {
    if (!d) return [];
    const out: Array<{ tone: string; text: string }> = [];
    const tt = d.total;
    if (tt.due.openSen > 0) out.push({ tone: TONE.bad, text: `${rm(tt.due.openSen)} of the ${rm(tt.due.sen)} due in this period has not arrived (${share(tt.due.openSen, tt.due.sen)}).` });
    if (tt.open.late > 0) out.push({ tone: TONE.bad, text: `${tt.open.late} open lines are past their date ${asOfNote}, worth ${rm(tt.open.lateSen)}. They are listed under Overdue.` });
    const later = d.byCategory.filter((g) => (g.ordering.canOrderLaterDays ?? 0) >= 3);
    if (later.length) out.push({ tone: TONE.warn, text: `Goods arrive well before the customer needs them: ${later.map((g) => `${CAT_LABEL[g.key] ?? g.key} could be ordered ${g.ordering.canOrderLaterDays} days later`).join(", ")}, and 80% of lines would still arrive in time.` });
    const unreliable = d.bySupplier.filter((g) => g.supplierLead.receipts >= MIN_RECEIPTS && (g.supplierLead.onTimePct ?? 100) < 60);
    if (unreliable.length) out.push({ tone: TONE.warn, text: `On time under 60% this period: ${unreliable.slice(0, 4).map((g) => `${g.key} ${g.supplierLead.onTimePct}%`).join(", ")}.` });
    if (d.deadStock.deadSen > 0) out.push({ tone: TONE.warn, text: `${rm(d.deadStock.deadSen)} of stock has not gone out in over 90 days (${d.deadStock.deadSkus} items, ${share(d.deadStock.deadSen, d.deadStock.totalSen)} of stock value).` });
    return out;
  }, [d, asOfNote]);

  return (
    <div className="space-y-4">
      {!embedded && <PageHeader eyebrow="Supply chain · Procurement" title="Procurement Overview"
        description="What we ordered, what was due and what arrived in the period, what is still to come and late, how long suppliers really take, how early we order, and dead stock." />}

      <div className="flex flex-wrap items-center gap-2">
        <DashboardPeriodPicker period={period} today={today} onChange={(f, to) => { setFocus(null); setPeriod(f, to); }} />
        <Toggle value={tab} options={[["overview", "Overview"], ["stock", "Lead time & stock"]]} onChange={setTab} />
        {q.isFetching && <span className="text-[11.5px] text-ink-muted">Loading…</span>}
      </div>
      {q.error && <div className="rounded-md border border-err/40 bg-err/5 px-3 py-2 text-[12.5px] text-err">Could not load: {(q.error as Error).message}</div>}

      {tab === "overview" && <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Tile label={`PO raised ${when}`} value={t ? rm(t.raised.sen) : "…"} tone="brass" trend={null} onClick={null}
          note={t ? `${t.raised.pos} purchase orders` : ""} />
        <Tile label={`Due ${when}`} value={t ? rm(t.due.sen) : "…"} tone={t?.due.openSen ? "bad" : "good"} trend={null} onClick={null}
          note={t ? (t.due.openSen ? `${rm(t.due.openSen)} has not arrived yet` : "all of it has arrived") : ""} />
        <Tile label={`Received ${when}`} value={t ? rm(t.receivedSen) : "…"} tone="main" trend={null} onClick={null}
          note={t ? `${t.supplierLead.receipts} lines received` : ""} />
        <Tile label={`Supplier billed ${when}`} value={d ? rm(d.billed.totalSen) : "…"} tone="main" trend={null} onClick={null}
          note={d ? `${d.billed.count} supplier invoices` : ""} />
        <Tile label="Total outstanding" value={t ? rm(t.open.sen) : "…"} tone={t?.open.late ? "warn" : "main"} trend={null} onClick={() => document.getElementById("overdue")?.scrollIntoView({ behavior: "smooth" })}
          note={t ? `all POs not yet received, ${asOfNote} · ${t.open.late} lines late` : ""} />
      </div>}

      {tab === "overview" && insights.length > 0 && (
        <Panel title="What to act on" hint="read from the figures on this page">
          <ul className="space-y-1.5 text-[12.5px]">
            {insights.map((x, i) => <li key={i} className="flex gap-2"><span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: x.tone }} /><span className="text-ink-secondary">{x.text}</span></li>)}
          </ul>
        </Panel>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <h2 className="text-[14px] font-semibold text-ink">Breakdown</h2>
        <Toggle value={by} options={[["category", "By category"], ["supplier", "By supplier"]]} onChange={(v) => { setBy(v); setFocus(null); }} />
        <span className="text-[11.5px] text-ink-muted">{tab === "overview" ? "Amounts are quantity × PO price. Click a row to filter the overdue and arriving lists at the bottom." : "Lead time by category or by supplier; dead stock and turnover are by category and warehouse."}</span>
      </div>

      {d && t && tab === "overview" && (
        <>
          <Panel title={`PO ${when}`} hint={`total outstanding = every PO line not yet received, ${asOfNote}`}>
            <table className="w-full border-collapse">
              <thead><tr>
                <Th left>{by === "category" ? "Category" : "Supplier"}</Th><Th>PO raised {when}</Th><Th>POs</Th>
                <Th>Due {when}</Th><Th>Due · not arrived yet</Th><Th>Received {when}</Th><Th>Supplier billed {when}</Th><Th>Total outstanding</Th>
              </tr></thead>
              <tbody>
                {groups.map((g) => (
                  <tr key={g.key} onClick={() => setFocus(focus === g.key ? null : g.key)} className={cn("cursor-pointer hover:bg-surface-2/50", focus === g.key && "bg-primary-soft/50")}>
                    <Td left className="max-w-[240px] truncate">{label(g.key)}</Td>
                    <Td>{rm(g.raised.sen)}</Td><Td>{g.raised.pos}</Td>
                    <Td>{rm(g.due.sen)}</Td><Td className={g.due.openSen ? "text-err" : ""}>{rm(g.due.openSen)}</Td>
                    <Td>{rm(g.receivedSen)}</Td><Td>{rm(billedOf(g.key))}</Td><Td className="font-semibold">{rm(g.open.sen)}</Td>
                  </tr>
                ))}
                <tr className="font-semibold">
                  <Td left>Total</Td><Td>{rm(t.raised.sen)}</Td><Td>{t.raised.pos}</Td>
                  <Td>{rm(t.due.sen)}</Td><Td>{rm(t.due.openSen)}</Td><Td>{rm(t.receivedSen)}</Td><Td>{rm(d.billed.totalSen)}</Td><Td>{rm(t.open.sen)}</Td>
                </tr>
              </tbody>
            </table>
          </Panel>

          <section id="overdue">
            <Panel title="Outstanding: how late" hint={`against the date first put on the PO · ${asOfNote} · click a row to filter the lists below`}>
              <table className="w-full border-collapse">
                <thead><tr>
                  <Th left>{by === "category" ? "Category" : "Supplier"}</Th><Th>Total outstanding</Th>
                  {BUCKETS.map((b) => <Th key={b.k}>{b.label}</Th>)}
                </tr></thead>
                <tbody>
                  {groups.filter((g) => g.open.lines > 0).map((g) => (
                    <tr key={g.key} onClick={() => setFocus(focus === g.key ? null : g.key)} className={cn("cursor-pointer hover:bg-surface-2/50", focus === g.key && "bg-primary-soft/50")}>
                      <Td left className="max-w-[240px] truncate">{label(g.key)}</Td>
                      <Td className="font-semibold">{rm(g.open.sen)}</Td>
                      {BUCKETS.map((b) => {
                        const cell = g.open.buckets[b.k];
                        return <Td key={b.k} className={cell.sen === 0 ? "text-ink-muted" : b.k === "late5" ? "text-err" : b.k === "late0to4" ? "text-warning-text" : ""}>
                          {cell.sen === 0 ? "—" : <>{rm(cell.sen)} <span className="text-[10.5px] text-ink-muted">{share(cell.sen, g.open.sen)}</span></>}
                        </Td>;
                      })}
                    </tr>
                  ))}
                  <tr className="font-semibold">
                    <Td left>Total</Td><Td>{rm(t.open.sen)}</Td>
                    {BUCKETS.map((b) => <Td key={b.k}>{t.open.buckets[b.k].sen ? <>{rm(t.open.buckets[b.k].sen)} <span className="text-[10.5px] text-ink-muted">{share(t.open.buckets[b.k].sen, t.open.sen)}</span></> : "—"}</Td>)}
                  </tr>
                </tbody>
              </table>
            </Panel>
          </section>

          <div className="grid gap-4 xl:grid-cols-2">
            <Panel title={`Overdue${focus ? ` · ${label(focus)}` : ""}`} hint={`${overdue.length} lines past their date ${asOfNote}`}
              right={focus ? <button type="button" className="text-[12px] text-primary hover:underline" onClick={() => setFocus(null)}>Show all</button> : null}>
              <LineTable rows={overdue.slice(0, 60)} empty="Nothing is past its date." mode="late" />
              {overdue.length > 60 && <p className="mt-1 text-[11px] text-ink-muted">The 60 most overdue of {overdue.length}.</p>}
            </Panel>
            <Panel title={`Arriving in the next 3 days${focus ? ` · ${label(focus)}` : ""}`} hint={`${dueSoon.length} lines`}>
              <LineTable rows={dueSoon.slice(0, 60)} empty="Nothing is due in the next 3 days." mode="soon" />
            </Panel>
          </div>

        </>
      )}

      {d && t && tab === "stock" && (
        <>
          <Panel title="Lead time" hint={`goods received ${when}`}>
            <p className="mb-2 text-[12.5px] text-ink-secondary">
              Three questions per row: how long the supplier really takes (PO to goods in), how many days before the customer&apos;s date we place the PO, and how early the goods then arrive. If goods keep arriving well before the customer needs them, we can order later and hold less stock.
            </p>
            <Columns valueLabels={false} height={190} stacked={false} format={(x) => `${x} days`} highlight={null} line={null}
              labels={groups.filter((g) => g.supplierLead.receipts > 0).slice(0, 8).map((g) => label(g.key).slice(0, 14))}
              series={[{ name: "Supplier takes (80% arrive within)", color: PALETTE[0]! }, { name: "We order before the customer date", color: PALETTE[1]! }, { name: "Goods arrive before the customer date", color: TONE.good }]}
              values={[
                groups.filter((g) => g.supplierLead.receipts > 0).slice(0, 8).map((g) => g.supplierLead.p80Days ?? 0),
                groups.filter((g) => g.supplierLead.receipts > 0).slice(0, 8).map((g) => (g.ordering.measured < MIN_RECEIPTS ? 0 : g.ordering.avgOrderBeforeNeedDays ?? 0)),
                groups.filter((g) => g.supplierLead.receipts > 0).slice(0, 8).map((g) => (g.ordering.measured < MIN_RECEIPTS ? 0 : g.ordering.avgArrivedBeforeNeedDays ?? 0)),
              ]} />
            <table className="mt-3 w-full border-collapse">
              <thead><tr>
                <Th left>{by === "category" ? "Category" : "Supplier"}</Th><Th>Receipts</Th>
                <Th>Supplier takes · average</Th><Th>80% arrive within</Th><Th>On time</Th><Th>Late by · average</Th>
                <Th>Lines with a customer date</Th><Th>We order before customer date</Th><Th>Arrives before customer date</Th><Th>Could order later by</Th>
                {by === "category" && <><Th>MRP setting</Th><Th>Suggested</Th><Th left> </Th></>}
              </tr></thead>
              <tbody>
                {groups.filter((g) => g.supplierLead.receipts > 0).map((g) => {
                  const few = g.supplierLead.receipts < MIN_RECEIPTS;
                  const cur = d.currentLead[g.key] ?? null;
                  const sug = few ? null : g.supplierLead.p80Days;
                  const mrp = MRP_CATEGORY[g.key];
                  return (
                    <tr key={g.key} className={few ? "text-ink-muted" : ""}>
                      <Td left className="max-w-[220px] truncate">{label(g.key)}</Td><Td>{g.supplierLead.receipts}</Td>
                      <Td>{g.supplierLead.avgDays != null ? `${g.supplierLead.avgDays} days` : "—"}</Td>
                      <Td>{g.supplierLead.p80Days != null ? `${g.supplierLead.p80Days} days` : "—"}</Td>
                      <Td className={few || g.supplierLead.onTimePct == null ? "" : g.supplierLead.onTimePct >= 80 ? "text-synced" : g.supplierLead.onTimePct >= 60 ? "text-warning-text" : "text-err"}>{pctTxt(g.supplierLead.onTimePct)}</Td>
                      <Td>{g.supplierLead.avgDaysLate != null ? `${g.supplierLead.avgDaysLate} days` : "—"}</Td>
                      <Td className="text-ink-secondary">{g.ordering.measured}</Td>
                      <Td>{g.ordering.measured < MIN_RECEIPTS ? <span className="text-ink-muted">too few lines</span> : g.ordering.avgOrderBeforeNeedDays != null ? `${g.ordering.avgOrderBeforeNeedDays} days` : "—"}</Td>
                      <Td>{g.ordering.measured < MIN_RECEIPTS ? <span className="text-ink-muted">too few lines</span> : g.ordering.avgArrivedBeforeNeedDays != null ? `${g.ordering.avgArrivedBeforeNeedDays} days early` : "—"}</Td>
                      <Td className="font-semibold">{g.ordering.canOrderLaterDays == null ? <span className="font-normal text-ink-muted">too few lines</span> : g.ordering.canOrderLaterDays > 0 ? `${g.ordering.canOrderLaterDays} days` : "no"}</Td>
                      {by === "category" && <>
                        <Td>
                          {cur != null ? `${cur} days` : "—"}
                          {(d.leadOverrides[g.key] ?? []).length > 0 && (
                            <span className="block text-[10.5px] text-ink-muted">{(d.leadOverrides[g.key] ?? []).map((o) => `${o.warehouse.replace(" WAREHOUSE", "")} ${o.days}`).join(" · ")}</span>
                          )}
                        </Td>
                        <Td className="font-semibold">{sug != null ? `${sug} days` : "—"}</Td>
                        <Td left>{mrp && sug != null && sug !== cur && (
                          <button type="button" disabled={applyLead.isPending}
                            onClick={() => applyLead.mutate({ warehouseId: null, category: mrp, leadDays: sug }, { onSuccess: () => { void q.refetch(); } })}
                            className="rounded-md border border-primary/40 px-2 py-0.5 text-[11.5px] text-primary hover:bg-primary-soft disabled:opacity-50">
                            Apply {sug} days
                          </button>
                        )}</Td>
                      </>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <ul className="mt-2 list-disc space-y-0.5 pl-5 text-[11.5px] text-ink-muted">
              <li>Supplier takes = PO date to the goods received note, for every line received {when}. 80% arrive within = 8 in 10 of those lines came in that many days or fewer. On time = arrived by the date first put on the PO. Late by = average over the late lines only.</li>
              <li>We order before / arrives before the customer date: only lines tied to a sales order (stock POs raised with no customer behind them have no customer date and are left out, so they do not stretch the figure). Arrives before = customer date minus the day the goods came in.</li>
              <li>Could order later by = how early the latest fifth of lines still arrived. Ordering that many days later would still have 80% of lines in before the customer&apos;s date. Needs {MIN_RECEIPTS} lines; greyed rows have too few.</li>
              {by === "category" && <li>MRP setting = how many days before the customer&apos;s date MRP tells you to order. Suggested = 80% arrive within. Apply changes the company-wide value only; the warehouse values under it (East Malaysia includes shipping) stay.</li>}
            </ul>
          </Panel>

          <section id="dead">
            <Panel title="Dead stock" hint="stock on hand that has not gone out for over 90 days, counted from the last time it left that warehouse (or from when it arrived, if it never left) · showroom and display stock left out · as of today">
              <div className="grid gap-4 xl:grid-cols-2">
                <div>
                  <div className="mb-1 text-[12px] font-semibold text-ink">By category</div>
                  <Columns valueLabels={false} height={190} stacked format={rm} highlight={null} line={null} labels={d.deadStock.byCategory.map((g) => CAT_LABEL[g.key] ?? g.key)}
                    series={AGES.map((a) => ({ name: a.label, color: a.color }))} values={AGES.map((a) => d.deadStock.byCategory.map((g) => g.ages[a.k]))} />
                </div>
                <div>
                  <div className="mb-1 text-[12px] font-semibold text-ink">By warehouse</div>
                  <Columns valueLabels={false} height={190} stacked format={rm} highlight={null} line={null} labels={d.deadStock.byWarehouse.filter((g) => g.deadSen > 0).map((g) => g.key.replace(" WAREHOUSE", " WH").slice(0, 12))}
                    series={AGES.map((a) => ({ name: a.label, color: a.color }))} values={AGES.map((a) => d.deadStock.byWarehouse.filter((g) => g.deadSen > 0).map((g) => g.ages[a.k]))} />
                </div>
              </div>
              <div className="mt-3 grid gap-4 xl:grid-cols-2">
                <StockTable title="Category" rows={d.deadStock.byCategory} name={(k) => CAT_LABEL[k] ?? k} />
                <StockTable title="Warehouse" rows={d.deadStock.byWarehouse} name={(k) => k} />
              </div>
              <div className="mt-3 text-[12px] font-semibold text-ink">Largest idle items</div>
              <table className="mt-1 w-full border-collapse">
                <thead><tr><Th left>Item</Th><Th left>Warehouse</Th><Th left>Category</Th><Th>Qty</Th><Th>Value</Th><Th>Days since it last went out</Th></tr></thead>
                <tbody>{d.deadStock.top.slice(0, 20).map((r, i) => (
                  <tr key={`${r.itemCode}-${r.warehouse}-${i}`}><Td left><span title={r.name ?? ""}>{r.itemCode}</span></Td><Td left>{r.warehouse}</Td><Td left>{CAT_LABEL[r.category] ?? r.category}</Td><Td>{r.qty}</Td><Td>{rm(r.valueSen)}</Td><Td className={(r.idleDays ?? 0) > 365 ? "text-err" : ""}>{r.idleDays ?? "—"}</Td></tr>
                ))}</tbody>
              </table>
            </Panel>
          </section>

          <TurnoverPanel t={d.turnover} when={when} />
        </>
      )}
    </div>
  );
}

function LineTable({ rows, empty, mode }: { rows: OpenLine[]; empty: string; mode: "late" | "soon" }) {
  if (rows.length === 0) return <p className="py-2 text-[12.5px] text-ink-muted">{empty}</p>;
  return (
    <table className="w-full border-collapse">
      <thead><tr><Th left>PO</Th><Th left>Supplier</Th><Th left>Item</Th><Th>Still to come</Th><Th>Date on PO</Th><Th>Promised</Th><Th>Customer date</Th><Th>{mode === "late" ? "Days late" : "Due in"}</Th></tr></thead>
      <tbody>{rows.map((l, i) => (
        <tr key={`${l.poId}-${l.itemCode}-${i}`} className="hover:bg-surface-2/50">
          <Td left><Link to={`/scm/purchase-orders/${l.poId}`} className="text-primary hover:underline">{l.poNumber}</Link>{l.soDocNo && <span className="ml-1 text-[10.5px] text-ink-muted">{l.soDocNo}</span>}</Td>
          <Td left className="max-w-[160px] truncate">{l.supplier}</Td>
          <Td left><span title={l.itemDesc ?? ""}>{l.itemCode ?? "—"}</span></Td>
          <Td>{l.openQty} · {fmtSen(l.openSen)}</Td>
          <Td>{l.originalDue ?? "—"}</Td><Td>{l.promised ?? "—"}</Td>
          <Td className={l.needDate && l.promised && l.promised > l.needDate ? "text-err" : ""}>{l.needDate ?? <span className="text-ink-muted" title="Raised for stock, not tied to a sales order">stock</span>}</Td>
          <Td className={mode === "late" ? (l.daysLate >= 5 ? "font-semibold text-err" : "text-warning-text") : ""}>{mode === "late" ? l.daysLate : l.daysLate === 0 ? "today" : `${-l.daysLate} days`}</Td>
        </tr>
      ))}</tbody>
    </table>
  );
}

function StockTable({ title, rows, name }: { title: string; rows: StockGroup[]; name: (k: string) => string }) {
  const tot = rows.reduce((a, r) => ({ v: a.v + r.valueSen, d: a.d + r.deadSen, s: a.s + r.deadSkus }), { v: 0, d: 0, s: 0 });
  return (
    <table className="w-full border-collapse">
      <thead><tr><Th left>{title}</Th><Th>Stock value</Th><Th>Dead (90+ days)</Th><Th>Share</Th><Th>Items</Th></tr></thead>
      <tbody>
        {rows.map((r) => <tr key={r.key}><Td left>{name(r.key)}</Td><Td>{fmtSen(r.valueSen)}</Td><Td className={r.deadSen ? "text-warning-text" : ""}>{fmtSen(r.deadSen)}</Td><Td>{share(r.deadSen, r.valueSen)}</Td><Td>{r.deadSkus}</Td></tr>)}
        <tr className="font-semibold"><Td left>Total</Td><Td>{fmtSen(tot.v)}</Td><Td>{fmtSen(tot.d)}</Td><Td>{share(tot.d, tot.v)}</Td><Td>{tot.s}</Td></tr>
      </tbody>
    </table>
  );
}

function TurnoverPanel({ t, when }: { t: Turnover; when: string }) {
  const early = !!t.firstOut && t.firstOut === t.turnFrom;
  const turns = (x: number | null) => (x == null ? "—" : `${x}×`);
  const daysTxt = (x: number | null) => (x == null ? "—" : `${x} days`);
  return (
    <Panel title="Stock turnover and sellers" hint={`turnover: the last 12 months, ${t.turnFrom} – ${t.turnTo}, the same whatever period is picked · sellers: quantity on sales orders ${when}, service lines left out, sofas counted by model`}>
      {early && <p className="mb-2 rounded-md bg-warning-bg px-2.5 py-1.5 text-[12px] text-warning-text">Stock movements in the ERP begin {t.firstOut}, so turnover covers {t.days} days so far; it becomes a full year as time passes.</p>}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="Turns a year" value={turns(t.total.turnsPerYear)} note={`${fmtSen(t.total.outSen)} sent out in ${t.days} days`} tone="main" trend={null} onClick={null} />
        <Tile label="Days of stock" value={daysTxt(t.total.daysOfStock)} note={`${fmtSen(t.total.stockSen)} on hand now`} tone={(t.total.daysOfStock ?? 0) > 120 ? "warn" : "main"} trend={null} onClick={null} />
        <Tile label="Top seller" value={t.topSellers[0]?.itemCode ?? "—"} note={t.topSellers[0] ? `${t.topSellers[0].qty} ordered · stock covers ${daysTxt(t.topSellers[0].coverDays)}` : ""} tone="good" trend={null} onClick={null} />
        <Tile label="Movements without cost" value={String(t.zeroCostOuts)} note="these make turnover read low" tone={t.zeroCostOuts ? "warn" : "good"} trend={null} onClick={null} />
      </div>
      <div className="mt-3 grid gap-4 xl:grid-cols-2">
        <TurnTable title="Category" rows={t.byCategory} name={(k) => CAT_LABEL[k] ?? k} />
        <TurnTable title="Warehouse" rows={t.byWarehouse} name={(k) => k} />
      </div>
      <div className="mt-3 grid gap-4 xl:grid-cols-2">
        <div>
          <div className="mb-1 text-[12px] font-semibold text-ink">Top sellers</div>
          <table className="w-full border-collapse">
            <thead><tr><Th left>Item / sofa model</Th><Th>Ordered</Th><Th>Sales</Th><Th>In stock</Th><Th>Stock covers</Th></tr></thead>
            <tbody>{t.topSellers.map((r) => (
              <tr key={r.itemCode}><Td left><span title={r.name ?? ""}>{r.itemCode}</span></Td><Td>{r.qty}</Td><Td>{fmtSen(r.salesSen)}</Td><Td>{r.stockQty}</Td>
                <Td className={r.coverDays != null && r.coverDays < 14 ? "font-semibold text-err" : ""}>{daysTxt(r.coverDays)}</Td></tr>
            ))}</tbody>
          </table>
          <p className="mt-1 text-[11px] text-ink-muted">Stock covers = stock on hand ÷ quantity ordered a day. Under 14 days is red: reorder.</p>
        </div>
        <div>
          <div className="mb-1 text-[12px] font-semibold text-ink">Low sellers · most money held first</div>
          <table className="w-full border-collapse">
            <thead><tr><Th left>Item / sofa model</Th><Th>Ordered</Th><Th>In stock</Th><Th>Stock value</Th></tr></thead>
            <tbody>{t.lowSellers.map((r) => (
              <tr key={r.itemCode}><Td left><span title={r.name ?? ""}>{r.itemCode}</span></Td><Td className={r.soldQty === 0 ? "text-err" : ""}>{r.soldQty}</Td><Td>{r.stockQty}</Td><Td>{fmtSen(r.stockSen)}</Td></tr>
            ))}</tbody>
          </table>
        </div>
      </div>
    </Panel>
  );
}

function TurnTable({ title, rows, name }: { title: string; rows: TurnRow[]; name: (k: string) => string }) {
  return (
    <table className="w-full border-collapse">
      <thead><tr><Th left>{title}</Th><Th>Stock now</Th><Th>Sent out</Th><Th>Turns a year</Th><Th>Days of stock</Th></tr></thead>
      <tbody>{rows.filter((r) => r.stockSen > 0 || r.outSen > 0).map((r) => (
        <tr key={r.key}><Td left>{name(r.key)}</Td><Td>{fmtSen(r.stockSen)}</Td><Td>{fmtSen(r.outSen)}</Td>
          <Td className={r.turnsPerYear == null ? "" : r.turnsPerYear < 3 ? "text-err" : r.turnsPerYear < 4 ? "text-warning-text" : "text-synced"}>{r.turnsPerYear == null ? "—" : `${r.turnsPerYear}×`}</Td>
          <Td>{r.daysOfStock == null ? "—" : r.daysOfStock}</Td></tr>
      ))}</tbody>
    </table>
  );
}

export default ProcurementOverview;
