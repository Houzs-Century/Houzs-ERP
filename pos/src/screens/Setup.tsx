/* Device setup (layout P15), behind the gear on the login screen with a
 * supervisor PIN. Status lines (ERP, terminal, printer, scanner, storage),
 * the checklist, Refresh catalog, Test print, Test mode, Clear test sales,
 * and Pair again with a new code from POS Admin > Terminals. Pairing itself
 * is the ERP's job; there is no ERP sign-in on the device. Cashiers never
 * see this screen. */
import { useEffect, useState } from "react";
import { formatPairingCode, isPairingCode, normalizePairingCode } from "@shared/pos-pairing";
import { deviceApi, erpReachable } from "../api";
import { requestPersistentStorage, storageEstimate } from "../db";
import { refreshBundle, saveDeviceState, stateFromBundle, platformName } from "../deviceStore";
import { fmtMyt } from "../loginRules";
import { connectPrinter, onPrinterStatus, printerSupported, type PrinterStatus } from "../printer";
import { printTestPage } from "../printing";
import { clearTestSales } from "../salesStore";
import { APP_VERSION } from "../pwa";
import type { DeviceState, PosBundle } from "../types";

function Dot({ tone }: { tone: "ok" | "warn" | "bad" | "none" }) {
  return <span className={`dot ${tone === "none" ? "" : tone}`} />;
}

