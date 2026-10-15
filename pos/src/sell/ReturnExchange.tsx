/* Return / Exchange (layout P16), supervisor PIN first. Scan the original
 * receipt barcode or type the number; tick lines, set the return qty and
 * reason (FOC lines cannot come back); add new items by scan or search for
 * an exchange. The difference is "Customer pays" (paid through P7) or a
 * refund to the original method. Saved as a RETURN receipt referencing the
 * original; returned stock comes back, new items deduct. */
import { useEffect, useMemo, useState } from "react";
import { posMethodLabel } from "@shared/pos-vocabulary";
import { addItem, emptyCart, findByBarcode, removeLine, type Cart } from "../cart";
import { fmtMyt } from "../loginRules";
import { returnTotals, returnWindowOpen, returnableQty, type PaymentDraft, type ReturnPick, type SaleRecord } from "../sale";
import { listSales } from "../salesStore";
import type { BundleCashier, BundleItem, DeviceState } from "../types";
import { Modal } from "./Modal";
import { PaymentPopup } from "./Payment";
import { ItemSearch } from "./Popups";
import { SupervisorPin } from "./SupervisorPin";

const rm = (sen: number) => (sen < 0 ? `-${(-sen / 100).toFixed(2)}` : (sen / 100).toFixed(2));

