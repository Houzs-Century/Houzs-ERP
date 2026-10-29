/* The sell screen's popups: item search (P3), qty and price override (P4),
 * discounts (P5), salesman (P6), hold / recall (P11). */
import { useEffect, useMemo, useState } from "react";
import { cartTotals, discLabel, manualDiscountNeedsSupervisor, searchItems, type Cart, type CartLine, type Discount, type HeldBill } from "../cart";
import { fmtMyt } from "../loginRules";
import type { BundleCashier, BundleItem } from "../types";
import { Modal, NumKeys } from "./Modal";

const rm = (sen: number) => (sen / 100).toFixed(2);

/* ── P3 ─────────────────────────────────────────────────────────────────── */
export function ItemSearch({ items, initial, onPick, onClose }: { items: readonly BundleItem[]; initial: string; onPick: (i: BundleItem) => void; onClose: () => void }) {
  const [q, setQ] = useState(initial);
  const [manual, setManual] = useState(false);
  const [sel, setSel] = useState(0);
  const rows = useMemo(() => searchItems(items, q), [items, q]);
  useEffect(() => setSel(0), [q]);
  const pick = (i: BundleItem | undefined) => { if (i) onPick(i); };
  return (
    <Modal title="Item search" onClose={onClose} width={720}>
      <div className="row">
        <input
          className="kbd-input grow"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Barcode, item code or name; leave empty to see every item"
          inputMode={manual ? "numeric" : "text"}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(rows.length - 1, s + 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
            else if (e.key === "Enter") { e.preventDefault(); const exact = items.find((i) => i.barcodes.includes(q.trim())); pick(exact ?? rows[sel]); }
          }}
        />
        <button type="button" className="btn" onClick={() => setManual((v) => !v)}>{manual ? "Keyboard" : "Enter barcode manually"}</button>
      </div>
      <div className="search-rows">
        {rows.length === 0 && <div className="muted" style={{ padding: 12 }}>{q.trim().length === 0 ? "No items on this device yet. Refresh catalog in Settings." : q.trim().length < 2 ? "Type at least 2 characters, or clear the box to see every item." : "No item matches."}</div>}
        {rows.map((i, idx) => (
          <button key={i.id} type="button" className={`search-row${idx === sel ? " sel" : ""}${i.stock_qty <= 0 ? " out" : ""}`} onClick={() => pick(i)} onMouseEnter={() => setSel(idx)}>
            <span className="grow">
              <b>{i.name}</b>
              <span className="muted"> {i.code} · {i.barcodes.join(" ") || "no barcode"}</span>
            </span>
            {i.discount && <span className="pill auto">AUTO {i.discount.type === "PCT" ? `-${i.discount.value}%` : `-RM${i.discount.value}`}</span>}
            {i.stock_qty <= 0 ? <span className="pill outb">OUT</span> : <span className="muted">stock {i.stock_qty}</span>}
            <span className="money">RM {rm(i.price_sen)}</span>
          </button>
        ))}
      </div>
      <p className="muted small" style={{ marginBottom: 0 }}>Up / Down then Enter adds. A full barcode + Enter adds directly. OUT items still sell; the ERP flags them on sync.</p>
    </Modal>
  );
}

/* ── P4 qty ─────────────────────────────────────────────────────────────── */
export function QtyPopup({ line, onOk, onClose }: { line: CartLine; onOk: (qty: number) => void; onClose: () => void }) {
  const [v, setV] = useState(String(line.qty));
  const n = Math.floor(Number(v) || 0);
  const submit = () => onOk(n);
  return (
    <Modal title={`Qty · ${line.code}`} onClose={onClose} width={360} footer={<div className="row"><span className="muted grow">Stock available {line.stock_qty}{n > line.stock_qty ? " (over)" : ""}</span><button type="button" className="btn primary" onClick={submit}>OK</button></div>}>
      <div className="big-input">{v || "0"}</div>
      <NumKeys value={v} onChange={setV} onEnter={submit} decimals={false} />
      <p className="muted small">Qty 0 removes the line.</p>
    </Modal>
  );
}

