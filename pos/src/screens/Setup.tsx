/* Settings (layout P15), reached from the sell screen (Settings button) or
 * from the login gear with a supervisor PIN. Status lines (ERP, terminal,
 * printer, scanner, storage), the checklist, Refresh catalog, Test print,
 * Test mode, Clear test sales, and the device setup itself: a signed-in
 * manager picks the terminal and the fair from lists and presses one button;
 * a device with no ERP login on it uses a pairing code from POS Admin >
 * Terminals instead. Cashiers never see this screen. */
import { useEffect, useState } from "react";
import { formatPairingCode, isPairingCode, normalizePairingCode } from "@shared/pos-pairing";
import { adminApi, deviceApi, erpReachable } from "../api";
import { requestPersistentStorage, storageEstimate } from "../db";
import { refreshBundle, saveDeviceState, stateFromBundle, platformName } from "../deviceStore";
import { fmtMyt } from "../loginRules";
import type { Manager } from "../manager";
import { connectPrinter, onPrinterStatus, printerSupported, type PrinterStatus } from "../printer";
import { printTestPage } from "../printing";
import { clearTestSales } from "../salesStore";
import { APP_VERSION } from "../pwa";
import type { DeviceState, PosBundle } from "../types";

type Terminal = { id: number; code: string; device_name: string | null; project_id: number | null; project_name: string | null; prepared_at: string | null; active: boolean };
type EventRow = { project_id: number; name: string; start_date: string | null; end_date: string | null; status: string; linked?: boolean; link: unknown | null };

function Dot({ tone }: { tone: "ok" | "warn" | "bad" | "none" }) {
  return <span className={`dot ${tone === "none" ? "" : tone}`} />;
}

