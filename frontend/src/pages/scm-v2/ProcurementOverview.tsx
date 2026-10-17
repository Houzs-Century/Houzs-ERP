// Procurement Overview (owner, 2026-10-16/17) — replaces the PO CHASING LIST
// sheet. Every figure follows the period picked at the top: PO raised, due,
// received and billed in it; what was still to come and how late at its last
// day; the overdue and arriving-soon lists; how long suppliers really take and
// how early we order against the customer's date; and dead stock.
// By category and By supplier are one switch over the same layout.
// Data: GET /api/scm/procurement-overview (backend lib/procurement-period.ts).
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
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
  ordering: { lines: number; avgOrderAheadDays: number | null; avgDueBeforeNeedDays: number | null; measured: number; avgArrivedBeforeNeedDays: number | null; p20ArrivedBeforeNeedDays: number | null; canOrderLaterDays: number | null };
};
type OpenLine = { poId: string; poNumber: string; poDate: string; supplier: string; category: string; itemCode: string | null; itemDesc: string | null; soDocNo: string | null; openQty: number; openSen: number; originalDue: string | null; promised: string | null; needDate: string | null; daysLate: number };
type Ages = { d0to90: number; d91to180: number; d181to365: number; d365plus: number };
type StockGroup = { key: string; skus: number; valueSen: number; deadSkus: number; deadSen: number; ages: Ages };
type TurnRow = { key: string; stockSen: number; outSen: number; turnsPerYear: number | null; daysOfStock: number | null };
type Turnover = {
  firstOut: string | null; days: number; zeroCostOuts: number;
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
  { k: "late0to4", label: "Late 4 days – due tomorrow", color: TONE.warn },
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
  /* The owner's sheet counts days late from the date first put on the PO;
     chasing works off the date the supplier promises now. Both are offered. */
  const [basis, setBasis] = useState<"original" | "promised">("original");
  const [by, setBy] = useState<"category" | "supplier">("category");
  const [focus, setFocus] = useState<string | null>(null);
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
  const top = groups.slice(0, 8);
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
        <Toggle value={basis} options={[["original", "Late vs first date"], ["promised", "Late vs latest promise"]]} onChange={setBasis} />
        {q.isFetching && <span className="text-[11.5px] text-ink-muted">Loading…</span>}
      </div>
      {q.error && <div className="rounded-md border border-err/40 bg-err/5 px-3 py-2 text-[12.5px] text-err">Could not load: {(q.error as Error).message}</div>}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Tile label={`PO raised · ${period.label}`} value={t ? rm(t.raised.sen) : "…"} tone="brass" trend={null} onClick={null}
          note={t ? `${t.raised.pos} POs · ${rm(t.raised.receivedSen)} received · ${rm(t.raised.openSen)} still to come` : ""} />
        <Tile label="Due in the period" value={t ? rm(t.due.sen) : "…"} tone={t?.due.openSen ? "bad" : "good"} trend={null} onClick={null}
          note={t ? `${rm(t.due.receivedSen)} received · ${rm(t.due.openSen)} not yet received` : ""} />
        <Tile label="Goods received in the period" value={t ? rm(t.receivedSen) : "…"} tone="main" trend={null} onClick={null}
          note={t ? `${t.supplierLead.receipts} receipt lines` : ""} />
        <Tile label="Supplier bills (PI) in the period" value={d ? rm(d.billed.totalSen) : "…"} tone="main" trend={null} onClick={null}
          note={d ? `${d.billed.count} invoices` : ""} />
        <Tile label="Still to come" value={t ? rm(t.open.sen) : "…"} tone={t?.open.late ? "warn" : "main"} trend={null} onClick={() => document.getElementById("overdue")?.scrollIntoView({ behavior: "smooth" })}
          note={t ? `${t.open.lines} open lines ${asOfNote} · ${t.open.late} late (${rm(t.open.lateSen)})` : ""} />
        <Tile label="Dead stock · no sale in 90+ days" value={d ? rm(d.deadStock.deadSen) : "…"} tone={d?.deadStock.deadSen ? "warn" : "good"} trend={null} onClick={() => document.getElementById("dead")?.scrollIntoView({ behavior: "smooth" })}
          note={d ? `${d.deadStock.deadSkus} items · ${share(d.deadStock.deadSen, d.deadStock.totalSen)} of ${rm(d.deadStock.totalSen)} stock · as of today` : ""} />
      </div>

      {insights.length > 0 && (
        <Panel title="What to act on" hint="read from the figures on this page">
          <ul className="space-y-1.5 text-[12.5px]">
            {insights.map((x, i) => <li key={i} className="flex gap-2"><span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: x.tone }} /><span className="text-ink-secondary">{x.text}</span></li>)}
          </ul>
        </Panel>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <h2 className="text-[14px] font-semibold text-ink">Breakdown</h2>
        <Toggle value={by} options={[["category", "By category"], ["supplier", "By supplier"]]} onChange={(v) => { setBy(v); setFocus(null); }} />
        <span className="text-[11.5px] text-ink-muted">Amounts are quantity × PO price. Click a row to filter the overdue and arriving lists.</span>
      </div>

      {d && t && (
        <>
          <Panel title={`Ordered, due and received · ${period.label}`} hint="what is still to come is counted at the period's last day">
            <table className="w-full border-collapse">
              <thead><tr>
                <Th left>{by === "category" ? "Category" : "Supplier"}</Th><Th>PO raised</Th><Th>POs</Th><Th>of which received</Th><Th>still to come</Th>
                <Th>Due in period</Th><Th>not received</Th><Th>Received</Th><Th>Billed (PI)</Th>
              </tr></thead>
              <tbody>
                {groups.map((g) => (
                  <tr key={g.key} onClick={() => setFocus(focus === g.key ? null : g.key)} className={cn("cursor-pointer hover:bg-surface-2/50", focus === g.key && "bg-primary-soft/50")}>
                    <Td left className="max-w-[240px] truncate">{label(g.key)}</Td>
                    <Td>{rm(g.raised.sen)}</Td><Td>{g.raised.pos}</Td><Td>{rm(g.raised.receivedSen)}</Td><Td>{rm(g.raised.openSen)}</Td>
                    <Td>{rm(g.due.sen)}</Td><Td className={g.due.openSen ? "text-err" : ""}>{rm(g.due.openSen)}</Td>
                    <Td>{rm(g.receivedSen)}</Td><Td>{rm(billedOf(g.key))}</Td>
                  </tr>
                ))}
                <tr className="font-semibold">
                  <Td left>Total</Td><Td>{rm(t.raised.sen)}</Td><Td>{t.raised.pos}</Td><Td>{rm(t.raised.receivedSen)}</Td><Td>{rm(t.raised.openSen)}</Td>
                  <Td>{rm(t.due.sen)}</Td><Td>{rm(t.due.openSen)}</Td><Td>{rm(t.receivedSen)}</Td><Td>{rm(d.billed.totalSen)}</Td>
                </tr>
              </tbody>
            </table>
          </Panel>

          <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
            <Panel title="PO raised in the period: received and still to come" hint={by === "supplier" ? "largest 8 suppliers" : undefined}>
              <Columns height={210} stacked format={rm} highlight={null} line={null} labels={top.map((g) => label(g.key).slice(0, 14))}
                series={[{ name: "Received", color: TONE.good }, { name: "Still to come", color: PALETTE[1]! }]}
                values={[top.map((g) => g.raised.receivedSen), top.map((g) => g.raised.openSen)]} />
            </Panel>
            <Panel title="Still to come" hint={asOfNote}>
              <Donut size={120} format={rm} center={{ value: String(t.open.lines), label: "open lines" }}
                data={groups.map((g) => ({ label: label(g.key), value: g.open.sen, color: null }))} />
            </Panel>
          </div>

          <section id="overdue">
            <Panel title="How late, by amount still to come" hint={`${basis === "original" ? "against the date first put on the PO" : "against the latest promised date"} · ${asOfNote}`}>
              <div className="space-y-2.5">
                {groups.filter((g) => g.open.lines > 0).map((g) => (
                  <button key={g.key} type="button" onClick={() => setFocus(focus === g.key ? null : g.key)} className={cn("block w-full rounded-md px-2 py-1.5 text-left hover:bg-surface-2/60", focus === g.key && "bg-primary-soft/50")}>
                    <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-3 text-[12.5px]">
                      <b className="text-ink">{label(g.key)}</b>
                      <span className="tabular-nums text-ink-muted">{rm(g.open.sen)} · {g.open.lines} lines{g.open.late ? <span className="text-err"> · {g.open.late} late</span> : null}</span>
                    </div>
                    <SplitBar format={rm} parts={BUCKETS.map((b) => ({ label: `${b.label} (${g.open.buckets[b.k].lines})`, value: g.open.buckets[b.k].sen, color: b.color }))} />
                  </button>
                ))}
              </div>
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

          <Panel title="Supplier delivery lead time" hint={`receipts in ${period.label} · lead time = PO date to goods received · on time = by the date first put on the PO`}>
            <table className="w-full border-collapse">
              <thead><tr><Th left>{by === "category" ? "Category" : "Supplier"}</Th><Th>Receipts</Th><Th>Average days</Th><Th>80% within</Th><Th>On time · lines</Th><Th>On time · amount</Th><Th>Late · lines</Th><Th>Average days late</Th>{by === "category" && <><Th>MRP setting</Th><Th>Suggested</Th><Th left> </Th></>}</tr></thead>
              <tbody>
                {groups.filter((g) => g.supplierLead.receipts > 0).map((g) => (
                  <tr key={g.key} className={g.supplierLead.receipts < MIN_RECEIPTS ? "text-ink-muted" : ""}>
                    <Td left className="max-w-[240px] truncate">{label(g.key)}</Td><Td>{g.supplierLead.receipts}</Td>
                    <Td>{days(g.supplierLead.avgDays)}</Td><Td>{days(g.supplierLead.p80Days)}</Td>
                    <Td className={g.supplierLead.onTimePct == null ? "" : g.supplierLead.onTimePct >= 80 ? "text-synced" : g.supplierLead.onTimePct >= 60 ? "text-warning-text" : "text-err"}>{pctTxt(g.supplierLead.onTimePct)}</Td>
                    <Td>{pctTxt(g.supplierLead.onTimeAmountPct)}</Td><Td>{pctTxt(g.supplierLead.latePct)}</Td><Td>{g.supplierLead.avgDaysLate != null ? `+${g.supplierLead.avgDaysLate}` : "—"}</Td>
                    {by === "category" && (() => {
                      const cur = d.currentLead[g.key] ?? null;
                      const sug = g.supplierLead.receipts >= MIN_RECEIPTS ? g.supplierLead.p80Days : null;
                      const mrp = MRP_CATEGORY[g.key];
                      return <>
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
                      </>;
                    })()}
                  </tr>
                ))}
                <tr className="font-semibold"><Td left>All</Td><Td>{t.supplierLead.receipts}</Td><Td>{days(t.supplierLead.avgDays)}</Td><Td>{days(t.supplierLead.p80Days)}</Td><Td>{pctTxt(t.supplierLead.onTimePct)}</Td><Td>{pctTxt(t.supplierLead.onTimeAmountPct)}</Td><Td>{pctTxt(t.supplierLead.latePct)}</Td><Td>{t.supplierLead.avgDaysLate != null ? `+${t.supplierLead.avgDaysLate}` : "—"}</Td></tr>
              </tbody>
            </table>
            <p className="mt-2 text-[11.5px] text-ink-muted">Each receipt line counts once ("lines"); "amount" weighs it by its value. Average days late is over the late lines only. A row with fewer than {MIN_RECEIPTS} receipts is greyed: too few to judge.{by === "category" ? " Suggested = the days 80% of the receipts in this period arrived within. The MRP setting is how many days before the customer date MRP orders; it changes only when you press Apply. Apply sets the company-wide value; the warehouse settings listed under it (East Malaysia includes shipping) stay as they are." : ""}</p>
          </Panel>

          <Panel title="How early we order" hint={`PO lines raised in ${period.label}, and lines received in it whose customer date is known`}>
            <Columns height={190} stacked={false} format={(x) => `${x} days`} highlight={null} line={null} labels={top.map((g) => label(g.key).slice(0, 14))}
              series={[{ name: "PO date → date on the PO", color: PALETTE[1]! }, { name: "Date on the PO → customer date", color: "#8fb3ae" }, { name: "Arrived before the customer date", color: PALETTE[0]! }]}
              values={[top.map((g) => g.ordering.avgOrderAheadDays ?? 0), top.map((g) => g.ordering.avgDueBeforeNeedDays ?? 0), top.map((g) => g.ordering.avgArrivedBeforeNeedDays ?? 0)]} />
            <table className="mt-3 w-full border-collapse">
              <thead><tr><Th left>{by === "category" ? "Category" : "Supplier"}</Th><Th>Lines raised</Th><Th>Ordered ahead (days)</Th><Th>Date on PO before customer date</Th><Th>Lines measured</Th><Th>Arrived early · average</Th><Th>80% arrived at least</Th><Th>Could order later by</Th>{by === "category" && <Th>MRP setting</Th>}</tr></thead>
              <tbody>
                {groups.filter((g) => g.ordering.lines > 0 || g.ordering.measured > 0).map((g) => (
                  <tr key={g.key}>
                    <Td left className="max-w-[240px] truncate">{label(g.key)}</Td><Td>{g.ordering.lines}</Td>
                    <Td>{days(g.ordering.avgOrderAheadDays)}</Td><Td>{days(g.ordering.avgDueBeforeNeedDays)}</Td>
                    <Td>{g.ordering.measured}</Td><Td>{days(g.ordering.avgArrivedBeforeNeedDays)}</Td><Td>{days(g.ordering.p20ArrivedBeforeNeedDays)}</Td>
                    <Td className="font-semibold">{g.ordering.canOrderLaterDays == null ? <span className="font-normal text-ink-muted">too few lines</span> : g.ordering.canOrderLaterDays > 0 ? `${g.ordering.canOrderLaterDays} days` : "no"}</Td>
                    {by === "category" && <Td>{d.currentLead[g.key] != null ? `${d.currentLead[g.key]} days` : "—"}</Td>}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-[11.5px] text-ink-muted">
              Read it as: we place the PO this many days before its date, that date sits this many days before the customer needs the goods, and the goods in fact arrived this many days early.
              "Could order later by" is how early the latest fifth of lines still arrived (the 20th percentile): ordering that much later would still have had 80% of lines in before the customer date. It comes from real receipts, not from the MRP setting, and needs {MIN_RECEIPTS} lines.
            </p>
          </Panel>

          <section id="dead">
            <Panel title="Dead stock" hint="stock on hand that has not gone out in over 90 days · idle since the last OUT movement, or since it first arrived · as of today">
              <div className="grid gap-4 xl:grid-cols-2">
                <div>
                  <div className="mb-1 text-[12px] font-semibold text-ink">By category</div>
                  <Columns height={190} stacked format={rm} highlight={null} line={null} labels={d.deadStock.byCategory.map((g) => CAT_LABEL[g.key] ?? g.key)}
                    series={AGES.map((a) => ({ name: a.label, color: a.color }))} values={AGES.map((a) => d.deadStock.byCategory.map((g) => g.ages[a.k]))} />
                </div>
                <div>
                  <div className="mb-1 text-[12px] font-semibold text-ink">By warehouse</div>
                  <Columns height={190} stacked format={rm} highlight={null} line={null} labels={d.deadStock.byWarehouse.filter((g) => g.deadSen > 0).map((g) => g.key.replace(" WAREHOUSE", " WH").slice(0, 12))}
                    series={AGES.map((a) => ({ name: a.label, color: a.color }))} values={AGES.map((a) => d.deadStock.byWarehouse.filter((g) => g.deadSen > 0).map((g) => g.ages[a.k]))} />
                </div>
              </div>
              <div className="mt-3 grid gap-4 xl:grid-cols-2">
                <StockTable title="Category" rows={d.deadStock.byCategory} name={(k) => CAT_LABEL[k] ?? k} />
                <StockTable title="Warehouse" rows={d.deadStock.byWarehouse} name={(k) => k} />
              </div>
              <div className="mt-3 text-[12px] font-semibold text-ink">Largest idle items</div>
              <table className="mt-1 w-full border-collapse">
                <thead><tr><Th left>Item</Th><Th left>Warehouse</Th><Th left>Category</Th><Th>Qty</Th><Th>Value</Th><Th>Idle days</Th></tr></thead>
                <tbody>{d.deadStock.top.slice(0, 20).map((r, i) => (
                  <tr key={`${r.itemCode}-${r.warehouse}-${i}`}><Td left><span title={r.name ?? ""}>{r.itemCode}</span></Td><Td left>{r.warehouse}</Td><Td left>{CAT_LABEL[r.category] ?? r.category}</Td><Td>{r.qty}</Td><Td>{rm(r.valueSen)}</Td><Td className={(r.idleDays ?? 0) > 365 ? "text-err" : ""}>{r.idleDays ?? "—"}</Td></tr>
                ))}</tbody>
              </table>
            </Panel>
          </section>

          <TurnoverPanel t={d.turnover} from={d.from} period={period.label} />
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
          <Td className={l.needDate && l.promised && l.promised > l.needDate ? "text-err" : ""}>{l.needDate ?? "—"}</Td>
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

function TurnoverPanel({ t, from, period }: { t: Turnover; from: string; period: string }) {
  const early = !t.firstOut || from < t.firstOut;
  const turns = (x: number | null) => (x == null ? "—" : `${x}×`);
  const daysTxt = (x: number | null) => (x == null ? "—" : `${x} days`);
  return (
    <Panel title={`Stock turnover and sellers · ${period}`} hint="turnover = cost sent out of the warehouses in the period, scaled to a year, over the stock value now · sellers = quantity on sales orders in the period">
      {early && <p className="mb-2 rounded-md bg-warning-bg px-2.5 py-1.5 text-[12px] text-warning-text">Stock movements start {t.firstOut ?? "—"}: turnover before that date reads low.</p>}
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
            <thead><tr><Th left>Item</Th><Th>Ordered</Th><Th>Sales</Th><Th>In stock</Th><Th>Stock covers</Th></tr></thead>
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
            <thead><tr><Th left>Item</Th><Th>Ordered</Th><Th>In stock</Th><Th>Stock value</Th></tr></thead>
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
