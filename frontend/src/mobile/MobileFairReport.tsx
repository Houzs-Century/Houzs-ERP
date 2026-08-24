import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { fairAllowedStages } from "../auth/salesAccess";
import {
  useFairReport,
  useFairReportDetail,
  fairReportErrorInfo,
  type FairStage,
  type FairFilters,
  type FairDims,
  type FairSoRow,
  type FairDoRow,
  type FairInvoiceRow,
  type FairPnlRow,
  type FairSoSummary,
  type FairDoSummary,
  type FairInvoiceSummary,
  type FairPnlSummary,
  type FairCostByCategory,
} from "../vendor/scm/lib/fair-report-queries";
import { fmtAmt, fmtSen } from "../lib/scm";
import { formatDate } from "../lib/utils";
import { buildVariantSummary, orderLineIdentity } from "@2990s/shared";
import "./mobile.css";

/*
 * MobileFairReport — the phone surface of the Fair Report (the exhibition-sales
 * report with three document-stage views: Sales Orders / Delivery / Invoices).
 * It is the phone twin of the desktop pages/scm-v2/FairReport.tsx and reuses the
 * SAME read hooks (useFairReport / useFairReportDetail → GET /scm/reports/
 * fair-report[/:docNo]); the server does all the fair-anchoring, the money
 * splits and the per-stage summaries, so this screen only fetches, filters and
 * renders. No new endpoint, no client-side money math beyond formatting.
 *
 * PERMISSION mirrors the backend fairReportAccess exactly (auth/salesAccess):
 *   * ordinary salespeople → no access (the menu row + this screen are gated in
 *     MobileApp with canViewFairReport — off, not hidden)
 *   * Sales Director        → SO stage only (Delivery + Invoices tabs absent)
 *   * management            → all three stages
 * The tabs are driven by fairAllowedStages(user), and a stage's query is held
 * (`enabled`) until its tab is both selected AND allowed, so a Sales Director
 * never even fires the do/invoice queries the backend would 403.
 *
 * The mobile shell has no router and does not keep filters in the URL (unlike
 * the desktop page's useSearchParams), so stage + the 7 filters + the open
 * detail are plain component state, matching every other mobile screen.
 *
 * English · MYR · DD/MM/YYYY · no emoji.
 */

// ── money / number formatting (mirror the desktop page's cell / rm / pct) ────
/** Bare 2dp amount, zero/absent → em dash so a compact card reads cleanly. */
const cell = (centi: number | null | undefined): string => {
  const v = Number(centi ?? 0);
  return v ? fmtAmt(v) : "—";
};
/** RM-prefixed amount (always shows 0.00). */
const rm = (centi: number | null | undefined): string => fmtSen(centi);
const pct = (p: number | null | undefined): string => (p == null ? "—" : `${p.toFixed(1)}%`);
/** Signed money for the DO cost drift (+ grew at delivery, − shrank). */
const signedMoney = (centi: number | null | undefined): string => {
  const v = Number(centi ?? 0);
  if (!v) return "—";
  return `${v > 0 ? "+" : "−"}${cell(Math.abs(v))}`;
};
/** Signed margin points (DO vs SO). */
const pts = (a: number | null | undefined, b: number | null | undefined): string => {
  if (a == null || b == null) return "—";
  const d = a - b;
  return `${d > 0 ? "+" : ""}${d.toFixed(1)} pts`;
};

const STAGE_TABS: { key: FairStage; label: string }[] = [
  { key: "so", label: "Sales Orders" },
  { key: "do", label: "Delivery" },
  { key: "invoice", label: "Invoices" },
  { key: "pnl", label: "P&L" },
];

const catRows = (c: FairCostByCategory): [string, number][] => [
  ["Mattress / Sofa", c.mattress_sofa_cost_sen],
  ["Bedframe", c.bedframe_cost_sen],
  ["Accessories", c.accessories_cost_sen],
  ["Others", c.others_cost_sen],
  ["Service", c.service_cost_sen],
];

// ── accumulated filter options (same idea as the desktop page's accumulate) ──
// The 7 filters are populated from whatever rows have loaded; the set only ever
// grows so a dropdown stays usable after a filter narrows the result.
type OptionMaps = {
  venues: string[];
  projects: Record<string, string>;
  states: string[];
  brandings: string[];
  salespersons: Record<string, string>;
};
const EMPTY_OPTS: OptionMaps = { venues: [], projects: {}, states: [], brandings: [], salespersons: {} };

