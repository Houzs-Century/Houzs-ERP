// Procurement Overview (owner, 2026-10-16) — replaces the PO CHASING LIST
// sheet: open PO lines and how late they are (the sheet's four buckets) by
// category and supplier, the PO raised and supplier bills received in a
// period, and how long each category really takes to deliver.
// Data: GET /api/scm/procurement-overview (backend routes/procurement-overview.ts).
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { PageHeader } from "../../components/Layout";
import { StatCard } from "../../components/StatCard";
import { authedFetch } from "../../vendor/scm/lib/authed-fetch";
import { fmtSen, todayMY } from "../../vendor/shared/format";
import { cn } from "../../lib/utils";
import { Th, Td, Panel, Toggle, PeriodPicker, periodRange, SELECT_CLS, type Gran } from "../../components/scm-v2/OverviewKit";

type Bucket = "late5" | "late0to4" | "due2to7" | "due8plus";
type BucketRow = { key: string; lines: number; remainingQty: number; remainingSen: number; buckets: Record<Bucket, number> };
type Chase = { poId: string; poNumber: string; supplier: string; category: string; itemCode: string | null; itemDesc: string | null; location: string | null; soDocNo: string | null; poDate: string | null; remainingQty: number; originalDue: string | null; promised: string | null; revised: string[]; daysLate: number; daysLateOriginal: number | null };
type Lead = { key: string; receipts: number; avgDays: number | null; p80Days: number | null; onTimePct: number | null; avgDaysLate: number | null; rejectPct: number | null; current?: number | null; suggested?: number | null; verdict?: "too_short" | "ok" | "can_shorten" | "not_enough_data" };
type Period = { totalSen: number; count: number; bySupplier: Record<string, number>; byCategory: Record<string, number> };
type Payload = {
  today: string; from: string; to: string; categories: string[];
  open: { poCount: number; lineCount: number; remainingQty: number; remainingSen: number; late5Lines: number; late5LinesOriginal: number; late5Suppliers: number; worstDaysLate: number };
  poRaised: Period; piReceived: Period;
  overdueByCategory: BucketRow[]; overdueBySupplier: BucketRow[]; overdueByCategoryOriginal: BucketRow[]; overdueBySupplierOriginal: BucketRow[];
  chasing: Chase[]; leadByCategory: Lead[]; leadBySupplier: Lead[]; receiptsSince: string;
};

const BUCKETS: Array<{ k: Bucket; label: string; tone: string }> = [
  { k: "late5", label: "Late ≥ 5 days", tone: "text-err" },
  { k: "late0to4", label: "Late 4 days – due now", tone: "text-warning-text" },
  { k: "due2to7", label: "Due in 2–7 days", tone: "text-ink" },
  { k: "due8plus", label: "Due in 8+ days", tone: "text-synced" },
];
const CAT_LABEL: Record<string, string> = { MATTRESS: "Mattress", BEDFRAME: "Bedframe", SOFA: "Sofa", ACCESSORY: "Accessories", DINING: "Dining", OTHERS: "Others" };
const VERDICT: Record<string, [string, string]> = { too_short: ["Set too short", "bg-err/10 text-err"], ok: ["About right", "bg-synced/10 text-synced"], can_shorten: ["Can shorten", "bg-warning-text/10 text-warning-text"], not_enough_data: ["Too few receipts", "bg-surface-2 text-ink-muted"] };

