/* The sell screen (layout P2) and its popups (P3 to P7, P10 to P12, P16).
 * AutoCount layout: scan bar always focused, the cart grid, side buttons
 * with their F-keys, the payment block, totals, the footer bar and the
 * status bar. Everything here is offline: the catalog, the PIN checks, the
 * held bills, the sales queue, the local stock. Pay (F4) saves the sale on
 * the device first, prints, then shows the completion screen. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { beep } from "../beep";
import {
  addItem, cartTotals, discLabel, emptyCart, findByBarcode, formatReceiptNo, lineAmountSen, overridePrice, removeLine,
  setBillDiscount, setLineDiscount, setQty, toggleFoc, type Cart, type CartLine, type Discount, type HeldBill,
} from "../cart";
import { SyncPanel, syncIndicator, useSyncStatus } from "../sell/SyncPanel";
import { afterSale, heartbeat, syncNow } from "../sync";
import { discardHold, holdCart, listHolds } from "../holdsStore";
import { fmtMyt } from "../loginRules";
import { onPrinterStatus, type PrinterStatus } from "../printer";
import { printSale } from "../printing";
import { buildReturn, buildSale, mytDate, newUuid, type PaymentDraft, type ReturnPick, type SaleRecord } from "../sale";
import { applyStock, currentCounter, listSales, nextCounter, pendingSummary, saveSale, stockAdjustments } from "../salesStore";
import type { BundleCashier, BundleItem, DeviceState, Session } from "../types";
import { CompleteScreen } from "../sell/Complete";
import { FindBill } from "../sell/FindBill";
import { PaymentPopup } from "../sell/Payment";
import { DiscountPopup, HoldPopup, ItemSearch, PricePopup, QtyPopup, RecallPopup, SalesmanPopup } from "../sell/Popups";
import { ReturnExchange } from "../sell/ReturnExchange";
import { ReportPopup } from "../sell/Report";
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
  | { kind: "pay" }
  | { kind: "find"; q: string }
  | { kind: "return"; original: SaleRecord | null }
  | { kind: "sync" }
  | { kind: "report" }
  | null;

type Toast = { text: string; bad?: boolean; id: number };

export function Sell({ state, session, online, onLogout, onOpenSetup, onStateChanged }: { state: DeviceState; session: Session; online: boolean | null; onLogout: () => void; onOpenSetup: () => void; onStateChanged: (s: DeviceState) => void }) {
  const ss = useSyncStatus();
  const b = state.bundle;
  const s = b.settings;
  const cashEnabled = s.general.payment_methods.CASH;
  const [cart, setCart] = useState<Cart>(() => emptyCart(b.event.sst_default));
  const [sel, setSel] = useState<number | null>(null);
  const [popup, setPopup] = useState<Popup>(null);
  const [done, setDone] = useState<SaleRecord | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [scan, setScan] = useState("");
  const [scannerReady, setScannerReady] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const [today, setToday] = useState<{ bills: number; total_sen: number }>({ bills: 0, total_sen: 0 });
  const [pending, setPending] = useState<{ count: number; amount_sen: number }>({ count: 0, amount_sen: 0 });
  const [counter, setCounter] = useState<number>(b.terminal.receipt_counter);
  const [stockAdj, setStockAdj] = useState<Record<string, number>>({});
  const [printer, setPrinter] = useState<PrinterStatus>({ connected: false, name: null, transport: null, error: null });
  const scanRef = useRef<HTMLInputElement>(null);
  const searchTimer = useRef<number | null>(null);
  const lastSalesman = useRef<Cart["salesman"]>(null);
  const lastSale = useRef<SaleRecord | null>(null);
  const ssRef = useRef(ss);
  ssRef.current = ss;

  const items = useMemo<BundleItem[]>(() => b.items.map((i) => ({ ...i, stock_qty: i.stock_qty + (stockAdj[String(i.id)] ?? 0) })), [b.items, stockAdj]);
  const totals = useMemo(() => cartTotals(cart, s.sst_receipt.sst_rate, false), [cart, s.sst_receipt.sst_rate]);
  const selected = cart.lines.find((l) => l.line_no === sel) ?? null;
  const nextNo = formatReceiptNo(s.general.receipt_no_format, b.terminal.code, counter + 1, state.test_mode);

  const say = useCallback((text: string, bad = false) => setToast({ text, bad, id: Date.now() }), []);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 2500); return () => clearTimeout(t); }, [toast]);
  useEffect(() => { const t = setInterval(() => setClock(Date.now()), 30_000); return () => clearInterval(t); }, []);
  useEffect(() => onPrinterStatus(setPrinter), []);

  const refreshStats = useCallback(() => {
    const day = mytDate(new Date().toISOString());
    listSales().then((rows) => {
      let bills = 0; let total = 0;
      for (const r of rows) { if (r.is_test || r.status === "VOID" || mytDate(r.sold_at) !== day) continue; bills += r.type === "SALE" ? 1 : 0; total += r.total_sen; }
      setToday({ bills, total_sen: total });
    }).catch(() => {});
    pendingSummary().then((p) => setPending({ count: p.count, amount_sen: p.amount_sen })).catch(() => {});
    currentCounter(b.terminal.receipt_counter).then(setCounter).catch(() => {});
    stockAdjustments().then(setStockAdj).catch(() => {});
  }, [b.terminal.receipt_counter]);
  useEffect(() => { refreshStats(); }, [refreshStats]);

  /* Idle auto-logout (General). */
  useEffect(() => {
    const ms = s.general.idle_logout_minutes * 60_000;
    let timer = setTimeout(onLogout, ms);
    const bump = () => { clearTimeout(timer); timer = setTimeout(onLogout, ms); };
    for (const ev of ["pointerdown", "keydown", "touchstart"]) window.addEventListener(ev, bump);
    return () => { clearTimeout(timer); for (const ev of ["pointerdown", "keydown", "touchstart"]) window.removeEventListener(ev, bump); };
  }, [s.general.idle_logout_minutes, onLogout]);

  /* The scan bar stays focused whenever no popup is open. */
  const focusScan = useCallback(() => { if (!popup && !done) scanRef.current?.focus(); }, [popup, done]);
  useEffect(() => { focusScan(); }, [focusScan]);
  useEffect(() => {
    const h = (e: MouseEvent) => { const t = e.target as HTMLElement; if (!popup && !done && t.tagName !== "INPUT" && t.tagName !== "TEXTAREA" && t.tagName !== "SELECT") setTimeout(focusScan, 0); };
    window.addEventListener("click", h);
    return () => window.removeEventListener("click", h);
  }, [focusScan, popup, done]);

  const add = useCallback((item: BundleItem) => {
    setCart((c) => { const r = addItem(c, item, s.printer_scanner.same_barcode_adds_qty); setSel(r.line_no); return r.cart; });
  }, [s.printer_scanner.same_barcode_adds_qty]);

  function handleScan(code: string) {
    const c = code.trim();
    setScan("");
    if (!c) return;
    const item = findByBarcode(items, c);
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
  const newCart = useCallback(() => { setCart(emptyCart(b.event.sst_default, lastSalesman.current)); setSel(null); }, [b.event.sst_default]);

  /** Pay: the sale is saved on the device BEFORE anything else (P10). */
  async function completeSale(pays: PaymentDraft[]) {
    try {
      const n = await nextCounter(state.test_mode, b.terminal.receipt_counter);
      const sale = buildSale(cart, s.sst_receipt.sst_rate, s.sst_receipt.rounding_on_cash, pays, {
        uuid: newUuid(), terminal_code: b.terminal.code, project_id: b.event.project_id, cashier: { id: session.cashier.id, name: session.cashier.name },
        receipt_format: s.general.receipt_no_format, counter: n, is_test: state.test_mode, now: new Date().toISOString(),
      });
      await saveSale(sale);
      await applyStock(sale);
      lastSale.current = sale;
      setPopup(null);
      setDone(sale);
      refreshStats();
      void afterSale();
    } catch (e) {
      say(e instanceof Error ? e.message : "Could not save the sale", true);
    }
  }

  async function completeReturn(original: SaleRecord, picks: ReturnPick[], newItems: Cart | null, pays: PaymentDraft[], supervisor: BundleCashier) {
    try {
      const n = await nextCounter(state.test_mode, b.terminal.receipt_counter);
      const ret = buildReturn(original, picks, newItems, s.sst_receipt.sst_rate, pays, {
        uuid: newUuid(), terminal_code: b.terminal.code, project_id: b.event.project_id, cashier: { id: session.cashier.id, name: session.cashier.name },
        receipt_format: s.general.receipt_no_format, counter: n, is_test: state.test_mode, now: new Date().toISOString(),
      });
      ret.void_by = null;
      ret.lines = ret.lines.map((l) => (l.qty < 0 ? { ...l, override_by: supervisor.name } : l));
      await saveSale(ret);
      await applyStock(ret);
      lastSale.current = ret;
      setPopup(null);
      setDone(ret);
      refreshStats();
      void afterSale();
      say(`${ret.receipt_no} saved; stock adjusted on this device`);
    } catch (e) {
      say(e instanceof Error ? e.message : "Could not save the return", true);
    }
  }

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
    pay: () => { if (cart.lines.length === 0) { say("Cart is empty", true); return; } if (totals.total_sen <= 0 && !cart.lines.some((l) => !l.is_foc)) { say("Only FOC lines: use a zero payment", true); } setPopup({ kind: "pay" }); },
    billDiscount: () => { if (cart.lines.length === 0) { say("Cart is empty", true); return; } setPopup({ kind: "discount", target: "bill" }); },
    hold: () => { if (cart.lines.length === 0) { say("Nothing to hold", true); return; } setPopup({ kind: "hold" }); },
    recall: () => { listHolds(b.event.end_date).then((holds) => setPopup({ kind: "recall", holds })).catch(() => say("Could not read held bills", true)); },
    clear: () => { if (cart.lines.length === 0) return; if (window.confirm("Clear the whole cart?")) newCart(); },
    findBill: () => setPopup({ kind: "find", q: "" }),
    reprint: () => {
      const last = lastSale.current;
      if (!last) { setPopup({ kind: "find", q: "" }); return; }
      printSale(last, state, "COPY").then((r) => say(r.ok ? `${last.receipt_no} COPY printed` : r.reason, !r.ok));
    },
    returns: () => setPopup({ kind: "return", original: null }),
    todaysSales: () => setPopup({ kind: "report" }),
    syncNow: () => { syncNow("manual").then(heartbeat).then(() => say(ssRef.current.last_error ?? (ssRef.current.pending ? `${ssRef.current.pending} still pending` : "Synced"), !!ssRef.current.last_error)); },
    syncPanel: () => setPopup({ kind: "sync" }),
    salesman: () => setPopup({ kind: "salesman" }),
    customer: () => setPopup({ kind: "customer" }),
  };

  /* Keyboard map (spec section 15), quiet while a popup is open. */
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (popup || done) return;
      const k = e.key;
      const ctrl = e.ctrlKey || e.metaKey;
      const fire = (fn: () => void) => { e.preventDefault(); fn(); };
      if (k === "F1") fire(actions.search);
      else if (k === "F2") fire(actions.qty);
      else if (k === "F3") fire(actions.price);
      else if (k === "F4") fire(actions.pay);
      else if (k === "F8") fire(actions.billDiscount);
      else if (k === "F9") fire(actions.returns);
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

  if (done) {
    return (
      <div className="app">
        <header className="topbar"><div className="brand">{b.company.name}</div><span className="pill">{b.event.receipt_header || b.event.name}</span><div className="grow" /><div className="meta">Terminal {b.terminal.code}</div></header>
        {state.test_mode && <div className="banner test">TEST MODE</div>}
        <CompleteScreen sale={done} state={state} online={online} onNewSale={() => { setDone(null); newCart(); setTimeout(() => scanRef.current?.focus(), 0); }} />
      </div>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">{b.company.name}</div>
        <span className="pill">{b.event.receipt_header || b.event.name}</span>
        <span className="pill">{syncIndicator(ss)}</span>
        <div className="grow" />
        <button type="button" className="btn link" style={{ color: "#fff" }} onClick={actions.syncPanel} title="Sync panel">Last sync {ss.last_sync_at ?? state.last_sync_at ? fmtMyt(ss.last_sync_at ?? state.last_sync_at) : "--"}</button>
        <button type="button" className="btn" style={{ minHeight: 34, padding: "4px 10px" }} onClick={actions.syncNow}>Sync now</button>
      </header>
      {state.provisional && <div className="banner update"><span className="grow">This device is not set up yet: no terminal, no fair, no items. Pick the terminal and the fair in Settings.</span><button type="button" className="btn primary" onClick={onOpenSetup}>Open Settings</button></div>}
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
        <button type="button" className="btn" onClick={actions.returns}>Return<small>F9</small></button>
        <button type="button" className="btn" onClick={actions.todaysSales}>Today's Sales<small>Ctrl+T</small></button>
        <button type="button" className="btn" onClick={actions.syncNow}>Sync Now<small>Ctrl+S</small></button>
        <span className="grow" />
        {session.cashier.role === "SUPERVISOR" && <button type="button" className="btn" onClick={onOpenSetup}>Settings<small>device</small></button>}
        <button type="button" className="btn" onClick={onLogout}>Logout<small>F12</small></button>
      </div>
      <div className="status">
        <span>Cashier {session.cashier.name}{session.cashier.role === "SUPERVISOR" ? " (supervisor)" : ""}</span><span>Terminal {b.terminal.code}</span><span>{b.event.name}</span>
        <span className={printer.connected ? "ok-text" : ""}>Printer: {printer.connected ? `${printer.name} ready` : "not paired"}</span>
        <span className="grow" />
        <button type="button" className="btn link" style={{ padding: 0, minHeight: 0, fontSize: 12 }} onClick={actions.syncPanel}>{ss.pending} pending{ss.pending ? ` · RM ${rm(ss.pending_sen)}` : ""} · last sync {ss.last_sync_at ?? state.last_sync_at ? fmtMyt(ss.last_sync_at ?? state.last_sync_at) : "--"}</button><span>{fmtMyt(new Date(clock).toISOString())}</span>
      </div>

      {toast && <div className={`toast${toast.bad ? " bad" : ""}`}>{toast.text}</div>}

      {popup?.kind === "search" && <ItemSearch items={items} initial={popup.q} onPick={(i) => { add(i); if (s.printer_scanner.beep) beep("ok"); close(); }} onClose={close} />}
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
          onNeedSupervisor={(d) => setPopup({ kind: "sup", why: `A ${d.type === "PCT" ? `${d.value}%` : `RM${d.value}`} discount is above ${session.cashier.name}'s cap.`, then: (sup) => applyDiscount(popup.target, { ...d, approved_by: sup.name }) })}
        />
      )}
      {popup?.kind === "sup" && <SupervisorPin why={popup.why} cashiers={b.cashiers} onOk={(sup) => { const then = popup.then; setPopup(null); then(sup); }} onClose={close} />}
      {popup?.kind === "salesman" && <SalesmanPopup cashiers={b.cashiers} current={cart.salesman} onPick={(sm) => { lastSalesman.current = sm; setCart((c) => ({ ...c, salesman: sm })); close(); }} onClose={close} />}
      {popup?.kind === "customer" && <HoldPopup cart={cart} onOk={(cu) => { setCart((c) => ({ ...c, customer: cu })); close(); }} onClose={close} />}
      {popup?.kind === "hold" && (
        <HoldPopup cart={cart} onOk={(cu) => {
          holdCart({ ...cart, customer: cu }, session.cashier.name).then((h) => { say(`Held as ${h.hold_no}`); newCart(); }).catch(() => say("Could not hold the bill", true));
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
      {popup?.kind === "pay" && (
        <PaymentPopup cart={cart} sstRate={s.sst_receipt.sst_rate} roundingOnCash={s.sst_receipt.rounding_on_cash} general={s.general} onComplete={(pays) => void completeSale(pays)} onClose={close} />
      )}
      {popup?.kind === "find" && <FindBill state={state} initialQuery={popup.q} onReturn={(orig) => setPopup({ kind: "return", original: orig })} onClose={() => { close(); refreshStats(); void afterSale(); }} say={say} />}
      {popup?.kind === "sync" && <SyncPanel state={state} onStateChanged={onStateChanged} onClose={close} say={say} />}
      {popup?.kind === "report" && <ReportPopup state={state} session={session} onClose={close} say={say} />}
      {popup?.kind === "return" && <ReturnExchange state={state} initial={popup.original} onSave={completeReturn} onClose={close} say={say} />}
    </div>
  );
}
