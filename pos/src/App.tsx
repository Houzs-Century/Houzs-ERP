/* Houzs POS shell: boot from IndexedDB, then Pair (no terminal yet),
 * Login, or Sell. Online state is the ERP ping, not the radio. */
import { useCallback, useEffect, useState } from "react";
import { erpReachable } from "./api";
import { clearDeviceState, loadDeviceState, saveDeviceState } from "./deviceStore";
import { reconnectPrinter } from "./printer";
import { onUpdateAvailable } from "./pwa";
import { LeaveDialog } from "./sell/SyncPanel";
import { heartbeat, onDeviceStateChanged, setSyncCashier, startSyncEngine, syncNow, syncStatus } from "./sync";
import { Login } from "./screens/Login";
import { Sell } from "./screens/Sell";
import { Setup } from "./screens/Setup";
import { Pair } from "./screens/Pair";
import type { BundleCashier, DeviceState, Session } from "./types";

type Screen = "boot" | "setup" | "login" | "sell";

export function App() {
  const [screen, setScreen] = useState<Screen>("boot");
  const [state, setState] = useState<DeviceState | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [online, setOnline] = useState<boolean | null>(null);
  const [updateWaiting, setUpdateWaiting] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);

  useEffect(() => {
    loadDeviceState()
      .then((raw) => {
        /* A state without a token is a leftover of the retired demo mode: drop it and pair. */
        const s = raw && raw.token ? raw : null;
        if (raw && !s) void clearDeviceState();
        setState(s); setScreen(s ? "login" : "setup"); if (s) void reconnectPrinter();
      })
      .catch((e) => setBootError(e instanceof Error ? e.message : "Local storage could not be opened"));
    return onUpdateAvailable(setUpdateWaiting);
  }, []);

  useEffect(() => {
    let alive = true;
    const check = () => erpReachable().then((ok) => { if (alive) setOnline(ok); });
    void check();
    const t = setInterval(() => void check(), 60_000);
    const on = () => void check();
    window.addEventListener("online", on);
    window.addEventListener("offline", () => alive && setOnline(false));
    return () => { alive = false; clearInterval(t); window.removeEventListener("online", on); };
  }, []);

  const login = useCallback(async (c: BundleCashier) => {
    if (!state) return;
    const next = { ...state, last_login: { cashier: c.name, at: new Date().toISOString() } };
    setState(next);
    await saveDeviceState(next);
    setSession({ cashier: c, started_at: new Date().toISOString() });
    setSyncCashier(c.name);
    setScreen("sell");
    void heartbeat();
  }, [state]);

  const [leaving, setLeaving] = useState<number | null>(null);
  const doLogout = useCallback(() => { setLeaving(null); setSession(null); setSyncCashier(null); setScreen("login"); }, []);
  /* Leaving with unsynced sales (P14): the dialog on Logout; the browser's own
     prompt on close / reload. The data stays on the device either way. */
  const logout = useCallback(() => {
    const p = syncStatus().pending;
    if (p > 0) setLeaving(p); else doLogout();
  }, [doLogout]);
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => { if (syncStatus().pending > 0) { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, []);
  useEffect(() => {
    if (!state) return;
    const stop = startSyncEngine(state.bundle.settings.general.heartbeat_minutes);
    const off = onDeviceStateChanged(setState);
    return () => { stop(); off(); };
    // The engine is started once per prepared device; a refreshed bundle flows back through onDeviceStateChanged.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.token]);

  const toggleTest = useCallback(async (on: boolean) => {
    if (!state) return;
    const next = { ...state, test_mode: on };
    setState(next);
    await saveDeviceState(next);
  }, [state]);

  if (bootError) return <div className="screen"><div className="card">The POS cannot open its local storage: {bootError}. Use Chrome, not a private window.</div></div>;
  if (screen === "boot") return <div className="screen"><p className="muted">Opening Houzs POS…</p></div>;
  if (screen === "setup" && state) return <Setup state={state} onPrepared={(s) => { setState(s); setScreen("login"); }} onExit={() => setScreen("login")} onToggleTest={(on) => void toggleTest(on)} />;
  const leave = leaving != null && <LeaveDialog pending={leaving} onCancel={() => setLeaving(null)} onSyncNow={() => { void syncNow("logout").then(() => { if (syncStatus().pending === 0) doLogout(); else setLeaving(syncStatus().pending); }); }} onLeave={doLogout} />;
  if (screen === "sell" && state && session) return <><Sell state={state} session={session} online={online} onLogout={logout} onStateChanged={setState} />{leave}</>;
  if (state) return <><Login state={state} online={online} updateWaiting={updateWaiting} onLogin={(c) => void login(c)} onOpenSetup={() => setScreen("setup")} onStateChanged={setState} />{leave}</>;
  return <Pair prev={state} onPaired={(s) => { setState(s); setScreen("login"); }} />;
}