function accumulate(prev: OptionMaps, rows: FairDims[]): OptionMaps {
  const venues = new Set(prev.venues);
  const projects = { ...prev.projects };
  const states = new Set(prev.states);
  const brandings = new Set(prev.brandings);
  const salespersons = { ...prev.salespersons };
  let changed = false;
  for (const r of rows) {
    // Venue keys on the TEXT (venue_id is a dead scm.venues FK, NULL on modern SOs).
    if (r.venue && !venues.has(r.venue)) { venues.add(r.venue); changed = true; }
    if (r.project_id != null && r.project) {
      const label = r.project_start_date
        ? `${r.project} · ${formatDate(r.project_start_date)}${r.project_end_date ? `–${formatDate(r.project_end_date)}` : ""}`
        : r.project;
      if (projects[String(r.project_id)] !== label) { projects[String(r.project_id)] = label; changed = true; }
    }
    if (r.state && !states.has(r.state)) { states.add(r.state); changed = true; }
    if (r.branding && !brandings.has(r.branding)) { brandings.add(r.branding); changed = true; }
    if (r.salesperson_id && r.salesperson && salespersons[r.salesperson_id] !== r.salesperson) { salespersons[r.salesperson_id] = r.salesperson; changed = true; }
  }
  if (!changed) return prev;
  return {
    projects, salespersons,
    venues: [...venues].sort((a, b) => a.localeCompare(b)),
    states: [...states].sort((a, b) => a.localeCompare(b)),
    brandings: [...brandings].sort((a, b) => a.localeCompare(b)),
  };
}

const countActiveFilters = (f: FairFilters): number =>
  Object.values(f).filter((v) => v != null && v !== "").length;

/** Fair Report — mobile. Top bar (title + Filters), stage tabs, a card list per
 *  stage, and a full-screen per-order detail. */
