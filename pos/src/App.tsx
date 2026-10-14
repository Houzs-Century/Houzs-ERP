/* Houzs POS shell: boot from IndexedDB, then Device setup (not prepared),
 * Login, or Sell. Online state is the ERP ping, not the radio. */
import { useCallback, useEffect, useState } from "react";
import { erpReachable } from "./api";
import { loadDeviceState, saveDeviceState, sendHeartbeat } from "./deviceStore";
import { reconnectPrinter } from "./printer";
import { onUpdateAvailable } from "./pwa";
import { Login } from "./screens/Login";
import { Sell } from "./screens/Sell";
import { Setup } from "./screens/Setup";
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
      .then((s) => { setState(s); setScreen(s ? "login" : "setup"); if (s) { void sendHeartbeat(s, null); void reconnectPrinter(); } })
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
    setScreen("sell");
    void sendHeartbeat(next, c.name);
  }, [state]);

  const logout = useCallback(() => { setSession(null); setScreen("login"); }, []);

  const toggleTest = useCallback(async (on: boolean) => {
    if (!state) return;
    const next = { ...state, test_mode: on };
    setState(next);
    await saveDeviceState(next);
  }, [state]);

  if (bootError) return <div className="screen"><div className="card">The POS cannot open its local storage: {bootError}. Use Chrome, not a private window.</div></div>;
  if (screen === "boot") return <div className="screen"><p className="muted">Opening Houzs POS…</p></div>;
  if (screen === "setup") return <Setup state={state} onPrepared={(s) => { setState(s); setScreen("login"); }} onExit={() => setScreen(state ? "login" : "setup")} onToggleTest={(on) => void toggleTest(on)} />;
  if (screen === "sell" && state && session) return <Sell state={state} session={session} online={online} onLogout={logout} />;
  if (state) return <Login state={state} online={online} updateWaiting={updateWaiting} onLogin={(c) => void login(c)} onOpenSetup={() => setScreen("setup")} />;
  return <Setup state={null} onPrepared={(s) => { setState(s); setScreen("login"); }} onExit={() => setScreen("setup")} onToggleTest={() => {}} />;
}
