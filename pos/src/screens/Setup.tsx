/* Device setup (layout P15) — needs internet. Minimal on purpose: an admin
 * signs in with the ERP account, picks Terminal ID + Event and taps Prepare
 * device. The bundle download, persistent-storage request and the device
 * token are automatic. Printer and scanner are status lines only (the
 * printer pairing arrives with the receipt step). Also here: Refresh catalog,
 * Test mode, and later Import backup. Cashiers never see this screen. */
import { useEffect, useState } from "react";
import { adminApi, deviceApi, erpReachable } from "../api";
import { requestPersistentStorage, storageEstimate } from "../db";
import { refreshBundle, saveDeviceState, stateFromBundle, platformName } from "../deviceStore";
import { fmtMyt } from "../loginRules";
import { demoState } from "../demo";
import { connectPrinter, onPrinterStatus, printerSupported, type PrinterStatus } from "../printer";
import { printTestPage } from "../printing";
import { clearTestSales } from "../salesStore";
import { APP_VERSION } from "../pwa";
import type { DeviceState, PosBundle } from "../types";

type Terminal = { id: number; code: string; device_name: string | null; project_id: number | null; project_name: string | null; prepared_at: string | null; active: boolean };
type EventRow = { project_id: number; name: string; start_date: string | null; end_date: string | null; status: string; link: unknown | null };

function Dot({ tone }: { tone: "ok" | "warn" | "bad" | "none" }) {
  return <span className={`dot ${tone === "none" ? "" : tone}`} />;
}