export function MobileFairReport({ onBack }: { onBack: () => void }) {
  const { user } = useAuth();
  const allowed = useMemo(() => fairAllowedStages(user), [user]);
  const [stage, setStage] = useState<FairStage>(() => allowed[0] ?? "so");
  const [filters, setFilters] = useState<FairFilters>({});
  const [sheetOpen, setSheetOpen] = useState(false);
  // The tapped order (by SO doc_no — the detail endpoint is keyed on it, and DO
  // / Invoice rows carry so_no) → full-screen detail. null = list.
  const [openSo, setOpenSo] = useState<string | null>(null);

  // Clamp to a stage this user may actually open (fairAllowedStages), so a Sales
  // Director can never land on Delivery/Invoices even via stale state.
  const activeStage: FairStage = allowed.includes(stage) ? stage : (allowed[0] ?? "so");
  const q = useFairReport(activeStage, filters, allowed.includes(activeStage));
  const data = q.data;
  // A 403 (not in the report's cohort) must not read as a transient "retry" —
  // distinguish the permission denial from a load failure.
  const errorInfo = q.isError ? fairReportErrorInfo(q.error) : null;

  const [opts, setOpts] = useState<OptionMaps>(EMPTY_OPTS);
  useEffect(() => {
    if (!data?.rows?.length) return;
    setOpts((prev) => accumulate(prev, data.rows as FairDims[]));
  }, [data]);

  const rowCount = data?.rows?.length ?? 0;
  const activeFilterCount = countActiveFilters(filters);

  if (openSo) return <FairDetail docNo={openSo} onBack={() => setOpenSo(null)} />;

  return (
    <div className="hz-m" style={{ position: "relative", display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      <header className="hdr">
        <div className="hdr-row">
          <div>
            <button onClick={onBack} className="back" style={{ marginBottom: 4 }}>
              <span className="chev">‹</span> Back
            </button>
            <div className="eyebrow">Reports</div>
            <div className="scr-title">Sales Report</div>
          </div>
          <button onClick={() => setSheetOpen(true)} className="iconbtn" style={{ position: "relative", width: "auto", padding: "0 12px", gap: 6, fontFamily: "inherit", fontSize: 12.5, fontWeight: 700, color: "var(--ink2)" }} aria-label="Filters">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#414539" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 5h18M6 12h12M10 19h4" /></svg>
            Filters
            {activeFilterCount > 0 && (
              <span style={{ background: "var(--gold)", color: "#fff", fontSize: 9, fontWeight: 800, borderRadius: 999, minWidth: 15, height: 15, display: "inline-flex", alignItems: "center", justifyContent: "center", padding: "0 4px" }}>{activeFilterCount}</span>
            )}
          </button>
        </div>
        {/* Stage tabs — only the stages this user may open (fairAllowedStages). */}
        <div className="chips" style={{ marginTop: 11 }}>
          {STAGE_TABS.filter((t) => allowed.includes(t.key)).map((t) => (
            <button key={t.key} onClick={() => setStage(t.key)} className={activeStage === t.key ? "chip on" : "chip"}>{t.label}</button>
          ))}
        </div>
      </header>

      <div className="scroll hz-scroll" style={{ padding: 14, paddingBottom: 40 }}>
        <div style={{ fontSize: 10.5, color: "var(--mut)", background: "var(--bg)", border: "1px dashed var(--line)", borderRadius: 9, padding: "8px 10px", marginBottom: 11 }}>
          Confirmed orders only. Tap a card for the full order detail: lines, cost by category, deposit by tender and the SO → DO → Invoice linkage.
        </div>

        {!q.isLoading && !q.isError && (
          <div style={{ fontSize: 11.5, color: "var(--mut)", margin: "0 2px 11px" }}>
            <b style={{ color: "var(--ink)" }}>{rowCount}</b> {rowCount === 1 ? "record" : "records"}
          </div>
        )}

        {q.isLoading && (
          <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
            {[0, 1, 2].map((i) => (
              <div key={i} className="card"><div className="card-b ph" style={{ height: 104, borderRadius: 14 }} /></div>
            ))}
          </div>
        )}
        {errorInfo && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, background: "var(--red-bg)", border: "1px solid #e6cccc", borderRadius: 12, padding: "11px 13px" }}>
            <span style={{ fontSize: 12, color: "var(--red)", fontWeight: 600 }}>{errorInfo.message}</span>
            {!errorInfo.denied && (
              <button onClick={() => q.refetch()} style={{ border: "none", background: "transparent", color: "var(--red)", fontFamily: "inherit", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Retry</button>
            )}
          </div>
        )}

        {!q.isLoading && !q.isError && data && (
          <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
            {data.stage === "so" && rowCount > 0 && (
              <>
                <SoSummary s={data.summary} rows={data.rows} />
                {data.rows.map((r) => <SoCard key={r.so_no} r={r} onOpen={() => setOpenSo(r.so_no)} />)}
              </>
            )}
            {data.stage === "do" && rowCount > 0 && (
              <>
                <DoSummary s={data.summary} />
                {data.rows.map((r) => <DoCard key={r.do_no} r={r} onOpen={() => r.so_no && setOpenSo(r.so_no)} />)}
              </>
            )}
            {data.stage === "invoice" && rowCount > 0 && (
              <>
                <InvoiceSummary s={data.summary} />
                {data.rows.map((r) => <InvoiceCard key={r.inv_no} r={r} onOpen={() => r.so_no && setOpenSo(r.so_no)} />)}
              </>
            )}
            {data.stage === "pnl" && (data.meta.needs_project ? (
              <div className="empty">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#c2c6bd" strokeWidth="1.6"><path d="M4 4h16v4H4zM4 10h16v10H4z" /></svg>
                <div className="empty-t">Pick a fair</div>
                <div className="empty-s">Choose a Project / Fair in Filters to see its P&amp;L.</div>
              </div>
            ) : (
              <>
                <PnlSummaryCard s={data.summary} ratePresent={data.meta.rate_present} brand={data.meta.brand} />
                {data.rows.map((r) => <PnlCard key={r.so_no} r={r} onOpen={() => setOpenSo(r.so_no)} />)}
              </>
            ))}
            {rowCount === 0 && data.stage !== "pnl" && (
              <div className="empty">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#c2c6bd" strokeWidth="1.6"><path d="M4 4h16v4H4zM4 10h16v10H4z" /></svg>
                <div className="empty-t">No records</div>
                <div className="empty-s">No confirmed orders match the current filters.</div>
              </div>
            )}
          </div>
        )}
      </div>

      {sheetOpen && (
        <FilterSheet
          filters={filters}
          opts={opts}
          onApply={(f) => { setFilters(f); setSheetOpen(false); }}
          onClose={() => setSheetOpen(false)}
        />
      )}
    </div>
  );
}

// ── stage cards ───────────────────────────────────────────────────────────────
function BrandPill({ brand }: { brand: string | null }) {
  if (!brand) return null;
  return <span className="badge" style={{ background: "var(--amber-bg)", color: "var(--gold)" }}>{brand}</span>;
}
function CardStat({ k, v, tone }: { k: string; v: string; tone?: "err" }) {
  return (
    <div>
      <div style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: ".03em", textTransform: "uppercase", color: "var(--mut)" }}>{k}</div>
      <div className="money" style={{ fontSize: 13, fontWeight: 700, marginTop: 2, color: tone === "err" ? "var(--red)" : "var(--ink)" }}>{v}</div>
    </div>
  );
}
const cardCls = "card";
const cardStyle: React.CSSProperties = { padding: "13px 14px", cursor: "pointer" };
const statGrid: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8, marginTop: 11, paddingTop: 11, borderTop: "1px solid var(--line2)" };

function SoCard({ r, onOpen }: { r: FairSoRow; onOpen: () => void }) {
  const good = (r.margin_pct ?? 0) >= 0;
  return (
    <div className={cardCls} style={cardStyle} onClick={onOpen}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <BrandPill brand={r.branding} />
        <span className="money" style={{ fontSize: 13, fontWeight: 700, color: "var(--brand-d)" }}>{r.so_no}</span>
        <span className="money" style={{ marginLeft: "auto", fontSize: 13, fontWeight: 800, color: good ? "var(--green)" : "var(--red)" }}>{pct(r.margin_pct)}</span>
      </div>
      <div style={{ fontSize: 12, color: "var(--ink2)", marginTop: 6 }}>
        {r.venue ?? "—"} · <span style={{ color: "var(--mut)" }}>{formatDate(r.so_date)}</span> · {r.salesperson ?? "—"}
      </div>
      <div style={statGrid}>
        <CardStat k="Amount" v={cell(r.amount_sen)} />
        <CardStat k="Selling" v={cell(r.selling_sen)} />
        <CardStat k="SO Cost" v={cell(r.total_so_cost_sen)} />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 11, fontSize: 11.5 }}>
        <span style={{ color: "var(--ink2)" }}>Balance <b className="money">{rm(r.balance_sen)}</b></span>
        {r.below_deposit && <span className="badge b-amber">Below deposit</span>}
        <span style={{ marginLeft: "auto", color: "var(--brand)", fontWeight: 600 }}>Tap ›</span>
      </div>
    </div>
  );
}

