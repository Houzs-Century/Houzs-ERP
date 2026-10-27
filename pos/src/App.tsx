/* Houzs POS shell: boot from IndexedDB, then Login (the front, always),
 * Sell, or Settings. A device not set up yet shows the manager sign-in on
 * the front; the manager gets in on a provisional state and sets the
 * terminal up from Settings. Online state is the ERP ping, not the radio. */
import { useCallback, useEffect, useState } from "react";
import { pairingCodeFromUrl } from "@shared/pos-pairing";
import { deviceApi, erpReachable } from "./api";
import { clearDeviceState, loadDeviceState, platformName, saveDeviceState, stateFromBundle } from "./deviceStore";
import { currentManager, managerCashier, managerLogout, provisionalState, type Manager, type ManagerContext } from "./manager";
import { reconnectPrinter } from "./printer";
import { onUpdateAvailable } from "./pwa";
import { LeaveDialog } from "./sell/SyncPanel";
import { heartbeat, onDeviceStateChanged, setSyncCashier, startSyncEngine, syncNow, syncStatus } from "./sync";
import { Login } from "./screens/Login";
import { Sell } from "./screens/Sell";
import { Setup } from "./screens/Setup";
import type { BundleCashier, DeviceState, PosBundle, Session } from "./types";

type Screen = "boot" | "setup" | "login" | "sell";

export function App() {
  const [screen, setScreen] = useState<Screen>("boot");
  const [state, setState] = useState<DeviceState | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [manager, setManager] = useState<Manager | null>(() => currentManager());
  const [online, setOnline] = useState<boolean | null>(null);
  const [updateWaiting, setUpdateWaiting] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const [setupFrom, setSetupFrom] = useState<"login" | "sell">("login");

  useEffect(() => {
    loadDeviceState()
      .then(async (raw) => {
        /* A stored state without a token is not a device: drop it. */
        let s = raw && raw.token ? raw : null;
        if (raw && !s) void clearDeviceState();
        /* The ?pair= link from POS Admin > Terminals sets the device up by itself. */
        const code = pairingCodeFromUrl(window.location.href);
        if (code && !s) {
          window.history.replaceState(null, "", window.location.pathname);
          try {
            const r = await deviceApi.pair<{ token: string; bundle: PosBundle }>(code, null, platformName());
            s = stateFromBundle(r.token, r.bundle, null, r.bundle.terminal.device_name ?? "");
            await saveDeviceState(s);
          } catch (e) {
            console.warn("[pos] pairing link failed", e);
          }
        }
        setState(s); setScreen("login"); if (s) void reconnectPrinter();
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
    if (!next.provisional) await saveDeviceState(next);
    setSession({ cashier: c, started_at: new Date().toISOString() });
    setSyncCashier(c.name);
    setScreen("sell");
    void heartbeat();
  }, [state]);

  /** An ERP account signed in on the front: a supervisor session, on the
   *  real device state when there is one, else on a provisional one. */
  const managerIn = useCallback((m: Manager, ctx: ManagerContext) => {
    setManager(m);
    const base = state && !state.provisional ? state : provisionalState(ctx);
    setState(base);
    setSession({ cashier: managerCashier(m), started_at: new Date().toISOString() });
    setSyncCashier(m.user.name);
    setScreen(base.provisional ? "setup" : "sell");
    setSetupFrom("sell");
  }, [state]);

  const [leaving, setLeaving] = useState<number | null>(null);
  const doLogout = useCallback(() => {
    setLeaving(null); setSession(null); setSyncCashier(null);
    if (manager) { void managerLogout(); setManager(null); }
    setState((s) => (s?.provisional ? null : s));
    setScreen("login");
  }, [manager]);
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
    if (!state || !state.token) return;
    const stop = startSyncEngine(state.bundle.settings.general.heartbeat_minutes);
    const off = onDeviceStateChanged(setState);
    return () => { stop(); off(); };
    // The engine is started once per set-up device; a refreshed bundle flows back through onDeviceStateChanged.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.token]);

  const toggleTest = useCallback(async (on: boolean) => {
    if (!state || state.provisional) return;
    const next = { ...state, test_mode: on };
    setState(next);
    await saveDeviceState(next);
  }, [state]);

  /** Settings finished a setup: the real state replaces the provisional one;
   *  a manager session stays signed in and lands on the sell screen. */
  const prepared = useCallback((s: DeviceState) => {
    setState(s);
    setScreen(session ? "sell" : "login");
  }, [session]);

  if (bootError) return <div className="screen"><div className="card">The POS cannot open its local storage: {bootError}. Use Chrome, not a private window.</div></div>;
  if (screen === "boot") return <div className="screen"><p className="muted">Opening Houzs POS…</p></div>;
  if (screen === "setup" && state) return <Setup state={state} manager={manager} onPrepared={prepared} onExit={() => setScreen(setupFrom === "sell" && session ? "sell" : "login")} onToggleTest={(on) => void toggleTest(on)} />;
  const leave = leaving != null && <LeaveDialog pending={leaving} onCancel={() => setLeaving(null)} onSyncNow={() => { void syncNow("logout").then(() => { if (syncStatus().pending === 0) doLogout(); else setLeaving(syncStatus().pending); }); }} onLeave={doLogout} />;
  if (screen === "sell" && state && session) return <><Sell state={state} session={session} online={online} onLogout={logout} onOpenSetup={() => { setSetupFrom("sell"); setScreen("setup"); }} onStateChanged={setState} />{leave}</>;
  return <><Login state={state} online={online} updateWaiting={updateWaiting} onLogin={(c) => void login(c)} onManager={managerIn} onOpenSetup={() => { setSetupFrom("login"); setScreen("setup"); }} onStateChanged={setState} />{leave}</>;
}
