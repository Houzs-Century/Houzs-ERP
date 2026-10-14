/* The sell screen (layout P2) and its popups (P3 to P6, P11). AutoCount
 * layout: scan bar always focused, the cart grid, side buttons with their
 * F-keys, the payment block, totals, the footer bar and the status bar.
 * Everything here is offline: the catalog, the PIN checks, the held bills.
 * Pay (F4) opens the payment screen of step 5. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { beep } from "../beep";
import {
  addItem, cartTotals, discLabel, emptyCart, findByBarcode, formatReceiptNo, lineAmountSen, overridePrice, removeLine,
  setBillDiscount, setLineDiscount, setQty, toggleFoc, type Cart, type CartLine, type Discount, type HeldBill,
} from "../cart";
import { idb } from "../db";
import { sendHeartbeat } from "../deviceStore";
import { discardHold, holdCart, listHolds } from "../holdsStore";
import { fmtMyt } from "../loginRules";
import type { BundleCashier, DeviceState, Session } from "../types";
import { DiscountPopup, HoldPopup, ItemSearch, PricePopup, QtyPopup, RecallPopup, SalesmanPopup } from "../sell/Popups";
import { SupervisorPin } from "../sell/SupervisorPin";

const rm = (sen: number) => (sen / 100).toFixed(2);

type Popup =
  | { kind: "search"; q: string }
  | { kind: "qty" }
  | { kind: "price"; supervisor: BundleCashier }
  | { kind: "discount"; target: "item" | "bill" }
  | { kind: "salesman" }
  | { kind: "hold" }
  | { kind: "customer" }
  | { kind: "recall"; holds: HeldBill[] }
  | { kind: "sup"; why: string; then: (s: BundleCashier) => void }
  | null;

type Toast = { text: string; bad?: boolean; id: number };

export function Sell({ state, session, online, onLogout }: { state: DeviceState; session: Session; online: boolean | null; onLogout: () => void }) {
  const b = state.bundle;
  const s = b.settings;
  const cashEnabled = s.general.payment_methods.CASH;
  const [cart, setCart] = useState<Cart>(() => emptyCart(b.event.sst_default));
  const [sel, setSel] = useState<number | null>(null);
  const [popup, setPopup] = useState<Popup>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [scan, setScan] = useState("");
  const [scannerReady, setScannerReady] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const [today, setToday] = useState<{ bills: number; total_sen: number }>({ bills: 0, total_sen: 0 });
  const scanRef = useRef<HTMLInputElement>(null);
  const searchTimer = useRef<number | null>(null);
  const lastSalesman = useRef<Cart["salesman"]>(null);

  const totals = useMemo(() => cartTotals(cart, s.sst_receipt.sst_rate, false), [cart, s.sst_receipt.sst_rate]);
  const selected = cart.lines.find((l) => l.line_no === sel) ?? null;
  const nextNo = formatReceiptNo(s.general.receipt_no_format, b.terminal.code, b.terminal.receipt_counter + 1, state.test_mode);

  const say = useCallback((text: string, bad = false) => setToast({ text, bad, id: Date.now() }), []);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 2500); return () => clearTimeout(t); }, [toast]);
  useEffect(() => { const t = setInterval(() => setClock(Date.now()), 30_000); return () => clearInterval(t); }, []);
  useEffect(() => {
    idb.all<{ sold_at?: string; total_sen?: number; status?: string; is_test?: boolean }>("sales").then((rows) => {
      const day = fmtMyt(new Date().toISOString()).slice(0, 10);
      let bills = 0; let total = 0;
      for (const r of rows) {
        if (!r.sold_at || r.is_test || r.status === "VOID") continue;
        if (fmtMyt(r.sold_at).slice(0, 10) !== day) continue;
        bills += 1; total += r.total_sen ?? 0;
      }
      setToday({ bills, total_sen: total });
    }).catch(() => {});
  }, []);

  /* Idle auto-logout (General). */
  useEffect(() => {
    const ms = s.general.idle_logout_minutes * 60_000;
    let timer = setTimeout(onLogout, ms);
    const bump = () => { clearTimeout(timer); timer = setTimeout(onLogout, ms); };
    for (const ev of ["pointerdown", "keydown", "touchstart"]) window.addEventListener(ev, bump);
    return () => { clearTimeout(timer); for (const ev of ["pointerdown", "keydown", "touchstart"]) window.removeEventListener(ev, bump); };
  }, [s.general.idle_logout_minutes, onLogout]);

  /* The scan bar stays focused whenever no popup is open. */
  const focusScan = useCallback(() => { if (!popup) scanRef.current?.focus(); }, [popup]);
  useEffect(() => { focusScan(); }, [focusScan]);
  useEffect(() => {
    const h = (e: MouseEvent) => { const t = e.target as HTMLElement; if (!popup && t.tagName !== "INPUT" && t.tagName !== "TEXTAREA") setTimeout(focusScan, 0); };
    window.addEventListener("click", h);
    return () => window.removeEventListener("click", h);
  }, [focusScan, popup]);

  const add = useCallback((item: NonNullable<ReturnType<typeof findByBarcode>>) => {
    setCart((c) => { const r = addItem(c, item, s.printer_scanner.same_barcode_adds_qty); setSel(r.line_no); return r.cart; });
  }, [s.printer_scanner.same_barcode_adds_qty]);

  function handleScan(code: string) {
    const c = code.trim();
    setScan("");
    if (!c) return;
    const item = findByBarcode(b.items, c);
    if (item) {
      add(item);
      setScannerReady(true);
      if (s.printer_scanner.beep) beep("ok");
    } else {
      if (s.printer_scanner.beep) beep("error");
      say(`Barcode ${c} not found`, true);
      setPopup({ kind: "search", q: c });
    }
  }

  function onScanChange(v: string) {
    setScan(v);
    if (searchTimer.current) window.clearTimeout(searchTimer.current);
    if (v.trim().length >= 2) {
      searchTimer.current = window.setTimeout(() => { if (scanRef.current?.value.trim().length) { setPopup({ kind: "search", q: scanRef.current.value }); setScan(""); } }, 450);
    }
  }

  const needLine = (): CartLine | null => { if (!selected) { say("Select a line first", true); return null; } return selected; };

  const actions = {
    search: () => setPopup({ kind: "search", q: "" }),
    qty: () => { if (needLine()) setPopup({ kind: "qty" }); },
    price: () => {
      if (!needLine()) return;
      if (s.general.price_override === "OFF") { say("Price override is off (General settings)", true); return; }
      setPopup({ kind: "sup", why: "Price override needs a supervisor.", then: (sup) => setPopup({ kind: "price", supervisor: sup }) });
    },
    discount: () => { if (needLine()) setPopup({ kind: "discount", target: "item" }); },
    foc: () => { const l = needLine(); if (!l) return; if (!l.foc_allowed) { say("FOC is not allowed for this item", true); return; } setCart((c) => toggleFoc(c, l.line_no)); },
    del: () => { const l = needLine(); if (!l) return; setCart((c) => removeLine(c, l.line_no)); setSel(null); },
    pay: () => { if (cart.lines.length === 0) { say("Cart is empty", true); return; } say("Payment (F4) arrives with build step 5."); },
    billDiscount: () => { if (cart.lines.length === 0) { say("Cart is empty", true); return; } setPopup({ kind: "discount", target: "bill" }); },
    hold: () => { if (cart.lines.length === 0) { say("Nothing to hold", true); return; } setPopup({ kind: "hold" }); },
    recall: () => { listHolds(b.event.end_date).then((holds) => setPopup({ kind: "recall", holds })).catch(() => say("Could not read held bills", true)); },
    clear: () => { if (cart.lines.length === 0) return; if (window.confirm("Clear the whole cart?")) { setCart(emptyCart(b.event.sst_default, lastSalesman.current)); setSel(null); } },
    findBill: () => say("Find bill (Ctrl+B) arrives with build step 5."),
    reprint: () => say("Reprint (Ctrl+F) arrives with build step 5."),
    todaysSales: () => say("Today's sales report (Ctrl+T) arrives with build step 8."),
    syncNow: () => { if (online === false) { say("Offline: nothing can sync now", true); return; } sendHeartbeat(state, session.cashier.name).then((r) => say(r ? "ERP reached. No sales pending." : "ERP not reachable", !r)); },
    salesman: () => setPopup({ kind: "salesman" }),
    customer: () => setPopup({ kind: "customer" }),
  };

  /* Keyboard map (spec section 15), quiet while a popup is open. */
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (popup) return;
      const k = e.key;
      const ctrl = e.ctrlKey || e.metaKey;
      const fire = (fn: () => void) => { e.preventDefault(); fn(); };
      if (k === "F1") fire(actions.search);
      else if (k === "F2") fire(actions.qty);
      else if (k === "F3") fire(actions.price);
      else if (k === "F4") fire(actions.pay);
      else if (k === "F8") fire(actions.billDiscount);
      else if (k === "F9") fire(() => say("Return / exchange (F9) arrives with build step 5."));
      else if (k === "F10") fire(actions.discount);
      else if (k === "F12") fire(onLogout);
      else if (k === "Delete" && document.activeElement === scanRef.current && scan === "") fire(actions.del);
      else if (ctrl && k.toLowerCase() === "a") fire(actions.clear);
      else if (ctrl && k.toLowerCase() === "b") fire(actions.findBill);
      else if (ctrl && k.toLowerCase() === "c") fire(actions.hold);
      else if (ctrl && k.toLowerCase() === "e") fire(actions.recall);
      else if (ctrl && k.toLowerCase() === "f") fire(actions.reprint);
      else if (ctrl && k.toLowerCase() === "t") fire(actions.todaysSales);
      else if (ctrl && k.toLowerCase() === "s") fire(actions.syncNow);
      else if (k === "ArrowDown" && cart.lines.length) fire(() => setSel((v) => { const i = cart.lines.findIndex((l) => l.line_no === v); return cart.lines[Math.min(cart.lines.length - 1, i + 1)]!.line_no; }));
      else if (k === "ArrowUp" && cart.lines.length) fire(() => setSel((v) => { const i = cart.lines.findIndex((l) => l.line_no === v); return cart.lines[Math.max(0, i <= 0 ? 0 : i - 1)]!.line_no; }));
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  const close = () => { setPopup(null); setTimeout(() => scanRef.current?.focus(), 0); };
  const selGross = selected ? selected.qty * selected.unit_price_sen : 0;
  const billGross = totals.subtotal_sen - totals.item_discount_sen;
  const applyDiscount = (target: "item" | "bill", d: Discount | null) => {
    if (target === "item" && selected) setCart((c) => setLineDiscount(c, selected.line_no, d));
    else setCart((c) => setBillDiscount(c, d ? { type: d.type, value: d.value } : null));
    close();
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">{b.company.name}</div>
        <span className="pill">{b.event.receipt_header || b.event.name}</span>
        <span className="pill">{online === false ? "Offline · 0 pending" : online ? "Online · synced" : "Checking…"}</span>
        <div className="grow" />
        <div className="meta">Last sync {state.last_sync_at ? fmtMyt(state.last_sync_at) : "--"}</div>
        <button type="button" className="btn" style={{ minHeight: 34, padding: "4px 10px" }} onClick={actions.syncNow}>Sync now</button>
      </header>
      {state.test_mode && <div className="banner test">TEST MODE: every sale is a TEST sale (numbered {nextNo}), never synced, no stock deduction.</div>}

      <div className="sell">
        <div className="head">
          <div>
            <div className="lbl">Salesman</div>
            <button type="button" className="btn link" style={{ padding: 0, fontWeight: 700 }} onClick={actions.salesman}>{cart.salesman?.name ?? "Booth"} &#9662;</button>
          </div>
          {s.general.customer_field === "OPTIONAL" ? (
            <div>
              <div className="lbl">Customer</div>
              <button type="button" className="btn link" style={{ padding: 0, fontWeight: 700 }} onClick={actions.customer}>{cart.customer?.name || cart.customer?.phone || "optional"} &#9662;</button>
            </div>
          ) : <div />}
          <div>
            <div className="lbl">Cash Sale</div>
            <div className="val mono">{nextNo}</div>
            <div className="muted small">Today: {today.bills} bills · RM {rm(today.total_sen)}</div>
          </div>
          <div className="total">
            <div className="lbl">Total</div>
            <div className="big">RM {rm(totals.total_sen)}</div>
            <div className="change">Change RM 0.00</div>
          </div>
        </div>

        <div className="main">
          <div className="scan">
            <input
              ref={scanRef}
              value={scan}
              onChange={(e) => onScanChange(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (searchTimer.current) window.clearTimeout(searchTimer.current); handleScan(scan); } }}
              placeholder="Scan barcode or type to search (F1)"
              autoFocus
              autoComplete="off"
            />
            <span className={scannerReady ? "ok" : "muted small"}>{scannerReady ? "Scanner: ready" : "Scanner: waiting for first scan"}</span>
          </div>
          <div className="grid-wrap">
            <table className="cart">
              <thead><tr><th>No</th><th>Item Code</th><th>Description</th><th>UOM</th><th className="num">Qty</th><th className="num">Unit Price</th><th>Disc</th><th className="num">Amount</th></tr></thead>
              <tbody>
                {cart.lines.map((l) => (
                  <tr key={l.line_no} className={sel === l.line_no ? "sel" : ""} onClick={() => setSel(l.line_no)} onDoubleClick={() => { setSel(l.line_no); setPopup({ kind: "qty" }); }}>
                    <td>{l.line_no}</td>
                    <td className="mono">{l.code}</td>
                    <td>{l.description}{l.original_price_sen != null && <div className="ovr">was RM {rm(l.original_price_sen)} · {l.override_reason} ({l.override_by})</div>}</td>
                    <td>{l.uom}</td>
                    <td className="num">{l.qty}</td>
                    <td className="num">{rm(l.unit_price_sen)}</td>
                    <td className={l.is_foc ? "foc" : l.discount ? "disc" : ""}>{l.discount?.source === "AUTO" && !l.is_foc ? "AUTO " : l.discount?.source === "MANUAL" && !l.is_foc ? "MANUAL " : ""}{discLabel(l)}</td>
                    <td className="num money">{rm(lineAmountSen(l))}</td>
                  </tr>
                ))}
                {cart.lines.length === 0 && <tr><td colSpan={8} className="muted" style={{ textAlign: "center", padding: 30 }}>Scan an item, or press F1 to search.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        <div className="side">
          <button type="button" className="btn" onClick={actions.search}>Item<small>F1</small></button>
          <button type="button" className="btn" onClick={actions.qty}>Qty<small>F2</small></button>
          <button type="button" className="btn" onClick={actions.price}>Price<small>F3</small></button>
          <button type="button" className="btn" onClick={actions.discount}>Discount<small>F10</small></button>
          <button type="button" className="btn" onClick={actions.foc}>FOC<small>free of charge</small></button>
          <button type="button" className="btn danger" onClick={actions.del}>Delete<small>Del</small></button>
          <div className="spacer" />
          <button type="button" className="btn primary" onClick={actions.pay}>Pay<small>F4</small></button>
          <button type="button" className="btn" onClick={actions.billDiscount}>Bill Discount<small>F8</small></button>
          <button type="button" className="btn" onClick={actions.hold}>Hold Bill<small>Ctrl+C</small></button>
        </div>

        <div className="totals">
          <div className="t"><span className="lbl">Sub Total</span><b>{rm(totals.subtotal_sen)}</b></div>
          <div className="t"><span className="lbl">Discount</span><b>{rm(totals.item_discount_sen + totals.bill_discount_sen)}</b></div>
          <label><input type="checkbox" checked={cart.sst_applied} onChange={(e) => setCart((c) => ({ ...c, sst_applied: e.target.checked }))} /> <span className="lbl">SST {s.sst_receipt.sst_rate}%</span><b>{rm(totals.sst_sen)}</b></label>
          {cashEnabled && <div className="t"><span className="lbl">Rounding</span><b>{rm(totals.rounding_sen)}</b></div>}
          <div className="t"><span className="lbl">Total</span><b style={{ fontSize: 18 }}>RM {rm(totals.total_sen)}</b></div>
          <span className="grow" />
          <span className="muted small">{totals.units} units · {cart.lines.length} lines</span>
        </div>
      </div>

      <div className="bar">
        <button type="button" className="btn" onClick={actions.clear}>Clear<small>Ctrl+A</small></button>
        <button type="button" className="btn" onClick={actions.findBill}>Find Bill<small>Ctrl+B</small></button>
        <button type="button" className="btn" onClick={actions.hold}>Hold<small>Ctrl+C</small></button>
        <button type="button" className="btn" onClick={actions.recall}>Recall<small>Ctrl+E</small></button>
        <button type="button" className="btn" onClick={actions.reprint}>Reprint<small>Ctrl+F</small></button>
        <button type="button" className="btn" onClick={actions.todaysSales}>Today's Sales<small>Ctrl+T</small></button>
        <button type="button" className="btn" onClick={actions.syncNow}>Sync Now<small>Ctrl+S</small></button>
        <span className="grow" />
        <button type="button" className="btn" onClick={onLogout}>Logout<small>F12</small></button>
      </div>
      <div className="status">
        <span>Cashier {session.cashier.name}{session.cashier.role === "SUPERVISOR" ? " (supervisor)" : ""}</span><span>Terminal {b.terminal.code}</span><span>{b.event.name}</span><span>Printer: not paired</span>
        <span className="grow" />
        <span>0 pending · last sync {state.last_sync_at ? fmtMyt(state.last_sync_at) : "--"}</span><span>{fmtMyt(new Date(clock).toISOString())}</span>
      </div>

      {toast && <div className={`toast${toast.bad ? " bad" : ""}`}>{toast.text}</div>}

      {popup?.kind === "search" && <ItemSearch items={b.items} initial={popup.q} onPick={(i) => { add(i); if (s.printer_scanner.beep) beep("ok"); close(); }} onClose={close} />}
      {popup?.kind === "qty" && selected && <QtyPopup line={selected} onOk={(q) => { setCart((c) => setQty(c, selected.line_no, q)); if (q === 0) setSel(null); close(); }} onClose={close} />}
      {popup?.kind === "price" && selected && <PricePopup line={selected} supervisor={popup.supervisor} onOk={(p, reason) => { setCart((c) => overridePrice(c, selected.line_no, p, popup.supervisor.name, reason)); close(); }} onClose={close} />}
      {popup?.kind === "discount" && (popup.target === "bill" || selected) && (
        <DiscountPopup
          target={popup.target}
          grossSen={popup.target === "item" ? selGross : billGross}
          cashier={session.cashier}
          item={popup.target === "item" ? selected : null}
          cashiers={b.cashiers}
          onOk={(d) => applyDiscount(popup.target, d)}
          onClose={close}
          onNeedSupervisor={(d) => setPopup({ kind: "sup", why: `A ${d.type === "PCT" ? `${d.value}%` : `RM${d.value}`} discount is above ${session.cashier.name}'s cap.`, then: () => applyDiscount(popup.target, d) })}
        />
      )}
      {popup?.kind === "sup" && <SupervisorPin why={popup.why} cashiers={b.cashiers} onOk={(sup) => { const then = popup.then; setPopup(null); then(sup); }} onClose={close} />}
      {popup?.kind === "salesman" && <SalesmanPopup cashiers={b.cashiers} current={cart.salesman} onPick={(sm) => { lastSalesman.current = sm; setCart((c) => ({ ...c, salesman: sm })); close(); }} onClose={close} />}
      {popup?.kind === "customer" && <HoldPopup cart={cart} onOk={(cu) => { setCart((c) => ({ ...c, customer: cu })); close(); }} onClose={close} />}
      {popup?.kind === "hold" && (
        <HoldPopup cart={cart} onOk={(cu) => {
          holdCart({ ...cart, customer: cu }, session.cashier.name).then((h) => { say(`Held as ${h.hold_no}`); setCart(emptyCart(b.event.sst_default, lastSalesman.current)); setSel(null); }).catch(() => say("Could not hold the bill", true));
          close();
        }} onClose={close} />
      )}
      {popup?.kind === "recall" && (
        <RecallPopup
          holds={popup.holds}
          sstRate={s.sst_receipt.sst_rate}
          onRecall={(h) => {
            if (cart.lines.length > 0 && !window.confirm("Replace the current cart with this held bill?")) return;
            discardHold(h.hold_no).then(() => { setCart(h.cart); setSel(h.cart.lines[0]?.line_no ?? null); say(`${h.hold_no} recalled`); close(); }).catch(() => say("Could not recall", true));
          }}
          onDiscard={(h) => { discardHold(h.hold_no).then(() => listHolds(b.event.end_date)).then((holds) => setPopup({ kind: "recall", holds })).catch(() => say("Could not discard", true)); }}
          onClose={close}
        />
      )}
    </div>
  );
}
