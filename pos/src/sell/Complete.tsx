/* Payment complete (layout P10): receipt no, time, salesman, CHANGE large,
 * the print status, "Saved on device · will sync when online", Reprint /
 * E-receipt / New sale; clears to a fresh cart after 5 s. The printer
 * dialog (P14) sits here too: Skip print / Reconnect / Retry. */
import { useEffect, useState } from "react";
import { fmtMyt } from "../loginRules";
import { connectPrinter, printerSupported, reconnectPrinter } from "../printer";
import { printSale, shareReceipt, type PrintResult } from "../printing";
import type { SaleRecord } from "../sale";
import type { DeviceState } from "../types";
import { Modal } from "./Modal";

const rm = (sen: number) => (sen / 100).toFixed(2);

export function PrinterDialog({ reason, noPrinter, onSkip, onRetry, onReconnected }: { reason: string; noPrinter: boolean; onSkip: () => void; onRetry: () => void; onReconnected: () => void }) {
  const [busy, setBusy] = useState(false);
  const sup = printerSupported();
  const reconnect = async (kind?: "BLUETOOTH" | "USB") => {
    setBusy(true);
    const st = kind ? await connectPrinter(kind) : await reconnectPrinter();
    setBusy(false);
    if (st.connected) onReconnected();
  };
  return (
    <Modal title="Printer not connected" onClose={onSkip} width={420}>
      <p style={{ marginTop: 0 }}>The sale is already saved. {reason}.</p>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <button type="button" className="btn" onClick={onSkip}>Skip print</button>
        {!noPrinter && <button type="button" className="btn primary" disabled={busy} onClick={onRetry}>Retry</button>}
        <button type="button" className="btn" disabled={busy} onClick={() => void reconnect()}>Reconnect</button>
        {sup.bluetooth && <button type="button" className="btn" disabled={busy} onClick={() => void reconnect("BLUETOOTH")}>Connect Bluetooth</button>}
        {sup.usb && <button type="button" className="btn" disabled={busy} onClick={() => void reconnect("USB")}>Connect USB</button>}
      </div>
    </Modal>
  );
}

export function CompleteScreen({ sale, state, online, onNewSale }: { sale: SaleRecord; state: DeviceState; online: boolean | null; onNewSale: () => void }) {
  const [print, setPrint] = useState<PrintResult | "printing" | null>("printing");
  const [dialog, setDialog] = useState(false);
  const [left, setLeft] = useState(5);
  const change = sale.payments.find((p) => p.method === "CASH")?.change_sen ?? 0;

  useEffect(() => {
    let alive = true;
    printSale(sale, state, "ORIGINAL").then((r) => { if (!alive) return; setPrint(r); if (!r.ok) setDialog(true); });
    return () => { alive = false; };
  }, [sale, state]);

  useEffect(() => {
    if (dialog || print === "printing") return;
    if (left <= 0) { onNewSale(); return; }
    const t = setTimeout(() => setLeft((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [left, dialog, print, onNewSale]);

  const retry = () => { setDialog(false); setPrint("printing"); printSale(sale, state, "ORIGINAL").then((r) => { setPrint(r); if (!r.ok) setDialog(true); }); };
  const failed = print !== "printing" && print !== null && !print.ok ? print : null;

  return (
    <div className="screen">
      <div className="card complete">
        <div className="row"><span className="lbl">Receipt</span><b className="mono big-no">{sale.receipt_no}</b><span className="grow" /><span className="muted">{fmtMyt(sale.sold_at)}</span></div>
        <div className="row small"><span>Salesman {sale.salesman_name ?? "Booth"}</span><span>·</span><span>Cashier {sale.cashier_name}</span><span>·</span><span>{sale.payments.map((p) => `${p.method} ${rm(Math.abs(p.amount_sen))}`).join(" + ")}</span></div>
        <div className="change-big"><span className="lbl">{sale.type === "RETURN" && sale.total_sen < 0 ? "Refund" : "Change"}</span><b>RM {rm(sale.type === "RETURN" && sale.total_sen < 0 ? -sale.total_sen : change)}</b></div>
        <div className={`row ${failed ? "err" : "muted"}`}>
          {print === "printing" ? "Printing receipt…" : failed ? `Not printed: ${failed.reason}` : "Receipt printed."}
        </div>
        <div className="muted small">{sale.is_test ? "TEST sale: saved on device, never synced." : "Saved on device · will sync when online"}</div>
        <div className="row" style={{ marginTop: 14 }}>
          <button type="button" className="btn" onClick={() => { setPrint("printing"); printSale(sale, state, "COPY").then((r) => { setPrint(r); if (!r.ok) setDialog(true); }); }}>Reprint</button>
          <button type="button" className="btn" disabled={online === false && false} title="Opens the receipt to share to WhatsApp / email or save as PDF" onClick={() => void shareReceipt(sale, state)}>E-receipt</button>
          <span className="grow" />
          <button type="button" className="btn primary focus-first" onClick={onNewSale} autoFocus>New sale ({left})</button>
        </div>
      </div>
      {dialog && failed && (
        <PrinterDialog reason={failed.reason} noPrinter={failed.noPrinter} onSkip={() => setDialog(false)} onRetry={retry} onReconnected={retry} />
      )}
    </div>
  );
}