export function Setup({ state, manager, onPrepared, onExit, onToggleTest }: {
  state: DeviceState;
  manager: Manager | null;
  onPrepared: (s: DeviceState) => void;
  onExit: () => void;
  onToggleTest: (on: boolean) => void;
}) {
  const [online, setOnline] = useState<boolean | null>(null);
  const [storage, setStorage] = useState<{ persisted: boolean; usage: number; quota: number } | null>(null);
  const [terminals, setTerminals] = useState<Terminal[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [listsError, setListsError] = useState<string | null>(null);
  const [terminalId, setTerminalId] = useState<number | "">(state.provisional ? "" : state.bundle.terminal.id);
  const [projectId, setProjectId] = useState<number | "">(state.provisional ? "" : state.bundle.event.project_id);
  const [deviceName, setDeviceName] = useState(state.device_name);
  const [code, setCode] = useState("");
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

  useEffect(() => {
    if (!manager) return;
    let alive = true;
    Promise.all([
      adminApi.get<{ data: Terminal[] }>(manager.token, "/api/pos-admin/terminals"),
      adminApi.get<{ data: EventRow[] }>(manager.token, "/api/pos-admin/events"),
    ]).then(([t, e]) => {
      if (!alive) return;
      setTerminals(t.data.filter((x) => x.active));
      setEvents(e.data.filter((x) => x.link != null || x.linked === true));
    }).catch((e) => { if (alive) setListsError(e instanceof Error ? e.message : "Could not load the lists"); });
    return () => { alive = false; };
  }, [manager]);

  async function finish(r: { token: string; bundle: PosBundle }, persisted: boolean) {
    const next = stateFromBundle(r.token, r.bundle, state.provisional ? null : state, deviceName.trim() || r.bundle.terminal.device_name || "");
    await saveDeviceState(next);
    setStorage(await storageEstimate());
    setMsg({ tone: "ok", text: `This device is now ${r.bundle.terminal.code} for ${r.bundle.event.name}: ${r.bundle.items.length} items, ${r.bundle.cashiers.length} cashiers${persisted ? "" : " (persistent storage not granted; the browser may evict data under pressure)"}.` });
    onPrepared(next);
  }

  async function setUp() {
    if (!manager || terminalId === "" || projectId === "") return;
    setBusy("setup");
    setMsg(null);
    try {
      const persisted = await requestPersistentStorage();
      const r = await adminApi.post<{ token: string; bundle: PosBundle }>(manager.token, "/api/pos-admin/device/register", {
        terminal_id: terminalId, project_id: projectId, device_name: deviceName.trim() || null, platform: platformName(),
      });
      await finish(r, persisted);
    } catch (e) {
      setMsg({ tone: "bad", text: e instanceof Error ? e.message : "Setup failed" });
    } finally {
      setBusy(null);
    }
  }

  async function pair() {
    if (!isPairingCode(code)) return;
    setBusy("pair");
    setMsg(null);
    try {
      const persisted = await requestPersistentStorage();
      const r = await deviceApi.pair<{ token: string; bundle: PosBundle }>(normalizePairingCode(code), deviceName.trim() || null, platformName());
      setCode("");
      await finish(r, persisted);
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
  const setUpAlready = !state.provisional;
  return (
    <div className="screen setup">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>Settings <span className="muted small">Houzs POS {APP_VERSION}</span></h1>
        <button type="button" className="btn" onClick={onExit}>Back</button>
      </div>

      {!setUpAlready && (
        <div className="banner update">This device is not set up yet. Pick the terminal and the fair below and press Set up this device; the cashier tiles and the items arrive with it.</div>
      )}

      <div className="card">
        <h2>{setUpAlready ? "Move this device to another terminal or fair" : "Set up this device"}</h2>
        {manager ? (
          <div>
            <p className="muted" style={{ marginTop: 0 }}>Signed in as {manager.user.name}. The lists come from POS Admin: terminals from the Terminals tab, fairs that are linked to POS from the Events tab.</p>
            {listsError && <div className="banner offline">{listsError}</div>}
            <label className="field"><span>Terminal</span>
              <select value={terminalId} onChange={(e) => setTerminalId(e.target.value ? Number(e.target.value) : "")}>
                <option value="">Pick a terminal</option>
                {terminals.map((t) => <option key={t.id} value={t.id}>{t.code}{t.device_name ? ` · ${t.device_name}` : ""}{t.project_name ? ` · ${t.project_name}` : ""}{t.prepared_at ? " (set up before)" : ""}</option>)}
              </select>
            </label>
            {terminals.length === 0 && !listsError && <p className="muted small">No terminal yet: create one in POS Admin, Terminals (New terminal), then come back here.</p>}
            <label className="field"><span>Fair</span>
              <select value={projectId} onChange={(e) => setProjectId(e.target.value ? Number(e.target.value) : "")}>
                <option value="">Pick a fair</option>
                {events.map((ev) => <option key={ev.project_id} value={ev.project_id}>{ev.name}{ev.start_date ? ` · ${ev.start_date}` : ""} · {ev.status}</option>)}
              </select>
            </label>
            {events.length === 0 && !listsError && <p className="muted small">No fair is linked to POS yet: in POS Admin, Events, open the fair and press Save; it appears here.</p>}
            <label className="field"><span>Device name</span><input value={deviceName} onChange={(e) => setDeviceName(e.target.value)} placeholder="e.g. Laptop Lenovo" /></label>
            <button type="button" className="btn primary" disabled={busy !== null || terminalId === "" || projectId === "" || online === false} onClick={() => void setUp()}>{busy === "setup" ? "Setting up…" : setUpAlready ? "Move this device" : "Set up this device"}</button>
          </div>
        ) : (
          <div>
            <p className="muted" style={{ marginTop: 0 }}>No ERP sign-in on this device: in the ERP open POS Admin, Terminals, press <b>Pair device</b> on the terminal and type the code it shows.</p>
            <form onSubmit={(e) => { e.preventDefault(); void pair(); }}>
              <label className="field"><span>Pairing code</span><input value={code} onChange={(e) => setCode(formatPairingCode(e.target.value))} placeholder="H7K2-9QPD" autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={9} style={{ fontFamily: "ui-monospace, monospace", letterSpacing: "0.12em" }} /></label>
              <label className="field"><span>Device name</span><input value={deviceName} onChange={(e) => setDeviceName(e.target.value)} placeholder="e.g. Tab A9 #1" /></label>
              <button type="submit" className="btn primary" disabled={busy !== null || !isPairingCode(code) || online === false}>{busy === "pair" ? "Pairing…" : "Pair"}</button>
            </form>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Status</h2>
        <div className="status-line"><Dot tone={online == null ? "none" : online ? "ok" : "bad"} /> ERP connection: {online == null ? "checking…" : online ? "reachable" : "not reachable (setup and refresh need internet; selling does not)"}</div>
        <div className="status-line"><Dot tone={setUpAlready ? "ok" : "warn"} /> Terminal: {setUpAlready ? `${b.terminal.code} set up ${fmtMyt(state.prepared_at)} for ${b.event.name}` : "not set up"}</div>
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

      {setUpAlready && (
        <div className="card">
          <h2>Checklist</h2>
          <ul className="checklist" style={{ listStyle: "none", padding: 0, margin: 0 }}>
            <li><Dot tone={b.items.length > 0 ? "ok" : "warn"} /> Catalog: {b.items.length} items (version {b.event.catalog_version}){b.items.length === 0 ? " — tag items in POS Admin, POS Items, then Refresh catalog" : ""}</li>
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
      )}

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
