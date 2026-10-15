/* Payment (layout P7): the enabled methods as separate buttons (QR/DuitNow,
 * Credit Card, Debit Card, E-wallet; Cash only when General enables it),
 * optional reference per method, split across two methods with the balance
 * auto-filled, cash tendered keypad with 5 sen rounding and change.
 * Complete only at balance 0. Also used for an exchange's "Customer pays". */
import { useEffect, useMemo, useState } from "react";
import { POS_PAYMENT_METHODS, posMethodLabel, type PosPaymentMethod } from "@shared/pos-vocabulary";
import type { GeneralSettings } from "@shared/pos-settings";
import { cartTotals, type Cart } from "../cart";
import { cashInvolved, checkPayment, splitBalance, type PaymentDraft } from "../sale";
import { Modal, NumKeys } from "./Modal";

const rm = (sen: number) => (sen / 100).toFixed(2);

export function PaymentPopup({ cart, sstRate, roundingOnCash, general, title, onComplete, onClose }: {
  cart: Cart;
  sstRate: number;
  roundingOnCash: boolean;
  general: GeneralSettings;
  title?: string;
  onComplete: (pays: PaymentDraft[]) => void;
  onClose: () => void;
}) {
  const methods = POS_PAYMENT_METHODS.filter((m) => general.payment_methods[m]);
  const [split, setSplit] = useState(false);
  const [first, setFirst] = useState<PosPaymentMethod | null>(null);
  const [second, setSecond] = useState<PosPaymentMethod | null>(null);
  const [firstAmt, setFirstAmt] = useState("");
  const [ref1, setRef1] = useState("");
  const [ref2, setRef2] = useState("");
  const [tendered, setTendered] = useState("");
  const [busy, setBusy] = useState(false);

  const pays = useMemo((): PaymentDraft[] => {
    if (!first) return [];
    const base = cartTotals(cart, sstRate, roundingOnCash && (first === "CASH" || second === "CASH")).total_sen;
    const tend = tendered.trim() === "" ? null : Math.round(Number(tendered) * 100);
    if (!split) return [{ method: first, amount_sen: base, reference: ref1, tendered_sen: first === "CASH" ? tend : null }];
    const a1 = Math.round((Number(firstAmt) || 0) * 100);
    const out: PaymentDraft[] = [{ method: first, amount_sen: a1, reference: ref1, tendered_sen: first === "CASH" ? tend : null }];
    if (second) out.push({ method: second, amount_sen: splitBalance(base, a1), reference: ref2, tendered_sen: second === "CASH" ? tend : null });
    return out;
  }, [cart, sstRate, roundingOnCash, first, second, split, firstAmt, ref1, ref2, tendered]);

  const check = checkPayment(cart, sstRate, roundingOnCash, pays);
  const total = check.total_sen;
  useEffect(() => { if (!split) { setSecond(null); setFirstAmt(""); } }, [split]);

  const complete = () => { if (check.ok && !busy) { setBusy(true); onComplete(pays); } };
  const cashLine = cashInvolved(pays);

  return (
    <Modal title={title ?? "Payment"} onClose={onClose} width={720} footer={
      <div className="row">
        <span className={check.ok ? "ok-text" : "err"}>{check.ok ? (check.change_sen > 0 ? `Change RM ${rm(check.change_sen)}` : "Ready") : check.reason}</span>
        <span className="grow" />
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary focus-first" disabled={!check.ok || busy} onClick={complete}>Complete (Enter)</button>
      </div>
    }>
      <div className="pay-total">
        <span className="lbl">Amount due</span>
        <span className="big">RM {rm(total)}</span>
        {check.rounding_sen !== 0 && <span className="muted small">rounded {check.rounding_sen > 0 ? "+" : ""}{rm(check.rounding_sen)} for cash</span>}
      </div>
      <div className="pay-methods">
        {methods.map((m) => (
          <button key={m} type="button" className={`tile pay${first === m ? " selected" : ""}`} onClick={() => { setFirst(m); if (second === m) setSecond(null); }}>{posMethodLabel(m)}{m === "CASH" && <small>5 sen rounding</small>}</button>
        ))}
      </div>
      <label className="row small" style={{ marginTop: 10 }}><input type="checkbox" checked={split} onChange={(e) => setSplit(e.target.checked)} /> Split payment (two methods)</label>
      {first && (
        <div className="pay-lines">
          <div className="pay-line">
            <b>{posMethodLabel(first)}</b>
            {split ? <input className="kbd-input" inputMode="decimal" placeholder="amount RM" value={firstAmt} onChange={(e) => setFirstAmt(e.target.value)} /> : <span className="money">RM {rm(pays[0]?.amount_sen ?? 0)}</span>}
            <input className="kbd-input" placeholder="ref / approval no (optional)" value={ref1} onChange={(e) => setRef1(e.target.value)} />
          </div>
          {split && (
            <div className="pay-line">
              <select className="kbd-input" value={second ?? ""} onChange={(e) => setSecond((e.target.value || null) as PosPaymentMethod | null)}>
                <option value="">second method</option>
                {methods.filter((m) => m !== first).map((m) => <option key={m} value={m}>{posMethodLabel(m)}</option>)}
              </select>
              <span className="money">RM {rm(pays[1]?.amount_sen ?? splitBalance(total, Math.round((Number(firstAmt) || 0) * 100)))}</span>
              <input className="kbd-input" placeholder="ref (optional)" value={ref2} onChange={(e) => setRef2(e.target.value)} />
            </div>
          )}
        </div>
      )}
      {cashLine && (
        <div className="row" style={{ marginTop: 10, alignItems: "flex-start" }}>
          <div style={{ width: 260 }}>
            <div className="lbl">Cash tendered</div>
            <div className="big-input">RM {tendered || "0"}</div>
            <NumKeys value={tendered} onChange={setTendered} onEnter={complete} allowKeyboard={false} />
          </div>
          <div className="row" style={{ flexWrap: "wrap", gap: 6, alignSelf: "center" }}>
            {[10, 20, 50, 100, 200].map((n) => <button key={n} type="button" className="btn" onClick={() => setTendered(String(n))}>RM{n}</button>)}
            <button type="button" className="btn" onClick={() => setTendered(rm(pays.find((p) => p.method === "CASH")?.amount_sen ?? total))}>Exact</button>
          </div>
        </div>
      )}
      <p className="muted small" style={{ marginBottom: 0 }}>The card / QR machine is the bank's; key the approval number if you want it on the receipt. No cash drawer.</p>
    </Modal>
  );
}