function DoCard({ r, onOpen }: { r: FairDoRow; onOpen: () => void }) {
  const grew = r.cost_delta_sen > 0;
  return (
    <div className={cardCls} style={cardStyle} onClick={onOpen}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <BrandPill brand={r.branding} />
        <span className="money" style={{ fontSize: 13, fontWeight: 700, color: "var(--brand-d)" }}>{r.do_no}</span>
        {r.do_cost_is_legacy && <span className="badge b-grey">Legacy</span>}
        <span className="money" style={{ marginLeft: "auto", fontSize: 13, fontWeight: 800, color: grew ? "var(--red)" : "var(--green)" }}>{signedMoney(r.cost_delta_sen)}</span>
      </div>
      <div className="money" style={{ fontSize: 11, color: "var(--mut)", marginTop: 5 }}>{r.so_no ?? "—"}</div>
      <div style={{ fontSize: 12, color: "var(--ink2)", marginTop: 4 }}>
        {r.venue ?? "—"} · <span style={{ color: "var(--mut)" }}>{formatDate(r.delivery_date)}</span>
      </div>
      <div style={statGrid}>
        <CardStat k="SO Cost" v={cell(r.total_so_cost_sen)} />
        <CardStat k="DO Cost" v={cell(r.total_do_cost_sen)} />
        <CardStat k="Drift" v={pts(r.do_margin_pct, r.so_margin_pct)} tone={(r.do_margin_pct ?? 0) < (r.so_margin_pct ?? 0) ? "err" : undefined} />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 11, fontSize: 11.5 }}>
        <span style={{ color: "var(--ink2)" }}>Delivered</span>
        <span style={{ marginLeft: "auto", color: "var(--brand)", fontWeight: 600 }}>Tap ›</span>
      </div>
    </div>
  );
}

function InvoiceCard({ r, onOpen }: { r: FairInvoiceRow; onOpen: () => void }) {
  const good = (r.margin_pct ?? 0) >= 0;
  return (
    <div className={cardCls} style={cardStyle} onClick={onOpen}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <BrandPill brand={r.branding} />
        <span className="money" style={{ fontSize: 13, fontWeight: 700, color: "var(--brand-d)" }}>{r.inv_no}</span>
        <span className="money" style={{ marginLeft: "auto", fontSize: 13, fontWeight: 800, color: good ? "var(--green)" : "var(--red)" }}>{pct(r.margin_pct)}</span>
      </div>
      <div className="money" style={{ fontSize: 11, color: "var(--mut)", marginTop: 5 }}>SO {r.so_no ?? "—"}</div>
      <div style={{ fontSize: 12, color: "var(--ink2)", marginTop: 4 }}>
        {r.venue ?? "—"} · <span style={{ color: "var(--mut)" }}>{formatDate(r.invoice_date)}</span>
      </div>
      <div style={statGrid}>
        <CardStat k="Invoiced" v={cell(r.invoiced_sen)} />
        <CardStat k="DO Cost" v={cell(r.do_cost_sen)} />
        <CardStat k="Landed" v={cell(r.si_cost_sen)} />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 11, fontSize: 11.5 }}>
        <span style={{ color: "var(--ink2)" }}>SO → DO → SI</span>
        <span style={{ marginLeft: "auto", color: "var(--brand)", fontWeight: 600 }}>Tap ›</span>
      </div>
    </div>
  );
}

// ── per-stage summary cards ─────────────────────────────────────────────────
// SO / DO / Invoice each get a header summary (the desktop KpiRow —
// pages/scm-v2/FairReport.tsx:412-465 — plus the SO filtered-totals foot,
// 531-553). Before this only the P&L tab carried a summary card, so a manager
// scanning the SO / Delivery / Invoice tabs saw just "<n> records" with no
// Revenue / Outstanding / Paid / cost / margin header. Money math stays on the
// server; these cards only format `data.summary`. Rendered only when the stage
// has rows (an all-zero card above a "No records" empty state reads worse than
// the empty state alone).
function SoSummary({ s, rows }: { s: FairSoSummary; rows: FairSoRow[] }) {
  // Deposits collected — summed from the loaded rows, exactly as the desktop
  // KpiRow's "Paid" tile does (the summary echoes every matching row).
  const paid = rows.reduce((a, r) => a + Number(r.paid_total_sen ?? 0), 0);
  return (
    <div className={cardCls} style={{ padding: "13px 14px", background: "var(--bg)" }}>
      <div style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: ".03em", textTransform: "uppercase", color: "var(--mut)" }}>Sales Orders · {s.orders} {s.orders === 1 ? "order" : "orders"}</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 8, marginTop: 9 }}>
        <CardStat k={`Revenue · ${pct(s.margin_pct)}`} v={rm(s.total_amount_sen)} />
        <CardStat k="SO Cost" v={rm(s.total_so_cost_sen)} />
        <CardStat k="Outstanding" v={rm(s.total_balance_sen)} tone={s.total_balance_sen > 0 ? "err" : undefined} />
        <CardStat k="Paid" v={rm(paid)} />
      </div>
      {s.below_deposit_count > 0 && (
        <div style={{ fontSize: 10.5, color: "var(--mut)", marginTop: 9, lineHeight: 1.5 }}>
          {s.below_deposit_count} {s.below_deposit_count === 1 ? "order" : "orders"} below deposit.
        </div>
      )}
    </div>
  );
}

