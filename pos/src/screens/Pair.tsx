/* The first screen of a device that is not paired yet: type the one-time
 * code POS Admin > Terminals > Pair device shows (or open its link, which
 * fills the code), and the login screen appears. No ERP sign-in on the
 * device. */
import { useEffect, useState } from "react";
import { formatPairingCode, isPairingCode, normalizePairingCode, pairingCodeFromUrl } from "@shared/pos-pairing";
import { deviceApi, erpReachable } from "../api";
import { requestPersistentStorage } from "../db";
import { platformName, saveDeviceState, stateFromBundle } from "../deviceStore";
import { APP_VERSION } from "../pwa";
import type { DeviceState, PosBundle } from "../types";

export function Pair({ prev, onPaired }: { prev: DeviceState | null; onPaired: (s: DeviceState) => void }) {
  const [code, setCode] = useState("");
  const [deviceName, setDeviceName] = useState(prev?.device_name ?? "");
  const [busy, setBusy] = useState<"pair" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [online, setOnline] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    erpReachable().then((ok) => { if (alive) setOnline(ok); });
    const fromLink = pairingCodeFromUrl(window.location.href);
    if (fromLink) {
      setCode(formatPairingCode(fromLink));
      window.history.replaceState(null, "", window.location.pathname);
      void pair(fromLink);
    }
    return () => { alive = false; };
    // runs once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function pair(raw = code) {
    if (!isPairingCode(raw)) { setError("The code has 8 letters and digits, like H7K2-9QPD."); return; }
    setBusy("pair");
    setError(null);
    try {
      const persisted = await requestPersistentStorage();
      const r = await deviceApi.pair<{ token: string; bundle: PosBundle }>(normalizePairingCode(raw), deviceName.trim() || null, platformName());
      const next = stateFromBundle(r.token, r.bundle, prev, deviceName.trim() || r.bundle.terminal.device_name || "");
      await saveDeviceState(next);
      if (!persisted) console.warn("[pos] persistent storage not granted");
      onPaired(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Pairing failed");
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="screen setup">
      <h1>Houzs POS <span className="muted small">{APP_VERSION}</span></h1>
      <div className="card">
        <h2>Pair this device</h2>
        <p className="muted" style={{ marginTop: 0 }}>In the ERP open POS Admin, Terminals, and press <b>Pair device</b> on the terminal this device will be. Type the code it shows, or open its link on this device.</p>
        <form onSubmit={(e) => { e.preventDefault(); void pair(); }}>
          <label className="field"><span>Pairing code</span>
            <input value={code} onChange={(e) => setCode(formatPairingCode(e.target.value))} placeholder="H7K2-9QPD" autoComplete="off" autoCapitalize="characters" spellCheck={false} inputMode="text" style={{ fontSize: 26, letterSpacing: "0.12em", fontFamily: "ui-monospace, monospace", textAlign: "center" }} maxLength={9} />
          </label>
          <label className="field"><span>Device name</span><input value={deviceName} onChange={(e) => setDeviceName(e.target.value)} placeholder="e.g. Tab A9 #1" /></label>
          <div className="row">
            <button type="submit" className="btn primary" disabled={busy !== null || !isPairingCode(code) || online === false}>{busy === "pair" ? "Pairing…" : "Pair"}</button>
            {online === false && <span className="muted small">The ERP is not reachable; pairing needs internet.</span>}
          </div>
        </form>
        {error && <div className="banner offline" style={{ marginTop: 10 }}>{error}</div>}
      </div>
      <p className="muted small">Recommended: Android tablet or Windows laptop with Chrome, installed as an app. iPad only if added to the Home Screen.</p>
    </div>
  );
}