export function ReturnExchange({ state, initial, onSave, onClose, say }: {
  state: DeviceState;
  initial: SaleRecord | null;
  onSave: (original: SaleRecord, picks: ReturnPick[], newCart: Cart | null, pays: PaymentDraft[], supervisor: BundleCashier) => Promise<void>;
  onClose: () => void;
  say: (text: string, bad?: boolean) => void;
}) {
  const b = state.bundle;
  const g = b.settings.general;
  const [sup, setSup] = useState<BundleCashier | null>(null);
  const [all, setAll] = useState<SaleRecord[]>([]);
  const [lookup, setLookup] = useState("");
  const [original, setOriginal] = useState<SaleRecord | null>(initial);
  const [picks, setPicks] = useState<Record<number, ReturnPick>>({});
  const [newCart, setNewCart] = useState<Cart>(() => emptyCart(false));
  const [scan, setScan] = useState("");
  const [search, setSearch] = useState<string | null>(null);
  const [pay, setPay] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { listSales().then(setAll).catch(() => {}); }, []);

  const returnable = useMemo(() => (original ? returnableQty(original, all) : new Map<number, number>()), [original, all]);
  const pickList = Object.values(picks).filter((p) => p.qty > 0);
  const totals = original ? returnTotals(original, pickList, newCart.lines.length ? newCart : null, b.settings.sst_receipt.sst_rate) : null;
  const window = original ? returnWindowOpen(original, g.return_window, b.event.end_date, new Date().toISOString()) : null;

  function find(no: string) {
    const t = no.trim().toUpperCase();
    const s = all.find((x) => x.receipt_no.toUpperCase() === t);
    if (!s) { say(`Receipt ${t} not found on this terminal`, true); return; }
    setOriginal(s);
    setPicks({});
    setLookup("");
  }
  const setPick = (line_no: number, patch: Partial<ReturnPick>) => setPicks((p) => ({ ...p, [line_no]: { line_no, qty: 0, reason: "", ...p[line_no], ...patch } }));
  const canSave = !!original && window?.ok === true && (pickList.length > 0 || newCart.lines.length > 0) && pickList.every((p) => p.reason.trim());

  async function save(pays: PaymentDraft[]) {
    if (!original || !sup || !canSave) return;
    setBusy(true);
    try {
      await onSave(original, pickList.map((p) => ({ ...p, reason: p.reason.trim() })), newCart.lines.length ? newCart : null, pays, sup);
    } finally {
      setBusy(false);
    }
  }

  if (!sup) return <SupervisorPin why="Return / exchange needs a supervisor." cashiers={b.cashiers} onOk={setSup} onClose={onClose} />;

  return (
    <Modal title="Return / Exchange" onClose={onClose} width={960}>
      {!original && (
        <div className="row">
          <input className="kbd-input grow" value={lookup} onChange={(e) => setLookup(e.target.value)} placeholder="Scan the receipt barcode or type the receipt no" autoFocus onKeyDown={(e) => { if (e.key === "Enter") find(lookup); }} />
          <button type="button" className="btn primary" onClick={() => find(lookup)}>Find</button>
        </div>
      )}
      {original && (
        <div className="ret">
          <div>
            <div className="row"><b className="mono">{original.receipt_no}</b><span className="muted">{fmtMyt(original.sold_at)} · {original.cashier_name} · paid by {original.payments.map((p) => posMethodLabel(p.method)).join(" + ")}</span><span className="grow" /><button type="button" className="btn link" onClick={() => { setOriginal(null); setPicks({}); }}>Other receipt</button></div>
            {window && !window.ok && <div className="err">{window.reason}</div>}
            <table className="cart" style={{ marginTop: 6 }}>
              <thead><tr><th /><th>Item</th><th className="num">Sold</th><th className="num">Return qty</th><th>Reason</th></tr></thead>
              <tbody>
                {original.lines.map((l) => {
                  const max = returnable.get(l.line_no) ?? 0;
                  const p = picks[l.line_no];
                  return (
                    <tr key={l.line_no} className={p && p.qty > 0 ? "sel" : ""}>
                      <td><input type="checkbox" disabled={l.is_foc || max === 0} checked={!!p && p.qty > 0} onChange={(e) => setPick(l.line_no, { qty: e.target.checked ? max : 0 })} /></td>
                      <td><span className="mono">{l.code}</span> {l.description}{l.is_foc && <span className="pill okp" style={{ marginLeft: 6 }}>FOC · no refund</span>}{!l.is_foc && max < l.qty && <span className="muted"> ({l.qty - max} already returned)</span>}</td>
                      <td className="num">{l.qty}</td>
                      <td className="num"><input type="number" min={0} max={max} className="kbd-input" style={{ width: 80, minHeight: 36 }} disabled={l.is_foc || max === 0} value={p?.qty ?? 0} onChange={(e) => setPick(l.line_no, { qty: Math.max(0, Math.min(max, Math.floor(Number(e.target.value) || 0))) })} /></td>
                      <td><input className="kbd-input" style={{ minHeight: 36 }} disabled={!p || p.qty === 0} value={p?.reason ?? ""} onChange={(e) => setPick(l.line_no, { reason: e.target.value })} placeholder="reason" /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div>
            <div className="lbl">Exchange: new item(s)</div>
            <div className="row" style={{ marginTop: 4 }}>
              <input className="kbd-input grow" value={scan} onChange={(e) => setScan(e.target.value)} placeholder="Scan or type to search" onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                const it = findByBarcode(b.items, scan);
                if (it) { setNewCart((c) => addItem(c, it, true).cart); setScan(""); } else { setSearch(scan); setScan(""); }
              }} />
              <button type="button" className="btn" onClick={() => setSearch("")}>Search</button>
            </div>
            {newCart.lines.length > 0 && (
              <table className="cart" style={{ marginTop: 6 }}>
                <tbody>{newCart.lines.map((l) => <tr key={l.line_no}><td><span className="mono">{l.code}</span> {l.description}</td><td className="num">{l.qty}</td><td className="num money">{rm(l.qty * l.unit_price_sen)}</td><td><button type="button" className="btn link" onClick={() => setNewCart((c) => removeLine(c, l.line_no))}>remove</button></td></tr>)}</tbody>
              </table>
            )}
            {totals && (
              <div className="card" style={{ marginTop: 10 }}>
                <div className="row small"><span>Refund value</span><span className="grow" /><b>RM {rm(totals.refund_sen)}</b></div>
                <div className="row small"><span>New items</span><span className="grow" /><b>RM {rm(totals.new_sen)}</b></div>
                <div className="row" style={{ fontSize: 18 }}><span>{totals.difference_sen > 0 ? "Customer pays" : totals.difference_sen < 0 ? `Refund to ${posMethodLabel(original.payments[0]?.method ?? "QR")}` : "No difference"}</span><span className="grow" /><b>RM {rm(Math.abs(totals.difference_sen))}</b></div>
              </div>
            )}
            <div className="row" style={{ marginTop: 10 }}>
              <span className="muted small">Approved by {sup.name}</span>
              <span className="grow" />
              <button type="button" className="btn" onClick={onClose}>Cancel</button>
              <button type="button" className="btn primary" disabled={!canSave || busy} onClick={() => { if (totals && totals.difference_sen > 0) setPay(true); else void save([]); }}>
                {totals && totals.difference_sen > 0 ? "Collect payment" : "Save return"}
              </button>
            </div>
          </div>
        </div>
      )}
      {search !== null && <ItemSearch items={b.items} initial={search} onPick={(it: BundleItem) => { setNewCart((c) => addItem(c, it, true).cart); setSearch(null); }} onClose={() => setSearch(null)} />}
      {pay && original && totals && (
        <PaymentPopup
          cart={{ ...emptyCart(false), lines: [{ line_no: 1, item_id: 0, product_id: "", code: "DIFF", description: "Exchange difference", receipt_name: "Exchange difference", uom: "UNIT", qty: 1, unit_price_sen: totals.difference_sen, original_price_sen: null, override_by: null, override_reason: null, discount: null, is_foc: false, foc_allowed: false, max_manual_disc_pct: null, stock_qty: 0 }] }}
          sstRate={0}
          roundingOnCash={b.settings.sst_receipt.rounding_on_cash}
          general={g}
          title={`Customer pays RM ${rm(totals.difference_sen)}`}
          onComplete={(pays) => { setPay(false); void save(pays); }}
          onClose={() => setPay(false)}
        />
      )}
    </Modal>
  );
}