function DoSummary({ s }: { s: FairDoSummary }) {
  const grew = s.cost_delta_sen > 0;
  return (
    <div className={cardCls} style={{ padding: "13px 14px", background: "var(--bg)" }}>
      <div style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: ".03em", textTransform: "uppercase", color: "var(--mut)" }}>Delivery · {s.deliveries} {s.deliveries === 1 ? "delivery" : "deliveries"}</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8, marginTop: 9 }}>
        <CardStat k="SO Cost" v={rm(s.total_so_cost_sen)} />
        <CardStat k="DO Cost" v={rm(s.total_do_cost_sen)} />
        <CardStat k="Cost Drift" v={signedMoney(s.cost_delta_sen)} tone={grew ? "err" : undefined} />
      </div>
      {s.legacy_count > 0 && (
        <div style={{ fontSize: 10.5, color: "var(--mut)", marginTop: 9, lineHeight: 1.5 }}>
          {s.legacy_count} legacy (pre-FIFO) {s.legacy_count === 1 ? "delivery" : "deliveries"}.
        </div>
      )}
    </div>
  );
}

function InvoiceSummary({ s }: { s: FairInvoiceSummary }) {
  const good = (s.margin_pct ?? 0) >= 0;
  return (
    <div className={cardCls} style={{ padding: "13px 14px", background: "var(--bg)" }}>
      <div style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: ".03em", textTransform: "uppercase", color: "var(--mut)" }}>Invoices · {s.invoices}</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8, marginTop: 9 }}>
        <CardStat k="Invoiced" v={rm(s.total_invoiced_sen)} />
        <CardStat k="Landed" v={rm(s.total_si_cost_sen)} />
        <CardStat k="Margin" v={pct(s.margin_pct)} tone={good ? undefined : "err"} />
      </div>
    </div>
  );
}

function PnlSummaryCard({ s, ratePresent, brand }: { s: FairPnlSummary; ratePresent: boolean; brand: string | null }) {
  const net = s.net_profit_sen;
  return (
    <div className={cardCls} style={{ padding: "13px 14px", background: "var(--bg)" }}>
      <div style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: ".03em", textTransform: "uppercase", color: "var(--mut)" }}>Fair P&amp;L · {s.orders} orders</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 8, marginTop: 9 }}>
        <CardStat k="Revenue" v={rm(s.total_revenue_sen)} />
        <CardStat k={`Gross · ${pct(s.gross_margin_pct)}`} v={rm(s.gross_profit_sen)} tone={s.gross_profit_sen >= 0 ? undefined : "err"} />
        <CardStat k="Overhead" v={rm(s.overheads.total_overhead_sen)} />
        <CardStat k={`Net · ${pct(s.net_margin_pct)}`} v={rm(net)} tone={net >= 0 ? undefined : "err"} />
      </div>
      <div style={{ fontSize: 10.5, color: "var(--mut)", marginTop: 9, lineHeight: 1.5 }}>
        Overhead = transport {cell(s.overheads.transport_sen)} · merchandise {cell(s.overheads.merchandise_sen)} · commission {cell(s.overheads.commission_sen)} ({pct(s.overheads.commission_pct)}{s.overheads.commission_is_boost ? " boost" : ""}).
        {!ratePresent && ` No cost-rate card for ${brand ?? "this brand"} — overhead is zero.`}
      </div>
    </div>
  );
}

function PnlCard({ r, onOpen }: { r: FairPnlRow; onOpen: () => void }) {
  const good = r.gross_profit_sen >= 0;
  return (
    <div className={cardCls} style={cardStyle} onClick={onOpen}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <BrandPill brand={r.branding} />
        <span className="money" style={{ fontSize: 13, fontWeight: 700, color: "var(--brand-d)" }}>{r.so_no}</span>
        <span className="money" style={{ marginLeft: "auto", fontSize: 13, fontWeight: 800, color: good ? "var(--green)" : "var(--red)" }}>{pct(r.margin_pct)}</span>
      </div>
      <div style={{ fontSize: 12, color: "var(--ink2)", marginTop: 6 }}>
        {r.venue ?? "—"} · <span style={{ color: "var(--mut)" }}>{formatDate(r.so_date)}</span> · {r.salesperson ?? "—"}
      </div>
      <div style={statGrid}>
        <CardStat k="Revenue" v={cell(r.revenue_sen)} />
        <CardStat k={`COGS · ${r.effective_cost_stage}`} v={cell(r.effective_cost_sen)} />
        <CardStat k="Gross" v={cell(r.gross_profit_sen)} tone={good ? undefined : "err"} />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 11, fontSize: 11.5 }}>
        <span style={{ color: "var(--ink2)" }}>SO / DO / SI: {cell(r.so_cost_sen)} · {r.do_cost_sen == null ? "—" : cell(r.do_cost_sen)} · {r.si_cost_sen == null ? "—" : cell(r.si_cost_sen)}</span>
        <span style={{ marginLeft: "auto", color: "var(--brand)", fontWeight: 600 }}>Tap ›</span>
      </div>
    </div>
  );
}