export function Setup({ state, onPrepared, onExit, onToggleTest }: {
  state: DeviceState | null;
  onPrepared: (s: DeviceState) => void;
  onExit: () => void;
  onToggleTest: (on: boolean) => void;
}) {
  const [online, setOnline] = useState<boolean | null>(null);
  const [storage, setStorage] = useState<{ persisted: boolean; usage: number; quota: number } | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [terminals, setTerminals] = useState<Terminal[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [terminalId, setTerminalId] = useState<number | "">(state?.bundle.terminal.id ?? "");
  const [projectId, setProjectId] = useState<number | "">(state?.bundle.event.project_id ?? "");
  const [deviceName, setDeviceName] = useState(state?.device_name ?? "");
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

  async function signIn() {
    setBusy("login");
    setMsg(null);
    try {
      const r = await adminApi.login(email.trim(), password);
      setPassword("");
      setToken(r.token);
      const [t, e] = await Promise.all([
        adminApi.get<{ data: Terminal[] }>(r.token, "/api/pos-admin/terminals"),
        adminApi.get<{ data: EventRow[] }>(r.token, "/api/pos-admin/events"),
      ]);
      setTerminals((t.data ?? []).filter((x) => x.active));
      setEvents((e.data ?? []).filter((x) => x.link));
    } catch (e) {
      setMsg({ tone: "bad", text: e instanceof Error ? (e.message.includes("403") || e.message.includes("permission") ? "This account cannot manage POS (needs Manage POS)." : e.message) : "Sign-in failed" });
    } finally {
      setBusy(null);
    }
  }

  async function startDemo() {
    setBusy("demo");
    setMsg(null);
    try {
      const next = await demoState(state);
      await saveDeviceState(next);
      onPrepared(next);
    } catch (e) {
      setMsg({ tone: "bad", text: e instanceof Error ? e.message : "Could not start the demo" });
    } finally {
      setBusy(null);
    }
  }

  async function prepare() {
    if (!token || terminalId === "" || projectId === "") return;
    setBusy("prepare");
    setMsg(null);
    try {
      const persisted = await requestPersistentStorage();
      const r = await adminApi.post<{ token: string; bundle: PosBundle }>(token, "/api/pos-admin/device/register", {
        terminal_id: terminalId, project_id: projectId, device_name: deviceName.trim() || null, platform: platformName(),
      });
      const next = stateFromBundle(r.token, r.bundle, state, deviceName.trim() || r.bundle.terminal.device_name || "");
      await saveDeviceState(next);
      setStorage(await storageEstimate());
      setMsg({ tone: "ok", text: `Prepared ${r.bundle.terminal.code} for ${r.bundle.event.name}: ${r.bundle.items.length} items, ${r.bundle.cashiers.length} cashiers${persisted ? "" : " (persistent storage not granted; the browser may evict data under pressure)"}.` });
      await adminApi.logout(token);
      setToken(null);
      onPrepared(next);
    } catch (e) {
      setMsg({ tone: "bad", text: e instanceof Error ? e.message : "Prepare failed" });
    } finally {
      setBusy(null);
    }
  }

  async function refresh() {
    if (!state) return;
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
    if (!state) return;
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

  const b = state?.bundle ?? null;
  return (
    <div className="screen">
      <div className="row">
        <h1 style={{ margin: 0, fontSize: 20 }}>Device setup</h1>
        <span className="muted">Houzs POS {APP_VERSION}</span>
        <span className="grow" />
        {b && <button type="button" className="btn" onClick={onExit}>Back to login</button>}
      </div>

      <div className="card">
        <h2>Status</h2>
        <div className="status-line"><Dot tone={online == null ? "none" : online ? "ok" : "bad"} /> ERP connection: {online == null ? "checking…" : online ? "reachable" : "not reachable (setup needs internet)"}</div>
        <div className="status-line"><Dot tone={b ? "ok" : "warn"} /> Terminal: {b ? <><b className="mono">&nbsp;{b.terminal.code}</b>&nbsp;· {b.event.name} · prepared {fmtMyt(state?.prepared_at)}</> : "not prepared"}</div>
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

      {b && (
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
            <button type="button" className="btn" disabled title="Arrives with the sync step">Import backup</button>
            <span className="grow" />
            <label className="row small"><input type="checkbox" checked={state?.test_mode ?? false} disabled={state?.demo} onChange={(e) => onToggleTest(e.target.checked)} /> Test mode{state?.demo ? " (always on in demo)" : ""}</label>
            <button type="button" className="btn" disabled={busy !== null} onClick={() => void clearTests()} title="Delete every TEST sale on this device">Clear test sales</button>
          </div>
        </div>
      )}

      {(!b || state?.demo) && (
        <div className="card">
          <h2>{state?.demo ? "Demo mode is on" : "No device yet? Try the POS with sample data"}</h2>
          <p className="muted" style={{ marginTop: 0 }}>
            {state?.demo
              ? "The sell screen runs on a sample catalog; every sale is a TEST sale and nothing reaches the ERP. Prepare a real terminal below when it exists."
              : "Opens the login and sell screens with 8 sample items and 2 sample cashiers (PIN 1234). Every sale is a TEST sale; nothing reaches the ERP. Prepare a real terminal below whenever it exists."}
          </p>
          {!state?.demo && <button type="button" className="btn primary" disabled={busy !== null} onClick={() => void startDemo()}>{busy === "demo" ? "Loading…" : "Open demo POS"}</button>}
        </div>
      )}
      <div className="card">
        <h2>{b ? "Re-prepare this device" : "Prepare this device"}</h2>
        {!token ? (
          <form onSubmit={(e) => { e.preventDefault(); void signIn(); }}>
            <p className="muted" style={{ marginTop: 0 }}>Sign in with an ERP account that may manage POS. The sign-in is used only to prepare the device and is dropped afterwards.</p>
            <label className="field"><span>ERP email</span><input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
            <label className="field"><span>Password</span><input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
            <button type="submit" className="btn primary" disabled={busy !== null || online === false}>Sign in</button>
          </form>
        ) : (
          <div>
            <label className="field"><span>Terminal ID</span>
              <select value={terminalId} onChange={(e) => setTerminalId(e.target.value ? Number(e.target.value) : "")}>
                <option value="">Pick a terminal</option>
                {terminals.map((t) => <option key={t.id} value={t.id}>{t.code}{t.device_name ? ` · ${t.device_name}` : ""}{t.project_name ? ` · ${t.project_name}` : ""}{t.prepared_at ? " (prepared before)" : ""}</option>)}
              </select>
            </label>
            <label className="field"><span>Event</span>
              <select value={projectId} onChange={(e) => setProjectId(e.target.value ? Number(e.target.value) : "")}>
                <option value="">Pick an event</option>
                {events.map((ev) => <option key={ev.project_id} value={ev.project_id}>{ev.name} · {ev.status}</option>)}
              </select>
            </label>
            <label className="field"><span>Device name</span><input value={deviceName} onChange={(e) => setDeviceName(e.target.value)} placeholder="e.g. Tab A9 #1" /></label>
            <div className="row">
              <button type="button" className="btn primary" disabled={busy !== null || terminalId === "" || projectId === ""} onClick={() => void prepare()}>{busy === "prepare" ? "Preparing…" : "Prepare device"}</button>
              <button type="button" className="btn" onClick={() => { void adminApi.logout(token); setToken(null); }}>Cancel</button>
            </div>
            {events.length === 0 && <p className="muted">No event is linked to POS yet. Link one in the ERP under POS Admin › Events.</p>}
          </div>
        )}
      </div>

      {msg && <div className={`banner ${msg.tone === "ok" ? "update" : "offline"}`}>{msg.text}</div>}
      <p className="muted small">Recommended: Android tablet or Windows laptop with Chrome, installed as an app. iPad only if added to the Home Screen.</p>
      <PingLine />
    </div>
  );
}

function PingLine() {
  const [at, setAt] = useState<string | null>(null);
  useEffect(() => { deviceApi.ping().then((r) => setAt(r.at)).catch(() => setAt(null)); }, []);
  return at ? <p className="muted small">ERP time {fmtMyt(at)}</p> : null;
}
