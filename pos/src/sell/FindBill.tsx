/* Find bill (layout P12): search by receipt no / amount / customer, filters
 * Today / cashier / status; the detail with PAID / VOID / RETURN and SYNCED /
 * NOT SYNCED; Reprint (COPY), E-receipt, Change salesman, Return / Exchange,
 * Void bill (supervisor PIN + reason). */
import { useEffect, useMemo, useState } from "react";
import { posMethodLabel } from "@shared/pos-vocabulary";
import { fmtMyt } from "../loginRules";
import { printSale, shareReceipt } from "../printing";
import { mytDate, voidAllowed, voidSale, type SaleRecord } from "../sale";
import { applyStock, listSales, saveSale } from "../salesStore";
import type { BundleCashier, DeviceState } from "../types";
import { Modal } from "./Modal";
import { SupervisorPin } from "./SupervisorPin";

const rm = (sen: number) => (sen < 0 ? `-${(-sen / 100).toFixed(2)}` : (sen / 100).toFixed(2));

export function FindBill({ state, initialQuery, onReturn, onClose, say }: {
  state: DeviceState;
  initialQuery: string;
  onReturn: (sale: SaleRecord) => void;
  onClose: () => void;
  say: (text: string, bad?: boolean) => void;
}) {
  const [all, setAll] = useState<SaleRecord[]>([]);
  const [q, setQ] = useState(initialQuery);
  const [todayOnly, setTodayOnly] = useState(true);
  const [cashier, setCashier] = useState("");
  const [status, setStatus] = useState<"" | "PAID" | "VOID" | "RETURN">("");
  const [sel, setSel] = useState<SaleRecord | null>(null);
  const [voidStep, setVoidStep] = useState<null | "pin" | { sup: BundleCashier }>(null);
  const [reason, setReason] = useState("");
  const [salesmanPick, setSalesmanPick] = useState(false);
  const reload = () => listSales().then((rows) => { setAll(rows.sort((a, b) => (a.sold_at < b.sold_at ? 1 : -1))); }).catch(() => say("Could not read bills", true));
  useEffect(() => { void reload(); }, []);

  const today = mytDate(new Date().toISOString());
  const rows = useMemo(() => {
    const t = q.trim().toLowerCase();
    const amt = Number(t.replace(/[^0-9.]/g, ""));
    return all.filter((s) => {
      if (s.is_test && !state.test_mode) return false;
      if (todayOnly && mytDate(s.sold_at) !== today) return false;
      if (cashier && s.cashier_name !== cashier) return false;
      if (status === "VOID" && s.status !== "VOID") return false;
      if (status === "RETURN" && (s.type !== "RETURN" || s.status === "VOID")) return false;
      if (status === "PAID" && (s.status !== "PAID" || s.type !== "SALE")) return false;
      if (!t) return true;
      if (s.receipt_no.toLowerCase().includes(t)) return true;
      if ((s.customer_name ?? "").toLowerCase().includes(t) || (s.customer_phone ?? "").includes(t)) return true;
      if (Number.isFinite(amt) && amt > 0 && Math.abs(Math.abs(s.total_sen) / 100 - amt) < 0.005) return true;
      return false;
    });
  }, [all, q, todayOnly, cashier, status, today, state.test_mode]);
  const cashiers = Array.from(new Set(all.map((s) => s.cashier_name))).sort();

  async function doVoid(sup: BundleCashier) {
    if (!sel) return;
    const chk = voidAllowed(sel, state.bundle.settings.general.void_rule, today);
    if (!chk.ok) { say(chk.reason, true); return; }
    if (!reason.trim()) { say("A reason is required", true); return; }
    const v = voidSale(sel, sup.name, reason.trim(), new Date().toISOString());
    await saveSale(v);
    await applyStock(sel, true);
    setSel(v);
    setVoidStep(null);
    setReason("");
    say(`${v.receipt_no} voided; stock restored on this device`);
    const r = await printSale(v, state, "ORIGINAL");
    if (!r.ok) say(`VOID receipt not printed: ${r.reason}`, true);
    void reload();
  }

  async function changeSalesman(sm: { id: number; name: string } | null) {
    if (!sel) return;
    const next = { ...sel, salesman_id: sm?.id ?? null, salesman_name: sm?.name ?? null, synced_at: null };
    await saveSale(next);
    setSel(next);
    setSalesmanPick(false);
    say("Salesman changed");
    void reload();
  }

  const badge = (s: SaleRecord) => (s.status === "VOID" ? <span className="pill outb">VOID</span> : s.type === "RETURN" ? <span className="pill auto">RETURN</span> : <span className="pill okp">PAID</span>);

  return (
    <Modal title="Find bill" onClose={onClose} width={960}>
      <div className="find">
        <div className="find-list">
          <input className="kbd-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Receipt no, amount or customer" autoFocus />
          <div className="row small" style={{ margin: "6px 0" }}>
            <label><input type="checkbox" checked={todayOnly} onChange={(e) => setTodayOnly(e.target.checked)} /> Today</label>
            <select className="kbd-input" style={{ minHeight: 32, width: "auto" }} value={cashier} onChange={(e) => setCashier(e.target.value)}><option value="">All cashiers</option>{cashiers.map((c) => <option key={c}>{c}</option>)}</select>
            <select className="kbd-input" style={{ minHeight: 32, width: "auto" }} value={status} onChange={(e) => setStatus(e.target.value as typeof status)}><option value="">All</option><option value="PAID">Paid</option><option value="VOID">Void</option><option value="RETURN">Return</option></select>
          </div>
          <div className="find-rows">
            {rows.length === 0 && <div className="muted" style={{ padding: 12 }}>No bill matches.</div>}
            {rows.map((s) => (
              <button key={s.uuid} type="button" className={`search-row${sel?.uuid === s.uuid ? " sel" : ""}`} onClick={() => setSel(s)}>
                <span className="grow"><b className="mono">{s.receipt_no}</b> <span className="muted">{fmtMyt(s.sold_at)} · {s.cashier_name}{s.customer_name ? ` · ${s.customer_name}` : ""}</span></span>
                {badge(s)}
                <span className="money">RM {rm(s.total_sen)}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="find-detail">
          {!sel ? <div className="muted">Pick a bill to see its receipt.</div> : (
            <>
              <div className="row"><b className="mono">{sel.receipt_no}</b>{badge(sel)}<span className={`pill ${sel.synced_at ? "okp" : "warnp"}`}>{sel.synced_at ? "SYNCED" : "NOT SYNCED"}</span>{sel.is_test && <span className="pill warnp">TEST</span>}</div>
              <div className="muted small">{fmtMyt(sel.sold_at)} · Terminal {sel.terminal_code} · Cashier {sel.cashier_name} · Salesman {sel.salesman_name ?? "Booth"}{sel.ref_receipt_no ? ` · Ref ${sel.ref_receipt_no}` : ""}</div>
              <table className="cart" style={{ marginTop: 8 }}>
                <thead><tr><th>Item</th><th className="num">Qty</th><th className="num">Price</th><th>Disc</th><th className="num">Amount</th></tr></thead>
                <tbody>
                  {sel.lines.map((l) => (
                    <tr key={l.line_no}><td><span className="mono">{l.code}</span> {l.description}</td><td className="num">{l.qty}</td><td className="num">{rm(l.unit_price_sen)}</td><td className={l.is_foc ? "foc" : l.discount_amount_sen ? "disc" : ""}>{l.is_foc ? "FOC" : l.discount_type === "PCT" ? `-${l.discount_value}%` : l.discount_type === "RM" ? `-RM${l.discount_value}` : "--"}</td><td className="num money">{rm(l.amount_sen)}</td></tr>
                  ))}
                </tbody>
              </table>
              <div className="row small" style={{ marginTop: 8, flexWrap: "wrap", gap: 14 }}>
                <span>Sub total <b>{rm(sel.subtotal_sen)}</b></span>
                <span>Discount <b>{rm(sel.item_discount_sen + sel.bill_discount_sen)}</b></span>
                <span>SST {sel.sst_applied ? `${sel.sst_rate}%` : ""} <b>{rm(sel.sst_amount_sen)}</b></span>
                {sel.rounding_sen !== 0 && <span>Rounding <b>{rm(sel.rounding_sen)}</b></span>}
                <span>Total <b>RM {rm(sel.total_sen)}</b></span>
                {sel.payments.map((p, i) => <span key={i}>{posMethodLabel(p.method)} <b>{rm(p.amount_sen)}</b>{p.reference ? ` (${p.reference})` : ""}</span>)}
              </div>
              {sel.status === "VOID" && <div className="err" style={{ marginTop: 6 }}>Void {sel.voided_at ? fmtMyt(sel.voided_at) : ""} by {sel.void_by}: {sel.void_reason}</div>}
              <div className="row" style={{ marginTop: 12, flexWrap: "wrap" }}>
                <button type="button" className="btn" onClick={() => printSale(sel, state, "COPY").then((r) => say(r.ok ? "Copy printed" : r.reason, !r.ok))}>Reprint (COPY)</button>
                <button type="button" className="btn" onClick={() => void shareReceipt(sel, state)}>E-receipt</button>
                {sel.status === "PAID" && sel.type === "SALE" && <button type="button" className="btn" onClick={() => setSalesmanPick(true)}>Change salesman</button>}
                {sel.status === "PAID" && sel.type === "SALE" && <button type="button" className="btn" onClick={() => onReturn(sel)}>Return / Exchange</button>}
                {sel.status === "PAID" && <button type="button" className="btn danger" onClick={() => setVoidStep("pin")}>Void bill…</button>}
              </div>
              {voidStep && typeof voidStep === "object" && (
                <div className="card" style={{ marginTop: 10 }}>
                  <div className="lbl">Void {sel.receipt_no} · approved by {voidStep.sup.name}</div>
                  <input className="kbd-input" style={{ marginTop: 6 }} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (required)" autoFocus onKeyDown={(e) => { if (e.key === "Enter") void doVoid(voidStep.sup); }} />
                  <div className="row" style={{ marginTop: 8 }}><button type="button" className="btn" onClick={() => setVoidStep(null)}>Cancel</button><span className="grow" /><button type="button" className="btn danger" disabled={!reason.trim()} onClick={() => void doVoid(voidStep.sup)}>Void bill</button></div>
                </div>
              )}
              {salesmanPick && (
                <div className="card" style={{ marginTop: 10 }}>
                  <div className="lbl">Credit this bill to</div>
                  <div className="row" style={{ flexWrap: "wrap", marginTop: 6 }}>
                    <button type="button" className="btn" onClick={() => void changeSalesman(null)}>Booth</button>
                    {state.bundle.cashiers.filter((c) => c.role === "PARTTIME").map((c) => <button key={c.id} type="button" className="btn" onClick={() => void changeSalesman({ id: c.id, name: c.name })}>{c.name}</button>)}
                    <button type="button" className="btn link" onClick={() => setSalesmanPick(false)}>Cancel</button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
      {voidStep === "pin" && <SupervisorPin why={`Void ${sel?.receipt_no ?? ""}: stock is restored and the ERP is told on sync.`} cashiers={state.bundle.cashiers} onOk={(sup) => setVoidStep({ sup })} onClose={() => setVoidStep(null)} />}
    </Modal>
  );
}