// ── filter bottom-sheet ─────────────────────────────────────────────────────
function FilterSheet({ filters, opts, onApply, onClose }: {
  filters: FairFilters; opts: OptionMaps; onApply: (f: FairFilters) => void; onClose: () => void;
}) {
  // Edit a draft, commit on Apply (a select/date change shouldn't refetch on
  // every keystroke while the sheet is open) — matches the mockup's Apply button.
  const [draft, setDraft] = useState<FairFilters>(filters);
  const set = (patch: Partial<FairFilters>) => setDraft((d) => ({ ...d, ...patch }));
  const selStyle: React.CSSProperties = { width: "100%" };

  return (
    <div className="sheet-bd" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet" style={{ maxHeight: "88%" }}>
        <div className="grab" />
        <div className="sheet-head">
          <div>
            <div className="eyebrow">Filter</div>
            <div className="scr-title" style={{ fontSize: 17 }}>Sales Report</div>
          </div>
          <button className="sheet-x" onClick={onClose} aria-label="Close">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>
        <div className="sheet-scroll" style={{ gap: 11 }}>
          <FRow label="Venue">
            <select className="fld-i" style={selStyle} value={draft.venue ?? ""} onChange={(e) => set({ venue: e.target.value || undefined })}>
              <option value="">All venues</option>
              {opts.venues.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </FRow>
          <FRow label="State">
            <select className="fld-i" style={selStyle} value={draft.state ?? ""} onChange={(e) => set({ state: e.target.value || undefined })}>
              <option value="">All states</option>
              {opts.states.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </FRow>
          <FRow label="Project / Fair">
            <select className="fld-i" style={selStyle} value={draft.project != null ? String(draft.project) : ""} onChange={(e) => set({ project: e.target.value ? Number(e.target.value) : undefined })}>
              <option value="">All projects</option>
              {Object.entries(opts.projects).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
          </FRow>
          <FRow label="Month">
            <input type="month" className="fld-i" style={selStyle} value={draft.month ?? ""} onChange={(e) => set({ month: e.target.value || undefined })} />
          </FRow>
          <div className="fld-row">
            <FRow label="Date from">
              <DateField
                fullWidth
                className="fld-i"
                style={selStyle}
                value={draft.dateFrom ?? ""}
                onChange={(iso) => set({ dateFrom: iso || undefined })}
              />
            </FRow>
            <FRow label="Date to">
              <DateField
                fullWidth
                className="fld-i"
                style={selStyle}
                value={draft.dateTo ?? ""}
                onChange={(iso) => set({ dateTo: iso || undefined })}
              />
            </FRow>
          </div>
          <FRow label="Branding">
            <select className="fld-i" style={selStyle} value={draft.branding ?? ""} onChange={(e) => set({ branding: e.target.value || undefined })}>
              <option value="">All brands</option>
              {opts.brandings.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </FRow>
          <FRow label="Salesperson">
            <select className="fld-i" style={selStyle} value={draft.salesperson ?? ""} onChange={(e) => set({ salesperson: e.target.value || undefined })}>
              <option value="">All salespersons</option>
              {Object.entries(opts.salespersons).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
          </FRow>
          <div style={{ display: "flex", gap: 9, marginTop: 4 }}>
            <button className="btn-ghost" style={{ flex: 1 }} onClick={() => onApply({})}>Clear</button>
            <button className="btn" style={{ flex: 2 }} onClick={() => onApply(draft)}>Apply filters</button>
          </div>
        </div>
      </div>
    </div>
  );
}
function FRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="fld" style={{ flex: 1 }}>
      <label className="fld-l">{label}</label>
      {children}
    </div>
  );
}

// ── full-screen order detail ────────────────────────────────────────────────
function DetailHeadBtn({ onBack }: { onBack: () => void }) {
  return (
    <button onClick={onBack} aria-label="Back" style={{ background: "none", border: "none", color: "#fff", cursor: "pointer", fontSize: 24, lineHeight: 1, padding: "0 4px 0 0", fontFamily: "inherit" }}>←</button>
  );
}
const secH: React.CSSProperties = { fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".06em", color: "var(--mut)", margin: "20px 0 10px" };

function FairDetail({ docNo, onBack }: { docNo: string; onBack: () => void }) {
  const q = useFairReportDetail(docNo);
  const d = q.data;

  const merchantLine = (p: { merchant_provider: string | null; installment_months: number | null }): string => {
    const parts: string[] = [];
    if (p.merchant_provider) parts.push(p.merchant_provider);
    if (p.installment_months) parts.push(`${p.installment_months}-mo plan`);
    return parts.join(" · ") || "—";
  };

  return (
    <div className="hz-m" style={{ position: "fixed", inset: 0, display: "flex", flexDirection: "column", background: "var(--app-bg)" }}>
      {/* dark top bar — back · SO No + Order Form · status */}
      <header style={{ display: "flex", alignItems: "center", gap: 11, background: "var(--ink-dark)", color: "#fff", padding: "calc(env(safe-area-inset-top) + 13px) 14px 13px" }}>
        <DetailHeadBtn onBack={onBack} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="money" style={{ fontSize: 14, fontWeight: 700 }}>{d?.so_no ?? docNo}</div>
          <div style={{ fontSize: 10.5, color: "#9fb0a8", marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {d?.order_form ? `Order Form ${d.order_form} · ` : ""}Sales Order
          </div>
        </div>
        <span className="badge" style={{ background: "rgba(47,138,91,.22)", color: "#bfe6cf", border: "1px solid rgba(47,138,91,.55)" }}>Confirmed</span>
      </header>

      <div className="scroll hz-scroll" style={{ padding: 14, paddingBottom: 40 }}>
        {q.isLoading && <div style={{ fontSize: 13, color: "var(--mut)", padding: "8px 2px" }}>Loading…</div>}
        {q.isError && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, background: "var(--red-bg)", border: "1px solid #e6cccc", borderRadius: 12, padding: "11px 13px" }}>
            <span style={{ fontSize: 12, color: "var(--red)", fontWeight: 600 }}>Couldn't load this order</span>
            <button onClick={() => q.refetch()} style={{ border: "none", background: "transparent", color: "var(--red)", fontFamily: "inherit", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Retry</button>
          </div>
        )}
        {d && (
          <>
            {/* customer + brand + venue/date */}
            <div style={{ fontSize: 18, fontWeight: 800, color: "var(--ink)" }}>{d.salesperson ? d.salesperson : d.so_no}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 12, color: "var(--mut)", marginTop: 7 }}>
              <BrandPill brand={d.branding} />
              <span>{d.venue ? `${d.venue} · ` : ""}{formatDate(d.so_date)}</span>
            </div>
            {/* Project / Fair pill */}
            {d.project && (
              <div style={{ display: "flex", alignItems: "center", gap: 9, marginTop: 11, background: "var(--amber-bg)", border: "1px solid #ecdcb4", borderRadius: 10, padding: "9px 12px" }}>
                <span style={{ fontSize: 8.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".05em", color: "var(--gold)" }}>Project / Fair</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>{d.project}</span>
              </div>
            )}

            {/* 2×3 key figures */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 9, marginTop: 15 }}>
              <Fig k="Amount" v={rm(d.amount_sen)} />
              <Fig k="Selling" v={rm(d.selling_sen)} />
              <Fig k="Service Rev." v={rm(d.service_rev_sen)} />
              <Fig k="Total SO Cost" v={rm(d.total_so_cost_sen)} />
              <Fig k="Margin %" v={pct(d.margin_pct)} hi />
              <Fig k="Balance" v={rm(d.balance_sen)} />
            </div>

            {/* SO → DO → Invoice linkage, stacked vertically */}
            <div style={secH}>Document linkage · SO → DO → Invoice</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
              <FlowStep node="SO" label="Sales Order" no={d.linkage.so_no} sub={`Confirmed ${formatDate(d.so_date)}`} done />
              <FlowStep node="DO" label="Delivery Order" no={d.linkage.do_nos[0] ?? "—"} sub={d.linkage.do_nos.length ? (d.linkage.do_nos.length > 1 ? `+${d.linkage.do_nos.length - 1} more` : "Delivered") : "Not yet delivered"} done={!!d.linkage.do_nos.length} />
              <FlowStep node="SI" label="Invoice" no={d.linkage.invoice_nos[0] ?? "—"} sub={d.linkage.invoice_nos.length ? (d.linkage.invoice_nos.length > 1 ? `+${d.linkage.invoice_nos.length - 1} more` : "Invoiced") : "Not invoiced"} done={!!d.linkage.invoice_nos.length} />
            </div>

            {/* order lines — selling & cost, stacked */}
            <div style={secH}>Order lines · selling &amp; cost</div>
            {d.lines.length === 0 && <div style={{ fontSize: 12, color: "var(--mut)" }}>No lines.</div>}
            {d.lines.map((l, i) => {
              /* Item CODE + variant, same shared order-line rule as the desktop
                 Fair Report and every other order-line surface (owner
                 2026-07-24). Was item_code + a description badge — which showed
                 the code twice when the description contained it, and no variant. */
              const { primary, secondary } = orderLineIdentity({
                code: l.item_code,
                description: l.description,
                variant:
                  buildVariantSummary(l.item_group ?? "", l.variants ?? null) ||
                  (l.description2 ?? ""),
              });
              return (
              <div key={i} className="card" style={{ padding: "11px 12px", marginBottom: 9, ...(l.cancelled ? { opacity: 0.55, textDecoration: "line-through" } : null) }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "var(--ink)" }}>{primary || "—"}</div>
                {secondary && <div style={{ fontSize: 11, color: "var(--mut)", marginTop: 2 }}>{secondary}</div>}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 5, marginTop: 10 }}>
                  <LineCell k="Qty" v={l.qty == null ? "—" : String(l.qty)} />
                  <LineCell k="Unit sell" v={cell(l.unit_price_sen)} />
                  <LineCell k="Amount" v={cell(l.amount_sen)} />
                  <LineCell k="Unit cost" v={cell(l.unit_cost_sen)} cost />
                  <LineCell k="Line cost" v={cell(l.line_cost_sen)} cost />
                </div>
              </div>
              );
            })}

            {/* cost by category */}
            <div style={secH}>Cost by category</div>
            <div className="card" style={{ padding: 0, overflow: "hidden" }}>
              {catRows(d.cost_by_category).map(([label, v]) => (
                <div key={label} style={{ display: "flex", justifyContent: "space-between", padding: "9px 13px", fontSize: 12.5, borderBottom: "1px solid var(--line2)" }}>
                  <span style={{ color: "var(--ink2)" }}>{label}</span>
                  <span className="money">{cell(v)}</span>
                </div>
              ))}
              <div style={{ display: "flex", justifyContent: "space-between", padding: "9px 13px", fontSize: 12.5, fontWeight: 800, background: "var(--bg)" }}>
                <span>Total SO Cost</span>
                <span className="money">{rm(d.total_so_cost_sen)}</span>
              </div>
            </div>

            {/* deposit by tender (+ bank / plan) */}
            <div style={secH}>Deposit by tender</div>
            {d.payments.length === 0 && <div style={{ fontSize: 12, color: "var(--mut)" }}>No payments recorded.</div>}
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {d.payments.map((p, i) => (
                <div key={i} className="card" style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px" }}>
                  <span style={{ fontWeight: 700, fontSize: 12.5, minWidth: 74, color: "var(--ink)" }}>{p.tender ?? "—"}</span>
                  <span style={{ flex: 1, fontSize: 11, color: "var(--mut)" }}>{merchantLine(p)}</span>
                  <span className="money" style={{ fontWeight: 700 }}>{cell(p.amount_sen)}</span>
                </div>
              ))}
            </div>

            {/* payment method summary */}
            <div style={secH}>Payment method</div>
            <div className="card" style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 13px", fontSize: 13 }}>
              <span style={{ fontSize: 9, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".04em", color: "var(--mut)" }}>Method</span>
              <span>{d.payment_methods.join(" + ") || "—"}</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Fig({ k, v, hi }: { k: string; v: string; hi?: boolean }) {
  return (
    <div className="card" style={{ padding: "10px 11px", ...(hi ? { background: "linear-gradient(180deg,#fff,var(--green-bg))", borderColor: "#cfe4e0" } : null) }}>
      <div style={{ fontSize: 8.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".03em", color: "var(--mut)" }}>{k}</div>
      <div className="money" style={{ fontSize: 15, fontWeight: 800, marginTop: 4, color: hi ? "var(--green)" : "var(--ink)" }}>{v}</div>
    </div>
  );
}
function LineCell({ k, v, cost }: { k: string; v: string; cost?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 7.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".02em", color: "var(--mut)" }}>{k}</div>
      <div className="money" style={{ fontSize: 11.5, fontWeight: 700, marginTop: 2, color: cost ? "var(--mut)" : "var(--ink)" }}>{v}</div>
    </div>
  );
}
function FlowStep({ node, label, no, sub, done }: { node: string; label: string; no: string; sub: string; done: boolean }) {
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "stretch" }}>
      <div style={{ flex: "none", width: 28, height: 28, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 800, background: done ? "var(--green-bg)" : "#fff", color: done ? "var(--green)" : "var(--mut2)", border: done ? "2px solid var(--green)" : "2px dashed var(--mut2)" }}>{node}</div>
      <div style={{ flex: 1, background: done ? "#f2f8f6" : "#fff", border: done ? "1px solid #cfe4e0" : "1px dashed var(--line-card)", borderRadius: 11, padding: "9px 12px" }}>
        <div style={{ fontSize: 9, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".05em", color: "var(--mut)" }}>{label}</div>
        <div className="money" style={{ fontSize: 13, fontWeight: 700, color: done ? "var(--brand-d)" : "var(--mut2)", marginTop: 2 }}>{no}</div>
        <div style={{ fontSize: 11, color: "var(--mut)", marginTop: 1 }}>{sub}</div>
      </div>
    </div>
  );
}

export default MobileFairReport;

import { DateField } from "../vendor/scm/components/DateField";