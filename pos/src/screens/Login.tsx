/* Login (layout P1), the POS front: logo + company, fair + dates, Terminal
 * ID, last sync, previous login; cashier tiles (max 8 + Type ID); the PIN
 * card; wrong PIN shakes and clears, five wrong lock for 30 s; verified
 * offline against the bundle's PIN hashes. A manager (ERP account that may
 * manage POS) signs in with email + password: on a device not set up yet
 * that is the whole front, and Settings inside does the setup. Gear: Device
 * setup after a supervisor PIN. "Update available" shows only here. */
import { useEffect, useMemo, useState } from "react";
import { PinPad } from "../PinPad";
import { afterWrongPin, findCashierById, fmtDateRange, fmtMyt, freshLock, lockedFor, loginTiles, syncTone, type LockState } from "../loginRules";
import { managerLogin, type Manager, type ManagerContext } from "../manager";
import { verifyPin } from "../pin";
import { APP_VERSION, applyUpdate, isStandalone, onInstallAvailable, promptInstall } from "../pwa";
import { SyncPanel } from "../sell/SyncPanel";
import type { BundleCashier, DeviceState } from "../types";

export function Login({ state, online, updateWaiting, onLogin, onManager, onOpenSetup, onStateChanged }: {
  state: DeviceState | null;
  online: boolean | null;
  updateWaiting: boolean;
  onLogin: (c: BundleCashier) => void;
  onManager: (m: Manager, ctx: ManagerContext) => void;
  onOpenSetup: () => void;
  onStateChanged: (s: DeviceState) => void;
}) {
  const [syncOpen, setSyncOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const b = state?.bundle ?? null;
  const cashiers = useMemo(() => b?.cashiers ?? [], [b]);
  const { tiles, overflow } = useMemo(() => loginTiles(cashiers), [cashiers]);
  const [selected, setSelected] = useState<BundleCashier | null>(null);
  const [typing, setTyping] = useState(false);
  const [typed, setTyped] = useState("");
  const [lock, setLock] = useState<LockState>(freshLock);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState<string | null>(null);
  const [shakeKey, setShakeKey] = useState(0);
  const [checking, setChecking] = useState(false);
  const [gear, setGear] = useState(false);
  const [updateLater, setUpdateLater] = useState(false);
  const [canInstall, setCanInstall] = useState(false);
  const [installLater, setInstallLater] = useState(false);
  useEffect(() => onInstallAvailable(setCanInstall), []);
  const [managerOpen, setManagerOpen] = useState(!state || state.provisional === true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [managerBusy, setManagerBusy] = useState(false);
  const [managerError, setManagerError] = useState<string | null>(null);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const lockedSeconds = lockedFor(lock, now);

  async function submit(pin: string) {
    const who = gear ? null : selected;
    if (!gear && !who) { setError("Choose your name first"); return; }
    setChecking(true);
    try {
      if (gear) {
        const supers = cashiers.filter((c) => c.role === "SUPERVISOR");
        let ok = false;
        for (const s of supers) if (await verifyPin(pin, s.pin_hash)) { ok = true; break; }
        if (ok) { setGear(false); onOpenSetup(); return; }
      } else if (who && (await verifyPin(pin, who.pin_hash))) {
        setLock(freshLock());
        onLogin(who);
        return;
      }
      setLock((l) => afterWrongPin(l, Date.now()));
      setError("Wrong PIN");
      setShakeKey((k) => k + 1);
    } finally {
      setChecking(false);
    }
  }

  async function signInManager() {
    if (!email.trim() || !password) { setManagerError("Email and password, please."); return; }
    setManagerBusy(true);
    setManagerError(null);
    try {
      const r = await managerLogin(email, password);
      setPassword("");
      onManager(r.manager, r.context);
    } catch (e) {
      setManagerError(e instanceof Error ? e.message : "Sign-in failed");
    } finally {
      setManagerBusy(false);
    }
  }

  const pickTyped = () => {
    const c = findCashierById([...tiles, ...overflow], typed);
    if (!c) { setError("No cashier with that ID"); return; }
    setSelected(c);
    setError(null);
    setTyping(false);
  };

  const tone = syncTone(state?.last_sync_at ?? null, now);
  const supervisorsExist = cashiers.some((c) => c.role === "SUPERVISOR");
  const setUp = !!state && !state.provisional;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand"><img src="/logo-hc-mark.png" alt="" /> {b?.company.name ?? "Houzs POS"}</div>
        <div className="grow" />
        {setUp && b && state && (
          <>
            <div className="meta">
              <div><b>{b.event.receipt_header || b.event.name}</b> {fmtDateRange(b.event.start_date, b.event.end_date)}</div>
              <div>Terminal <span className="pill mono">{b.terminal.code}</span></div>
            </div>
            <div className="meta">
              <button type="button" className={`btn link sync ${tone}`} style={{ padding: 0, minHeight: 0, fontSize: 12 }} onClick={() => setSyncOpen(true)} title="Sync panel">Last sync {state.last_sync_at ? fmtMyt(state.last_sync_at) : `-- (set up ${fmtMyt(state.prepared_at)})`}</button>
              <div>{state.last_login ? `Previous login ${state.last_login.cashier} · ${fmtMyt(state.last_login.at)}` : "No login yet"}</div>
            </div>
            <button type="button" className="btn link" style={{ color: "#fff", fontSize: 20 }} title="Settings (supervisor PIN)" onClick={() => { if (!supervisorsExist) onOpenSetup(); else { setGear(true); setSelected(null); setError(null); } }}>&#9881;</button>
          </>
        )}
        {!setUp && <div className="meta"><div>Not set up yet</div><div>Sign in, then Settings</div></div>}
      </header>
      {state?.test_mode && <div className="banner test">TEST MODE is ON: bills print *** TEST ***, are numbered T-, never sync and never deduct stock. Turn it off in Settings before real sales.</div>}
      {updateWaiting && !updateLater && (
        <div className="banner update"><span className="grow">Update available for Houzs POS.</span><button type="button" className="btn primary" onClick={applyUpdate}>Restart now</button><button type="button" className="btn" onClick={() => setUpdateLater(true)}>Later</button></div>
      )}
      {canInstall && !installLater && !isStandalone() && (
        <div className="banner update"><span className="grow">Install Houzs POS on this device: it opens in its own window from the Start menu and works offline.</span><button type="button" className="btn primary" onClick={() => void promptInstall()}>Install</button><button type="button" className="btn" onClick={() => setInstallLater(true)}>Later</button></div>
      )}
      {online === false && <div className="banner offline">{setUp ? "Offline. Login and selling work; sales will sync when the connection returns." : "Offline. The first sign-in on a new device needs internet."}</div>}

      <div className="screen">
        <div className="login">
          <div>
            {setUp && (
              <>
                <div className="tiles">
                  {tiles.map((c) => (
                    <button key={c.id} type="button" className={`tile${selected?.id === c.id && !gear ? " selected" : ""}`} onClick={() => { setSelected(c); setGear(false); setError(null); setTyping(false); setManagerOpen(false); }}>
                      <span className="avatar">{c.name.slice(0, 1).toUpperCase()}</span>
                      {c.name}
                      <small>{c.role === "SUPERVISOR" ? "SUPERVISOR" : c.code}</small>
                    </button>
                  ))}
                  <button type="button" className="tile typeid" onClick={() => { setTyping((v) => !v); setGear(false); }}>Type ID<small>{overflow.length > 0 ? `${overflow.length} more` : "any cashier"}</small></button>
                </div>
                {typing && (
                  <div className="card" style={{ marginTop: 12 }}>
                    <div className="row">
                      <input className="kbd-input grow" autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Cashier ID or name" onKeyDown={(e) => { if (e.key === "Enter") pickTyped(); }} />
                      <button type="button" className="btn primary" onClick={pickTyped}>OK</button>
                    </div>
                  </div>
                )}
                {cashiers.length === 0 && <div className="card" style={{ marginTop: 12 }}>No cashier is assigned to this fair yet. Assign cashiers in the ERP (POS Admin, Events), then Refresh catalog in Settings. You can still sign in below with your ERP account.</div>}
                <p style={{ marginTop: 14 }}><button type="button" className="btn link" onClick={() => { setManagerOpen((v) => !v); setSelected(null); setGear(false); }}>{managerOpen ? "Hide manager sign-in" : "Manager sign-in with ERP account"}</button></p>
              </>
            )}
            {(managerOpen || !setUp) && (
              <form className="card" style={{ maxWidth: 440 }} onSubmit={(e) => { e.preventDefault(); void signInManager(); }}>
                <h2 style={{ marginTop: 0 }}>{setUp ? "Manager sign-in" : "Sign in to Houzs POS"}</h2>
                <p className="muted" style={{ marginTop: 0 }}>{setUp ? "Owner or admin: your ERP account opens the POS as a supervisor." : "Owner or admin: sign in with your ERP account. Cashiers get their name tiles once the device is set up in Settings."}</p>
                <label className="field"><span>ERP email</span><input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus={!setUp} /></label>
                <label className="field"><span>Password</span><input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
                {managerError && <div className="banner offline" style={{ marginBottom: 10 }}>{managerError}</div>}
                <button type="submit" className="btn primary" disabled={managerBusy || online === false}>{managerBusy ? "Signing in…" : "Sign in"}</button>
              </form>
            )}
          </div>
          {setUp && (
            <PinPad
              title={gear ? "Supervisor PIN for Settings" : selected ? `${selected.name} · enter PIN` : "Tap your name, then your PIN"}
              onSubmit={(pin) => void submit(pin)}
              disabled={checking || (!gear && !selected)}
              error={error}
              lockedSeconds={lockedSeconds}
              shakeKey={shakeKey}
              allowKeyboard={!typing && !managerOpen}
            />
          )}
        </div>
      </div>

      {syncOpen && state && <SyncPanel state={state} onStateChanged={onStateChanged} onClose={() => setSyncOpen(false)} say={(t) => { setNote(t); setTimeout(() => setNote(null), 2500); }} />}
      {note && <div className="toast">{note}</div>}
      <footer className="footer">
        {setUp && <button type="button" className="btn link" onClick={() => { setTyping((v) => !v); setGear(false); }}>Keyboard</button>}
        <button type="button" className="btn link" onClick={() => window.location.reload()}>Exit</button>
        {canInstall && !isStandalone() && <button type="button" className="btn link" onClick={() => void promptInstall()}>Install app</button>}
        <span className="grow" />
        <span>{setUp && state && b ? `Set up on ${fmtMyt(state.prepared_at)} · ${b.items.length} items · ` : ""}v{APP_VERSION}</span>
      </footer>
    </div>
  );
}