export function Setup({ state, onPrepared, onExit, onToggleTest }: {
  state: DeviceState;
  onPrepared: (s: DeviceState) => void;
  onExit: () => void;
  onToggleTest: (on: boolean) => void;
}) {
  const [online, setOnline] = useState<boolean | null>(null);
  const [storage, setStorage] = useState<{ persisted: boolean; usage: number; quota: number } | null>(null);
  const [code, setCode] = useState("");
  const [deviceName, setDeviceName] = useState(state.device_name);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [printer, setPrinter] = useState<PrinterStatus>({ connected: false, name: null, transport: null, error: null });
  const support = printerSupported();
  useEffect(() => onPrinterStatus(setPrinter), []);

  useEffect(() => {
    let alive = true;
    const check = async () => {
      const ok = await erpReachable();
      if (alive) setOnline(ok);
      const est = await storageEstimate();
      if (alive) setStorage(est);
    };
    void check();
    const t = setInterval(() => void check(), 15_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  async function pair() {
    if (!isPairingCode(code)) return;
    setBusy("pair");
    setMsg(null);
    try {
      const persisted = await requestPersistentStorage();
      const r = await deviceApi.pair<{ token: string; bundle: PosBundle }>(normalizePairingCode(code), deviceName.trim() || null, platformName());
      const next = stateFromBundle(r.token, r.bundle, state, deviceName.trim() || r.bundle.terminal.device_name || "");
      await saveDeviceState(next);
      setStorage(await storageEstimate());
      setCode("");
      setMsg({ tone: "ok", text: `Paired as ${r.bundle.terminal.code} for ${r.bundle.event.name}: ${r.bundle.items.length} items, ${r.bundle.cashiers.length} cashiers${persisted ? "" : " (persistent storage not granted; the browser may evict data under pressure)"}.` });
      onPrepared(next);
    } catch (e) {
      setMsg({ tone: "bad", text: e instanceof Error ? e.message : "Pairing failed" });
    } finally {
      setBusy(null);
    }
  }

  async function refresh() {
    setBusy("refresh");
    setMsg(null);
    try {
      const next = await refreshBundle(state);
      setMsg({ tone: "ok", text: `Catalog refreshed: ${next.bundle.items.length} items, ${next.bundle.cashiers.length} cashiers, version ${next.bundle.event.catalog_version}.` });
      onPrepared(next);
    } catch (e) {
      setMsg({ tone: "bad", text: e instanceof Error ? e.message : "Refresh failed" });
    } finally {
      setBusy(null);
    }
  }

  async function testPrint() {
    setBusy("print");
    const r = await printTestPage(state);
    setBusy(null);
    setMsg(r.ok ? { tone: "ok", text: "Test page sent to the printer." } : { tone: "bad", text: `Test print failed: ${r.reason}` });
  }
  async function connect(kind: "BLUETOOTH" | "USB") {
    setBusy("printer");
    const st = await connectPrinter(kind);
    setBusy(null);
    setMsg(st.connected ? { tone: "ok", text: `Printer ${st.name} connected. The browser remembers it.` } : { tone: "bad", text: st.error ?? "No printer chosen" });
  }
  async function clearTests() {
    const n = await clearTestSales();
    setMsg({ tone: "ok", text: `${n} test sale(s) cleared.` });
  }

  const b = state.bundle;
  return (
    <div className="screen setup">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>Device setup <span className="muted small">Houzs POS {APP_VERSION}</span></h1>
        <button type="button" className="btn" onClick={onExit}>Back to login</button>
      </div>

      <div className="card">
        <h2>Status</h2>
        <div className="status-line"><Dot tone={online == null ? "none" : online ? "ok" : "bad"} /> ERP connection: {online == null ? "checking…" : online ? "reachable" : "not reachable (pairing and refresh need internet; selling does not)"}</div>
        <div className="status-line"><Dot tone="ok" /> Terminal: {b.terminal.code} prepared {fmtMyt(state.prepared_at)} for {b.event.name}</div>
        <div className="status-line">
          <Dot tone={printer.connected ? "ok" : "bad"} /> Printer: {printer.connected ? `${printer.name} ready (${printer.transport === "USB" ? "USB" : "Bluetooth"})` : printer.error ? `not connected (${printer.error})` : "not found"}
          {!printer.connected && <span className="row" style={{ marginLeft: "auto", gap: 6 }}>
            {support.bluetooth && <button type="button" className="btn" style={{ minHeight: 34 }} disabled={busy !== null} onClick={() => void connect("BLUETOOTH")}>Connect Bluetooth printer</button>}
            {support.usb && <button type="button" className="btn" style={{ minHeight: 34 }} disabled={busy !== null} onClick={() => void connect("USB")}>Connect USB printer</button>}
            {!support.bluetooth && !support.usb && <span className="muted small">Use Chrome for Bluetooth / USB printing</span>}
          </span>}
        </div>
        <div className="status-line"><Dot tone="none" /> Scanner: ready after the first successful scan on the sell screen (HID keyboard mode, no setup)</div>
        <div className="status-line"><Dot tone={storage?.persisted ? "ok" : "warn"} /> Storage: {storage ? `${storage.persisted ? "persistent" : "best-effort"} · ${(storage.usage / 1048576).toFixed(1)} MB used` : "checking…"}</div>
      </div>

      <div className="card">
        <h2>Checklist</h2>
        <ul className="checklist" style={{ listStyle: "none", padding: 0, margin: 0 }}>
          <li><Dot tone={b.items.length > 0 ? "ok" : "warn"} /> Catalog: {b.items.length} items (version {b.event.catalog_version})</li>
          <li><Dot tone={b.cashiers.length > 0 ? "ok" : "warn"} /> Cashiers: {b.cashiers.length} ({b.cashiers.filter((c) => c.role === "SUPERVISOR").length} supervisor)</li>
          <li><Dot tone="ok" /> Settings: SST {b.settings.sst_receipt.sst_rate}% · {b.settings.sst_receipt.paper_width} mm · cash {b.settings.general.payment_methods.CASH ? "on" : "off"}</li>
          <li><Dot tone={storage?.persisted ? "ok" : "warn"} /> Persistent storage {storage?.persisted ? "granted" : "not granted"}</li>
        </ul>
        <div className="row" style={{ marginTop: 10 }}>
          <button type="button" className="btn" disabled={busy !== null || !online} onClick={() => void refresh()}>Refresh catalog</button>
          <button type="button" className="btn" disabled={busy !== null || !printer.connected} onClick={() => void testPrint()}>Test print</button>
          <span className="grow" />
          <label className="row small"><input type="checkbox" checked={state.test_mode} onChange={(e) => onToggleTest(e.target.checked)} /> Test mode</label>
          <button type="button" className="btn" disabled={busy !== null} onClick={() => void clearTests()} title="Delete every TEST sale on this device">Clear test sales</button>
        </div>
      </div>

      <div className="card">
        <h2>Pair again (move this device to another terminal or event)</h2>
        <p className="muted" style={{ marginTop: 0 }}>In the ERP open POS Admin, Terminals, and press <b>Pair device</b> on the terminal. Type the code it shows. The old pairing stops working; unsynced bills stay on this device and sync under the new terminal only if it is the same terminal.</p>
        <form onSubmit={(e) => { e.preventDefault(); void pair(); }}>
          <label className="field"><span>Pairing code</span><input value={code} onChange={(e) => setCode(formatPairingCode(e.target.value))} placeholder="H7K2-9QPD" autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={9} style={{ fontFamily: "ui-monospace, monospace", letterSpacing: "0.12em" }} /></label>
          <label className="field"><span>Device name</span><input value={deviceName} onChange={(e) => setDeviceName(e.target.value)} placeholder="e.g. Tab A9 #1" /></label>
          <button type="submit" className="btn primary" disabled={busy !== null || !isPairingCode(code) || online === false}>{busy === "pair" ? "Pairing…" : "Pair"}</button>
        </form>
      </div>

      {msg && <div className={`banner ${msg.tone === "ok" ? "update" : "offline"}`}>{msg.text}</div>}
      <PingLine />
    </div>
  );
}

function PingLine() {
  const [at, setAt] = useState<string | null>(null);
  useEffect(() => { deviceApi.ping().then((r) => setAt(r.at)).catch(() => setAt(null)); }, []);
  return at ? <p className="muted small">ERP time {fmtMyt(at)}</p> : null;
}
