/* Login (layout P1): logo + company, event + dates, Terminal ID, last sync,
 * previous login; cashier tiles (max 8 + Type ID); the PIN card; wrong PIN
 * shakes and clears, five wrong lock for 30 s; verified offline against the
 * bundle's PIN hashes. Footer: Keyboard, Exit, Prepared on. Gear: Device
 * setup after a supervisor PIN. "Update available" shows only here. */
import { useEffect, useMemo, useState } from "react";
import { PinPad } from "../PinPad";
import { afterWrongPin, findCashierById, fmtDateRange, fmtMyt, freshLock, lockedFor, loginTiles, syncTone, type LockState } from "../loginRules";
import { verifyPin } from "../pin";
import { APP_VERSION, applyUpdate } from "../pwa";
import { SyncPanel } from "../sell/SyncPanel";
import type { BundleCashier, DeviceState } from "../types";

export function Login({ state, online, updateWaiting, onLogin, onOpenSetup, onStateChanged }: {
  state: DeviceState;
  online: boolean | null;
  updateWaiting: boolean;
  onLogin: (c: BundleCashier) => void;
  onOpenSetup: () => void;
  onStateChanged: (s: DeviceState) => void;
}) {
  const [syncOpen, setSyncOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const b = state.bundle;
  const { tiles, overflow } = useMemo(() => loginTiles(b.cashiers), [b.cashiers]);
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
        const supers = b.cashiers.filter((c) => c.role === "SUPERVISOR");
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

  const pickTyped = () => {
    const c = findCashierById([...tiles, ...overflow], typed);
    if (!c) { setError("No cashier with that ID"); return; }
    setSelected(c);
    setError(null);
    setTyping(false);
  };

  const tone = syncTone(state.last_sync_at, now);
  const supervisorsExist = b.cashiers.some((c) => c.role === "SUPERVISOR");

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand"><img src="/logo-hc-mark.png" alt="" /> {b.company.name}</div>
        <div className="grow" />
        <div className="meta">
          <div><b>{b.event.receipt_header || b.event.name}</b> {fmtDateRange(b.event.start_date, b.event.end_date)}</div>
          <div>Terminal <span className="pill mono">{b.terminal.code}</span></div>
        </div>
        <div className="meta">
          <button type="button" className={`btn link sync ${tone}`} style={{ padding: 0, minHeight: 0, fontSize: 12 }} onClick={() => setSyncOpen(true)} title="Sync panel">Last sync {state.last_sync_at ? fmtMyt(state.last_sync_at) : `-- (prepared ${fmtMyt(state.prepared_at)})`}</button>
          <div>{state.last_login ? `Previous login ${state.last_login.cashier} · ${fmtMyt(state.last_login.at)}` : "No login yet"}</div>
        </div>
        <button type="button" className="btn link" style={{ color: "#fff", fontSize: 20 }} title="Device setup (supervisor PIN)" onClick={() => { if (!supervisorsExist) onOpenSetup(); else { setGear(true); setSelected(null); setError(null); } }}>&#9881;</button>
      </header>
      {state.test_mode && <div className="banner test">TEST MODE is ON: bills print *** TEST ***, are numbered T-, never sync and never deduct stock. Turn it off in Device setup before real sales.</div>}
      {updateWaiting && !updateLater && (
        <div className="banner update"><span className="grow">Update available for Houzs POS.</span><button type="button" className="btn primary" onClick={applyUpdate}>Restart now</button><button type="button" className="btn" onClick={() => setUpdateLater(true)}>Later</button></div>
      )}
      {state.demo && <div className="banner update">Demo: sample catalog, PIN 1234 for every cashier, nothing reaches the ERP. Gear, then Prepare device, links a real terminal.</div>}
      {online === false && !state.demo && <div className="banner offline">Offline. Login and selling work; sales will sync when the connection returns.</div>}

      <div className="screen">
        <div className="login">
          <div>
            <div className="tiles">
              {tiles.map((c) => (
                <button key={c.id} type="button" className={`tile${selected?.id === c.id && !gear ? " selected" : ""}`} onClick={() => { setSelected(c); setGear(false); setError(null); setTyping(false); }}>
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
            {b.cashiers.length === 0 && <div className="card" style={{ marginTop: 12 }}>No cashier is assigned to this event. Assign cashiers in the ERP (POS Admin › Events), then Refresh catalog in Device setup.</div>}
          </div>
          <PinPad
            title={gear ? "Supervisor PIN for Device setup" : selected ? `${selected.name} · enter PIN` : "Tap your name, then your PIN"}
            onSubmit={(pin) => void submit(pin)}
            disabled={checking || (!gear && !selected)}
            error={error}
            lockedSeconds={lockedSeconds}
            shakeKey={shakeKey}
            allowKeyboard={!typing}
          />
        </div>
      </div>

      {syncOpen && <SyncPanel state={state} onStateChanged={onStateChanged} onClose={() => setSyncOpen(false)} say={(t) => { setNote(t); setTimeout(() => setNote(null), 2500); }} />}
      {note && <div className="toast">{note}</div>}
      <footer className="footer">
        <button type="button" className="btn link" onClick={() => { setTyping((v) => !v); setGear(false); }}>Keyboard</button>
        <button type="button" className="btn link" onClick={() => window.location.reload()}>Exit</button>
        <span className="grow" />
        <span>Prepared on {fmtMyt(state.prepared_at)} · {b.items.length} items · v{APP_VERSION}</span>
      </footer>
    </div>
  );
}
