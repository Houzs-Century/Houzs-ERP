/* The sell screen's frame (layout P2) with the idle auto-logout and the
 * test-mode banner; the scan bar, cart grid and payment arrive with the next
 * build steps. */
import { useEffect } from "react";
import { fmtMyt } from "../loginRules";
import type { DeviceState, Session } from "../types";

export function Sell({ state, session, online, onLogout }: { state: DeviceState; session: Session; online: boolean | null; onLogout: () => void }) {
  const b = state.bundle;
  const idleMinutes = b.settings.general.idle_logout_minutes;
  useEffect(() => {
    let timer = setTimeout(onLogout, idleMinutes * 60_000);
    const bump = () => { clearTimeout(timer); timer = setTimeout(onLogout, idleMinutes * 60_000); };
    for (const ev of ["pointerdown", "keydown", "touchstart"]) window.addEventListener(ev, bump);
    return () => { clearTimeout(timer); for (const ev of ["pointerdown", "keydown", "touchstart"]) window.removeEventListener(ev, bump); };
  }, [idleMinutes, onLogout]);
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">{b.company.name}</div>
        <span className="pill">{b.event.receipt_header || b.event.name}</span>
        <span className="pill">{online === false ? "Offline · 0 pending" : online ? "Online · synced" : "…"}</span>
        <div className="grow" />
        <div className="meta">Last sync {state.last_sync_at ? fmtMyt(state.last_sync_at) : "--"}</div>
      </header>
      {state.test_mode && <div className="banner test">TEST MODE: every sale is a TEST sale.</div>}
      <div className="screen">
        <div className="card sell-placeholder">
          <h2 style={{ fontSize: 16 }}>Logged in: {session.cashier.name} ({session.cashier.role === "SUPERVISOR" ? "Supervisor" : "Cashier"})</h2>
          <p className="muted">Sell screen, scanner, cart, discounts and payment arrive with build steps 4 and 5. Catalog loaded: {b.items.length} items.</p>
          <button type="button" className="btn" onClick={onLogout}>Logout (F12)</button>
        </div>
      </div>
      <footer className="footer">
        <span>Cashier {session.cashier.name}</span><span>Terminal {b.terminal.code}</span><span>{b.event.name}</span><span>Printer: not paired</span>
        <span className="grow" />
        <span>Idle logout after {idleMinutes} min</span>
      </footer>
    </div>
  );
}