/* ── P4 price override (supervisor already verified by the caller) ──────── */
export function PricePopup({ line, supervisor, onOk, onClose }: { line: CartLine; supervisor: BundleCashier; onOk: (priceSen: number, reason: string) => void; onClose: () => void }) {
  const [v, setV] = useState(rm(line.unit_price_sen));
  const [reason, setReason] = useState("");
  const sen = Math.round((Number(v) || 0) * 100);
  const submit = () => { if (reason.trim()) onOk(sen, reason.trim()); };
  return (
    <Modal title={`Price override · ${line.code}`} onClose={onClose} width={400} footer={<div className="row"><span className="muted grow">By {supervisor.name}</span><button type="button" className="btn primary" disabled={!reason.trim()} onClick={submit}>Apply</button></div>}>
      <div className="row small"><span className="muted">Original</span><b>RM {rm(line.original_price_sen ?? line.unit_price_sen)}</b></div>
      <div className="big-input">RM {v || "0"}</div>
      <NumKeys value={v} onChange={setV} onEnter={submit} allowKeyboard={false} />
      <label className="field" style={{ marginTop: 10 }}><span>Reason (required)</span><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. display unit, scratched" /></label>
    </Modal>
  );
}

/* ── P5 discount (item or whole bill) ───────────────────────────────────── */
export function DiscountPopup({ target, grossSen, cashier, item, cashiers, onOk, onClose, onNeedSupervisor }: {
  target: "item" | "bill";
  grossSen: number;
  cashier: BundleCashier;
  item: CartLine | null;
  cashiers: readonly BundleCashier[];
  onOk: (d: Discount | null) => void;
  onClose: () => void;
  /** Ask for a supervisor; the caller re-opens with `approved`. */
  onNeedSupervisor: (d: Discount) => void;
}) {
  const [type, setType] = useState<"PCT" | "RM">(item?.discount?.type ?? "PCT");
  const [v, setV] = useState(item?.discount ? String(item.discount.value) : "");
  const value = Number(v) || 0;
  const disc: Discount = { source: "MANUAL", type, value };
  const amount = type === "PCT" ? Math.round((grossSen * value) / 100) : Math.min(grossSen, Math.round(value * 100) * (target === "item" && item ? item.qty : 1));
  const needsSup = value > 0 && manualDiscountNeedsSupervisor({ type, value }, grossSen, cashier.max_discount_pct, target === "item" ? item?.max_manual_disc_pct ?? null : null);
  const apply = () => {
    if (value <= 0) { onOk(null); return; }
    if (type === "PCT" && value > 100) return;
    if (needsSup) onNeedSupervisor(disc); else onOk(disc);
  };
  const quick = (t: "PCT" | "RM", n: number) => { setType(t); setV(String(n)); };
  return (
    <Modal title={target === "item" ? `Discount · ${item?.code ?? ""}` : "Bill discount"} onClose={onClose} width={420}
      footer={<div className="row"><button type="button" className="btn" onClick={() => onOk(null)}>Remove discount</button><span className="grow" /><button type="button" className="btn primary" onClick={apply}>{needsSup ? "Apply (supervisor PIN)" : "Apply"}</button></div>}>
      <div className="row">
        <button type="button" className={`btn${type === "PCT" ? " primary" : ""}`} onClick={() => setType("PCT")}>%</button>
        <button type="button" className={`btn${type === "RM" ? " primary" : ""}`} onClick={() => setType("RM")}>RM</button>
        <span className="grow" />
        {[5, 10, 20].map((n) => <button key={n} type="button" className="btn" onClick={() => quick("RM", n)}>RM{n}</button>)}
        {[5, 10].map((n) => <button key={n} type="button" className="btn" onClick={() => quick("PCT", n)}>{n}%</button>)}
      </div>
      <div className="big-input">{type === "PCT" ? `${v || "0"} %` : `RM ${v || "0"}`}</div>
      <NumKeys value={v} onChange={setV} onEnter={apply} />
      <div className="row small" style={{ marginTop: 8 }}>
        <span className="muted grow">{target === "item" ? "Line" : "Bill"} gross RM {rm(grossSen)} · discount RM {rm(amount)} · after RM {rm(Math.max(0, grossSen - amount))}</span>
        {needsSup && <span className="pill warnp">above {cashier.name}'s cap {cashier.max_discount_pct}%</span>}
      </div>
    </Modal>
  );
}

/* ── P6 salesman ───────────────────────────────────────────────────────── */
export function SalesmanPopup({ cashiers, current, onPick, onClose }: { cashiers: readonly BundleCashier[]; current: Cart["salesman"]; onPick: (s: Cart["salesman"]) => void; onClose: () => void }) {
  return (
    <Modal title="Credit this bill to" onClose={onClose} width={420}>
      <div className="tiles">
        <button type="button" className={`tile${current == null ? " selected" : ""}`} onClick={() => onPick(null)}>Booth<small>no one</small></button>
        {cashiers.filter((c) => c.role === "PARTTIME").map((c) => (
          <button key={c.id} type="button" className={`tile${current?.id === c.id ? " selected" : ""}`} onClick={() => onPick({ id: c.id, name: c.name })}>{c.name}<small>{c.code}</small></button>
        ))}
      </div>
      <p className="muted small">The choice stays for the following bills until changed; editable until payment. Printed on the receipt; review only.</p>
    </Modal>
  );
}

/* ── P11 recall ────────────────────────────────────────────────────────── */
export function RecallPopup({ holds, sstRate, onRecall, onDiscard, onClose }: { holds: HeldBill[]; sstRate: number; onRecall: (h: HeldBill) => void; onDiscard: (h: HeldBill) => void; onClose: () => void }) {
  return (
    <Modal title="Held bills (this terminal)" onClose={onClose} width={640}>
      {holds.length === 0 && <p className="muted">No held bill.</p>}
      {holds.map((h) => {
        const t = cartTotals(h.cart, sstRate, false);
        return (
          <div key={h.hold_no} className="hold-row">
            <div className="grow">
              <b className="mono">{h.hold_no}</b> <span className="muted">{fmtMyt(h.created_at)} · {h.cashier}{h.cart.customer?.name ? ` · ${h.cart.customer.name}` : ""}{h.cart.salesman ? ` · ${h.cart.salesman.name}` : ""}</span>
              <div className="small">{h.cart.lines.map((l) => `${l.qty} x ${l.receipt_name}${l.is_foc ? " (FOC)" : l.discount ? ` (${discLabel(l)})` : ""}`).join(", ")}</div>
            </div>
            <span className="money">RM {rm(t.total_sen)}</span>
            <button type="button" className="btn primary" onClick={() => onRecall(h)}>Recall</button>
            <button type="button" className="btn" onClick={() => window.print()} title="Print quote">Print quote</button>
            <button type="button" className="btn danger" onClick={() => onDiscard(h)}>Discard</button>
          </div>
        );
      })}
    </Modal>
  );
}

export function HoldPopup({ cart, onOk, onClose }: { cart: Cart; onOk: (customer: Cart["customer"]) => void; onClose: () => void }) {
  const [name, setName] = useState(cart.customer?.name ?? "");
  const [phone, setPhone] = useState(cart.customer?.phone ?? "");
  const submit = () => onOk(name.trim() || phone.trim() ? { name: name.trim(), phone: phone.trim() } : null);
  return (
    <Modal title="Hold this bill" onClose={onClose} width={400} footer={<div className="row"><span className="grow" /><button type="button" className="btn primary" onClick={submit}>Hold</button></div>}>
      <label className="field"><span>Customer name (optional)</span><input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") submit(); }} /></label>
      <label className="field"><span>Phone (optional)</span><input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" onKeyDown={(e) => { if (e.key === "Enter") submit(); }} /></label>
      <p className="muted small">A held bill has no receipt number and moves no stock. It expires at the event's end.</p>
    </Modal>
  );
}