export function ProcurementOverview() {
  const today = todayMY();
  const [gran, setGran] = useState<Gran>("M");
  const [anchor, setAnchor] = useState(`${today.slice(0, 7)}-01`);
  const range = periodRange(gran, anchor);
  const q = useQuery({
    queryKey: ["procurement-overview", range.from, range.to],
    queryFn: () => authedFetch<Payload>(`/procurement-overview?from=${range.from}&to=${range.to}`),
    staleTime: 60_000,
  });
  const d = q.data;
  const [overBy, setOverBy] = useState<"supplier" | "category">("supplier");
  /* Owner's sheet counts days late from the date first put on the PO; chasing
     works off the date the supplier promises now. Both are shown. */
  const [basis, setBasis] = useState<"original" | "promised">("original");
  const [moneyBy, setMoneyBy] = useState<"category" | "supplier">("category");
  const [leadBy, setLeadBy] = useState<"category" | "supplier">("category");
  const [chaseSup, setChaseSup] = useState("");
  const [chaseCat, setChaseCat] = useState("");

  const overRows = overBy === "supplier"
    ? (basis === "original" ? d?.overdueBySupplierOriginal : d?.overdueBySupplier) ?? []
    : (basis === "original" ? d?.overdueByCategoryOriginal : d?.overdueByCategory) ?? [];
  const overTotal = useMemo(() => overRows.reduce((a, r) => ({ lines: a.lines + r.lines, qty: a.qty + r.remainingQty, b: BUCKETS.map((b, i) => a.b[i]! + r.buckets[b.k]) }), { lines: 0, qty: 0, b: [0, 0, 0, 0] }), [overRows]);
  const moneyRows = useMemo(() => {
    if (!d) return [];
    const src = moneyBy === "category" ? d.overdueByCategory : d.overdueBySupplier;
    const keys = new Set([...src.map((r) => r.key), ...Object.keys(moneyBy === "category" ? d.poRaised.byCategory : d.poRaised.bySupplier), ...Object.keys(moneyBy === "category" ? d.piReceived.byCategory : d.piReceived.bySupplier)]);
    return [...keys].map((k) => {
      const o = src.find((r) => r.key === k);
      return { key: k, lines: o?.lines ?? 0, remainingSen: o?.remainingSen ?? 0, po: (moneyBy === "category" ? d.poRaised.byCategory : d.poRaised.bySupplier)[k] ?? 0, pi: (moneyBy === "category" ? d.piReceived.byCategory : d.piReceived.bySupplier)[k] ?? 0 };
    }).sort((a, b) => b.remainingSen + b.po - (a.remainingSen + a.po));
  }, [d, moneyBy]);
  const lateOf = (c: Chase) => (basis === "original" ? c.daysLateOriginal ?? c.daysLate : c.daysLate);
  const chasing = (d?.chasing ?? []).slice().sort((a, b) => lateOf(b) - lateOf(a)).filter((c) => (!chaseSup || c.supplier === chaseSup) && (!chaseCat || c.category === chaseCat));
  const sel = SELECT_CLS;

  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Supply chain · Procurement" title="Procurement Overview"
        description="Open purchase orders and how late they are, the PO raised and supplier bills received in the period, and how long each category really takes to arrive." />

      <PeriodPicker gran={gran} anchor={anchor} today={today} onChange={(g, a2) => { setGran(g); setAnchor(a2); }} note="Open PO and lateness are as of today; PO raised and bills follow the period." />

      {q.error && <div className="rounded-md border border-err/40 bg-err/5 px-3 py-2 text-[12.5px] text-err">Could not load: {(q.error as Error).message}</div>}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Open PO" value={d ? String(d.open.poCount) : "—"} subtitle={d ? `${d.open.lineCount} lines · ${d.open.remainingQty.toLocaleString()} pcs owed · ${fmtSen(d.open.remainingSen)}` : undefined} pending={q.isLoading} />
        <StatCard label={`PO raised · ${range.label}`} value={d ? fmtSen(d.poRaised.totalSen) : "—"} subtitle={d ? `${d.poRaised.count} purchase orders` : undefined} pending={q.isLoading} />
        <StatCard label={`Supplier bills (PI) · ${range.label}`} value={d ? fmtSen(d.piReceived.totalSen) : "—"} subtitle={d ? `${d.piReceived.count} invoices` : undefined} pending={q.isLoading} />
        <StatCard label="Late ≥ 5 days" value={d ? `${basis === "original" ? d.open.late5LinesOriginal : d.open.late5Lines} lines` : "—"} subtitle={d ? (basis === "original" ? `against the first promised date · ${d.open.late5Lines} against the latest` : `against the latest promised date · ${d.open.late5LinesOriginal} against the first`) : undefined} tone={d && (basis === "original" ? d.open.late5LinesOriginal : d.open.late5Lines) ? "error" : "default"} pending={q.isLoading} />
      </div>

      <Panel title="PO overdue" hint={basis === "original" ? "open lines by days late against the date first put on the PO" : "open lines by days late against the date the supplier now promises"}
        right={<span className="flex flex-wrap gap-2"><Toggle value={basis} options={[["original", "First promised"], ["promised", "Latest promised"]]} onChange={setBasis} /><Toggle value={overBy} options={[["supplier", "By supplier"], ["category", "By category"]]} onChange={setOverBy} /></span>}>
        <table className="w-full border-collapse">
          <thead><tr><Th left>{overBy === "supplier" ? "Supplier" : "Category"}</Th><Th>Open lines</Th><Th>Qty owed</Th>{BUCKETS.map((b) => <Th key={b.k}>{b.label}</Th>)}</tr></thead>
          <tbody>
            {overRows.map((r) => (
              <tr key={r.key} className="hover:bg-surface-2/50">
                <Td left><button type="button" className="text-left hover:text-primary hover:underline" onClick={() => overBy === "supplier" ? setChaseSup(r.key) : setChaseCat(r.key)}>{overBy === "category" ? CAT_LABEL[r.key] ?? r.key : r.key}</button></Td>
                <Td>{r.lines}</Td><Td>{r.remainingQty.toLocaleString()}</Td>
                {BUCKETS.map((b) => <Td key={b.k} className={r.buckets[b.k] ? b.tone : "text-ink-muted"}>{r.buckets[b.k]} <span className="text-[10.5px] text-ink-muted">{r.lines ? Math.round((r.buckets[b.k] / r.lines) * 100) : 0}%</span></Td>)}
              </tr>
            ))}
            {overRows.length > 0 && <tr className="font-semibold"><Td left>Total</Td><Td>{overTotal.lines}</Td><Td>{overTotal.qty.toLocaleString()}</Td>{overTotal.b.map((n, i) => <Td key={i}>{n}</Td>)}</tr>}
            {!q.isLoading && overRows.length === 0 && <tr><Td left className="text-ink-muted">No open purchase order lines.</Td></tr>}
          </tbody>
        </table>
      </Panel>

      <Panel title="PO chasing list" hint="most overdue first"
        right={<span className="flex gap-2">
          <select className={sel} value={chaseSup} onChange={(e) => setChaseSup(e.target.value)} aria-label="Supplier"><option value="">All suppliers</option>{[...new Set((d?.chasing ?? []).map((c) => c.supplier))].sort().map((s) => <option key={s}>{s}</option>)}</select>
          <select className={sel} value={chaseCat} onChange={(e) => setChaseCat(e.target.value)} aria-label="Category"><option value="">All categories</option>{(d?.categories ?? []).map((k) => <option key={k} value={k}>{CAT_LABEL[k] ?? k}</option>)}</select>
        </span>}>
        <table className="w-full border-collapse">
          <thead><tr><Th left>PO</Th><Th left>Supplier</Th><Th left>Item</Th><Th left>Category</Th><Th left>Location</Th><Th>PO date</Th><Th>Owed</Th><Th>First promised</Th><Th>Now promised</Th><Th>Days late</Th></tr></thead>
          <tbody>
            {chasing.slice(0, 50).map((c, i) => (
              <tr key={`${c.poId}-${i}`} className="hover:bg-surface-2/50">
                <Td left><Link to={`/scm/purchase-orders/${c.poId}`} className="text-primary hover:underline">{c.poNumber}</Link>{c.soDocNo && <span className="ml-1 text-[10.5px] text-ink-muted">{c.soDocNo}</span>}</Td>
                <Td left>{c.supplier}</Td>
                <Td left><span title={c.itemDesc ?? ""}>{c.itemCode ?? "—"}</span></Td>
                <Td left>{CAT_LABEL[c.category] ?? c.category}</Td>
                <Td left>{c.location ?? "—"}</Td>
                <Td>{c.poDate?.slice(0, 10) ?? "—"}</Td>
                <Td>{c.remainingQty}</Td>
                <Td>{c.originalDue?.slice(0, 10) ?? "—"}</Td>
                <Td>{c.promised ?? "—"}{c.revised.length > 0 && <span className="ml-1 text-[10.5px] text-ink-muted">moved {c.revised.length}x</span>}</Td>
                <Td className={lateOf(c) >= 5 ? "font-semibold text-err" : lateOf(c) >= -1 ? "text-warning-text" : "text-ink-muted"}>{lateOf(c) > 0 ? `${lateOf(c)}` : lateOf(c) === 0 ? "due today" : `in ${-lateOf(c)}`}</Td>
              </tr>
            ))}
            {!q.isLoading && chasing.length === 0 && <tr><Td left className="text-ink-muted">Nothing to chase.</Td></tr>}
          </tbody>
        </table>
        {chasing.length > 50 && <p className="mt-2 text-[11.5px] text-ink-muted">Showing the 50 most overdue of {chasing.length}. Filter by supplier or category to narrow.</p>}
      </Panel>

      <Panel title={`Amounts · ${range.label}`} hint="owed = quantity still to come × PO price"
        right={<Toggle value={moneyBy} options={[["category", "By category"], ["supplier", "By supplier"]]} onChange={setMoneyBy} />}>
        <table className="w-full border-collapse">
          <thead><tr><Th left>{moneyBy === "category" ? "Category" : "Supplier"}</Th><Th>Open lines</Th><Th>Owed</Th><Th>PO raised</Th><Th>Supplier bills (PI)</Th></tr></thead>
          <tbody>
            {moneyRows.map((r) => <tr key={r.key}><Td left>{moneyBy === "category" ? CAT_LABEL[r.key] ?? r.key : r.key}</Td><Td>{r.lines}</Td><Td>{fmtSen(r.remainingSen)}</Td><Td>{fmtSen(r.po)}</Td><Td>{fmtSen(r.pi)}</Td></tr>)}
            {d && <tr className="font-semibold"><Td left>Total</Td><Td>{d.open.lineCount}</Td><Td>{fmtSen(d.open.remainingSen)}</Td><Td>{fmtSen(d.poRaised.totalSen)}</Td><Td>{fmtSen(d.piReceived.totalSen)}</Td></tr>}
          </tbody>
        </table>
      </Panel>

      <Panel title="Lead time" hint={d ? `goods received since ${d.receiptsSince} · lead time = received − PO date · on time = by the date first promised` : undefined}
        right={<Toggle value={leadBy} options={[["category", "By category"], ["supplier", "By supplier"]]} onChange={setLeadBy} />}>
        <table className="w-full border-collapse">
          <thead><tr><Th left>{leadBy === "category" ? "Category" : "Supplier"}</Th><Th>Receipts</Th><Th>Average days</Th><Th>80% within</Th><Th>On time</Th><Th>Avg days late</Th><Th>Rejected</Th>{leadBy === "category" && <><Th>Current setting</Th><Th>Suggested</Th><Th left> </Th></>}</tr></thead>
          <tbody>
            {(leadBy === "category" ? d?.leadByCategory ?? [] : d?.leadBySupplier ?? []).map((l) => (
              <tr key={l.key}>
                <Td left>{leadBy === "category" ? CAT_LABEL[l.key] ?? l.key : l.key}</Td>
                <Td>{l.receipts}</Td><Td>{l.avgDays ?? "—"}</Td><Td>{l.p80Days ?? "—"}</Td>
                <Td className={l.onTimePct == null ? "" : l.onTimePct >= 80 ? "text-synced" : l.onTimePct >= 60 ? "text-warning-text" : "text-err"}>{l.onTimePct != null ? `${l.onTimePct}%` : "—"}</Td>
                <Td>{l.avgDaysLate != null ? `+${l.avgDaysLate}` : "—"}</Td>
                <Td>{l.rejectPct != null ? `${l.rejectPct}%` : "—"}</Td>
                {leadBy === "category" && <>
                  <Td>{l.current ?? "—"}</Td>
                  <Td className="font-semibold">{l.suggested ?? "—"}</Td>
                  <Td left>{l.verdict && <span className={cn("rounded-full px-2 py-0.5 text-[10.5px]", VERDICT[l.verdict]![1])}>{VERDICT[l.verdict]![0]}</span>}</Td>
                </>}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-[11.5px] text-ink-muted">Suggested = the number of days 80% of receipts arrived within. A category keeps its current setting until it has 10 receipts.</p>
      </Panel>
    </div>
  );
}

export default ProcurementOverview;
