import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { uploadSlipFull, ALLOWED_SLIP_MIMES } from "../vendor/scm/lib/slip";
import "./mobile.css";

/* Mileage capture — the mobile DRIVER action for Fleet Maintenance Phase 2.
   The driver marks the day "fully complete" after the last drop and enters the
   odometer + a dashboard photo. ONE reading per lorry per day (DAY_COMPLETE).

   Wired to the REAL top-level fleet routes (backend/src/scm/routes/
   fleet-maintenance.ts):
     • GET  /api/fleet-maintenance/dashboard        → the lorry list + current km
     • POST /api/fleet-maintenance/vehicles/:id/mileage  { odometerKm, photoRef,
       source: "DAY_COMPLETE" } → inserts the reading. The server runs the pure
       guards: a reading BELOW the latest is a 409 rollback (rejected); an
       abnormal one-day jump is accepted but flagged for review.

   The photo is uploaded to R2 first (shared slip Worker-proxy pipeline →
   { r2Key }); its key rides the POST as photoRef. GPS distance is NOT captured
   as the odometer — the odometer is always the number the driver reads off the
   dash. The desktop /fleet-health page is the admin surface (plans + board);
   this screen is the one thing a driver does on a phone. */

type Vehicle = {
  id: string;
  plate: string;
  region: string | null;
  driverName: string | null;
  mileageKm: number | null;
  mileageDate: string | null;
};
type DashboardPayload = { today: string; vehicles: Vehicle[] };

function todayMyt(): string {
  return new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
}

export function MobileMileageCapture({ onBack }: { onBack: () => void }) {
  const dashQ = useQuery<DashboardPayload>({
    queryKey: ["fleet-mileage-dashboard"],
    queryFn: () => api.get<DashboardPayload>("/api/fleet-maintenance/dashboard"),
  });

  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<"mileage" | "breakdown">("mileage");
  const [odometer, setOdometer] = useState("");
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [done, setDone] = useState<{ plate: string; km: number; flagged: boolean } | null>(null);
  // Breakdown-report state.
  const [bdFault, setBdFault] = useState("");
  const [bdSeverity, setBdSeverity] = useState<"MINOR" | "MAJOR" | "CRITICAL">("MAJOR");
  const [bdDrivable, setBdDrivable] = useState(false);
  const [bdDesc, setBdDesc] = useState("");
  const [bdDone, setBdDone] = useState<{ plate: string; grounded: boolean; trips: number } | null>(null);

  const vehicles = dashQ.data?.vehicles ?? [];
  const filtered = useMemo(() => {
    const q = query.replace(/\s+/g, "").toUpperCase();
    if (!q) return vehicles;
    return vehicles.filter((v) => v.plate.replace(/\s+/g, "").toUpperCase().includes(q) || (v.driverName ?? "").toUpperCase().includes(query.toUpperCase()));
  }, [vehicles, query]);
  const selected = vehicles.find((v) => v.id === selectedId) ?? null;

  const odoNum = odometer.trim() === "" ? null : Number(odometer.replace(/[, ]/g, ""));
  const odoValid = odoNum !== null && Number.isFinite(odoNum) && Number.isInteger(odoNum) && odoNum >= 0;
  // Soft client-side rollback hint (the server is the real guard).
  const wouldRollback = odoValid && selected?.mileageKm != null && odoNum! < selected.mileageKm;

  const submit = async () => {
    if (busy || !selected || !odoValid || wouldRollback) return;
    setActionError(null);
    setBusy(true);
    try {
      let photoRef: string | null = null;
      if (photoFile) {
        const { r2Key } = await uploadSlipFull({ file: photoFile });
        photoRef = r2Key;
      }
      const res = await api.post<{ id: string; verdict: string; flagged: boolean }>(
        `/api/fleet-maintenance/vehicles/${encodeURIComponent(selected.id)}/mileage`,
        { odometerKm: odoNum, readingDate: todayMyt(), source: "DAY_COMPLETE", photoRef, note: note.trim() || undefined },
      );
      setDone({ plate: selected.plate, km: odoNum!, flagged: !!res.flagged });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      if (/already_captured_today/.test(msg)) setActionError("Today's reading was already captured for this lorry.");
      else if (/odometer_rollback/.test(msg)) setActionError("That reading is below the last one on file. Check the odometer and try again.");
      else setActionError("Could not save the reading. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  // Best-effort GPS: resolves to {lat,lng} or null (never blocks the report).
  const getGps = () =>
    new Promise<{ lat: number; lng: number } | null>((resolve) => {
      if (!("geolocation" in navigator)) return resolve(null);
      const to = setTimeout(() => resolve(null), 4000);
      navigator.geolocation.getCurrentPosition(
        (pos) => { clearTimeout(to); resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }); },
        () => { clearTimeout(to); resolve(null); },
        { enableHighAccuracy: true, timeout: 4000 },
      );
    });

  const submitBreakdown = async () => {
    if (busy || !selected) return;
    setActionError(null);
    setBusy(true);
    try {
      let photoRef: string | null = null;
      if (photoFile) {
        const { r2Key } = await uploadSlipFull({ file: photoFile });
        photoRef = r2Key;
      }
      const gps = await getGps();
      const res = await api.post<{ grounding: boolean; affectedTrips: unknown[] }>(
        `/api/fleet-maintenance/vehicles/${encodeURIComponent(selected.id)}/breakdowns`,
        {
          faultType: bdFault.trim() || undefined,
          severity: bdSeverity,
          stillDrivable: bdDrivable,
          driverDescription: bdDesc.trim() || undefined,
          breakdownStart: new Date().toISOString(),
          gpsLat: gps?.lat,
          gpsLng: gps?.lng,
          mediaRefs: photoRef ? [photoRef] : undefined,
        },
      );
      setBdDone({ plate: selected.plate, grounded: !!res.grounding, trips: res.affectedTrips?.length ?? 0 });
    } catch {
      setActionError("Could not report the breakdown. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  if (bdDone) {
    return (
      <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
        <header className="hdr">
          <div className="hdr-row">
            <button className="back" onClick={onBack}><span className="chev">‹</span> Fleet</button>
          </div>
          <div className="scr-title">Breakdown reported</div>
        </header>
        <div className="scroll hz-scroll" style={{ padding: "20px 16px" }}>
          <div className="card" style={{ padding: 18, textAlign: "center" }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: "var(--ink)", marginBottom: 6 }}>Reported</div>
            <div style={{ fontSize: 12.5, color: "var(--mut)" }}>{bdDone.plate}</div>
            {bdDone.grounded && (
              <div style={{ marginTop: 10, fontSize: 11.5, color: "var(--red)" }}>
                Marked critical — the lorry is grounded and the office has been notified.
                {bdDone.trips > 0 ? ` ${bdDone.trips} trip(s) affected.` : ""}
              </div>
            )}
          </div>
        </div>
        <footer className="actbar">
          <button type="button" className="btn" onClick={() => { setBdDone(null); setSelectedId(null); setBdFault(""); setBdDesc(""); setBdSeverity("MAJOR"); setBdDrivable(false); setPhotoFile(null); setMode("mileage"); dashQ.refetch(); }}>
            Done
          </button>
        </footer>
      </div>
    );
  }

  if (done) {
    return (
      <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
        <header className="hdr">
          <div className="hdr-row">
            <button className="back" onClick={onBack}><span className="chev">‹</span> Fleet</button>
          </div>
          <div className="scr-title">Day complete</div>
        </header>
        <div className="scroll hz-scroll" style={{ padding: "20px 16px" }}>
          <div className="card" style={{ padding: 18, textAlign: "center" }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: "var(--ink)", marginBottom: 6 }}>Reading saved</div>
            <div style={{ fontSize: 12.5, color: "var(--mut)" }}>
              {done.plate} · {done.km.toLocaleString()} km
            </div>
            {done.flagged && (
              <div style={{ marginTop: 10, fontSize: 11.5, color: "var(--warn, #9a6b00)" }}>
                This is a large jump from the last reading — it has been flagged for the office to review.
              </div>
            )}
          </div>
        </div>
        <footer className="actbar">
          <button type="button" className="btn" onClick={() => { setDone(null); setSelectedId(null); setOdometer(""); setPhotoFile(null); setNote(""); dashQ.refetch(); }}>
            Capture another
          </button>
        </footer>
      </div>
    );
  }

  return (
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      <header className="hdr">
        <div className="hdr-row">
          <button className="back" onClick={onBack}><span className="chev">‹</span> Fleet</button>
        </div>
        <div className="scr-title">Mileage · Day complete</div>
        <div style={{ fontSize: 11.5, color: "var(--mut)", marginTop: 2 }}>
          Enter the odometer after your last drop
        </div>
      </header>

      <div className="scroll hz-scroll" style={{ padding: "14px 16px", paddingBottom: 120 }}>
        {dashQ.isPending && <div style={{ textAlign: "center", color: "var(--mut2)", fontSize: 12, padding: "26px 0" }}>Loading{"…"}</div>}
        {dashQ.error && <div style={{ textAlign: "center", color: "var(--red)", fontSize: 12, padding: "26px 0" }}>Couldn{"'"}t load the fleet. Please try again.</div>}

        {!dashQ.isPending && !dashQ.error && !selected && (
          <>
            <div className="fld-l" style={{ marginBottom: 8 }}>Pick your lorry</div>
            <input
              className="fld"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search plate or driver"
              style={{ marginBottom: 10 }}
            />
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {filtered.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => { setSelectedId(v.id); setOdometer(""); }}
                  className="card"
                  style={{ textAlign: "left", padding: "11px 13px", cursor: "pointer", border: "1px solid var(--line-card)" }}
                >
                  <div style={{ fontSize: 13.5, fontWeight: 700, color: "var(--ink)" }}>{v.plate}</div>
                  <div style={{ fontSize: 11, color: "var(--mut)" }}>
                    {[v.driverName, v.region].filter(Boolean).join(" · ") || "—"}
                    {v.mileageKm != null ? ` · last ${v.mileageKm.toLocaleString()} km` : ""}
                  </div>
                </button>
              ))}
              {filtered.length === 0 && <div style={{ fontSize: 11.5, color: "var(--mut2)", padding: "9px 2px" }}>No lorries match.</div>}
            </div>
          </>
        )}

        {selected && (
          <>
            <button type="button" onClick={() => setSelectedId(null)} style={{ background: "none", border: "none", color: "var(--brand)", fontSize: 11.5, fontWeight: 700, padding: 0, marginBottom: 10, cursor: "pointer" }}>
              ‹ Change lorry
            </button>
            <div className="card" style={{ padding: "11px 13px", marginBottom: 14 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: "var(--ink)" }}>{selected.plate}</div>
              <div style={{ fontSize: 11, color: "var(--mut)" }}>
                {[selected.driverName, selected.region].filter(Boolean).join(" · ") || "—"}
                {selected.mileageKm != null ? ` · last ${selected.mileageKm.toLocaleString()} km${selected.mileageDate ? ` (${selected.mileageDate})` : ""}` : " · no reading yet"}
              </div>
            </div>

            {/* Action mode: mark day complete (mileage) OR report a breakdown. */}
            <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
              {(["mileage", "breakdown"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => { setMode(m); setActionError(null); }}
                  style={{
                    flex: 1, padding: "9px 0", borderRadius: 11, fontFamily: "inherit", fontSize: 12, fontWeight: 700, cursor: "pointer",
                    border: mode === m ? "1.5px solid var(--brand)" : "1px solid var(--line-card)",
                    background: mode === m ? "var(--brand-soft, rgba(60,110,70,0.1))" : "transparent",
                    color: mode === m ? "var(--brand)" : "var(--mut)",
                  }}
                >
                  {m === "mileage" ? "Day complete" : "Report breakdown"}
                </button>
              ))}
            </div>

            {mode === "mileage" && (
              <>
            <div className="fld-l" style={{ marginBottom: 8 }}>Odometer reading (km)</div>
            <input
              className="fld"
              value={odometer}
              onChange={(e) => setOdometer(e.target.value)}
              inputMode="numeric"
              placeholder="e.g. 182450"
              style={{ fontSize: 18, fontWeight: 700 }}
            />
            {odometer.trim() !== "" && !odoValid && <div style={{ fontSize: 10.5, color: "var(--red)", marginTop: 6 }}>Enter a whole number of kilometres.</div>}
            {wouldRollback && <div style={{ fontSize: 10.5, color: "var(--red)", marginTop: 6 }}>Lower than the last reading ({selected.mileageKm?.toLocaleString()} km). The odometer cannot go backwards.</div>}
              </>
            )}

            {mode === "breakdown" && (
              <>
                <div className="fld-l" style={{ marginBottom: 8 }}>What broke?</div>
                <input className="fld" value={bdFault} onChange={(e) => setBdFault(e.target.value)} placeholder="e.g. Tyre burst, engine overheat" />
                <div className="fld-l" style={{ margin: "16px 0 8px" }}>Severity</div>
                <div style={{ display: "flex", gap: 8 }}>
                  {(["MINOR", "MAJOR", "CRITICAL"] as const).map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setBdSeverity(s)}
                      style={{
                        flex: 1, padding: "8px 0", borderRadius: 10, fontFamily: "inherit", fontSize: 11, fontWeight: 700, cursor: "pointer",
                        border: bdSeverity === s ? "1.5px solid var(--red)" : "1px solid var(--line-card)",
                        background: bdSeverity === s && s === "CRITICAL" ? "rgba(200,50,50,0.1)" : "transparent",
                        color: bdSeverity === s ? "var(--red)" : "var(--mut)",
                      }}
                    >
                      {s === "MINOR" ? "Minor" : s === "MAJOR" ? "Major" : "Critical"}
                    </button>
                  ))}
                </div>
                {bdSeverity === "CRITICAL" && (
                  <div style={{ fontSize: 10.5, color: "var(--red)", marginTop: 6 }}>A critical breakdown grounds the lorry and alerts the office.</div>
                )}
                <label style={{ display: "flex", alignItems: "center", gap: 8, margin: "14px 0 0", fontSize: 12, color: "var(--ink)" }}>
                  <input type="checkbox" checked={bdDrivable} onChange={(e) => setBdDrivable(e.target.checked)} />
                  The lorry can still be driven
                </label>
                <div className="fld-l" style={{ margin: "16px 0 8px" }}>Description</div>
                <input className="fld" value={bdDesc} onChange={(e) => setBdDesc(e.target.value)} placeholder="What happened" />
              </>
            )}

            {/* Photo — dashboard odometer (mileage) or the scene (breakdown). */}
            <div className="fld-l" style={{ margin: "18px 0 8px" }}>{mode === "breakdown" ? "Photo of the scene (optional)" : "Dashboard photo (optional)"}</div>
            <div style={{ display: "flex", gap: 9 }}>
              <label style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 6, background: "var(--brand)", border: "none", borderRadius: 13, padding: 14, color: "#fff", fontFamily: "inherit", fontSize: 11.5, fontWeight: 700, cursor: "pointer" }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z" />
                  <circle cx="12" cy="13" r="3" />
                </svg>
                {photoFile ? "Retake photo" : "Take photo"}
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  capture="environment"
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const f = e.target.files?.[0] ?? null;
                    if (!f) return;
                    if (!ALLOWED_SLIP_MIMES.includes(f.type as (typeof ALLOWED_SLIP_MIMES)[number])) {
                      setPhotoFile(null);
                      setPhotoError("Please use a JPEG, PNG or WebP photo.");
                      return;
                    }
                    setPhotoError(null);
                    setPhotoFile(f);
                  }}
                />
              </label>
              <div style={{ flex: 1, borderRadius: 13, minHeight: 70, background: photoFile ? "linear-gradient(135deg,#d7ded6,#c7d0c4)" : "linear-gradient(135deg,#eceee9,#e3e6e0)" }} />
            </div>
            {photoFile && <div style={{ fontSize: 10.5, color: "var(--mut)", marginTop: 6 }} className="tnum">{photoFile.name}</div>}
            {photoError && <div style={{ fontSize: 10.5, color: "var(--red)", marginTop: 6 }}>{photoError}</div>}

            {mode === "mileage" && (
              <>
                <div className="fld-l" style={{ margin: "18px 0 8px" }}>Note (optional)</div>
                <input className="fld" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Anything to flag" />
              </>
            )}

            {actionError && <div style={{ marginTop: 14, fontSize: 11.5, color: "var(--red)", textAlign: "center" }}>{actionError}</div>}
          </>
        )}
      </div>

      <footer className="actbar">
        {selected ? (
          mode === "mileage" ? (
            <button type="button" className="btn" disabled={busy || !odoValid || wouldRollback} onClick={submit} style={{ opacity: busy || !odoValid || wouldRollback ? 0.55 : 1, cursor: busy || !odoValid || wouldRollback ? "default" : "pointer" }}>
              {busy ? "Saving…" : "Mark day complete →"}
            </button>
          ) : (
            <button type="button" className="btn" disabled={busy} onClick={submitBreakdown} style={{ opacity: busy ? 0.55 : 1, cursor: busy ? "default" : "pointer" }}>
              {busy ? "Reporting…" : "Report breakdown →"}
            </button>
          )
        ) : (
          <button type="button" className="btn-ghost" onClick={onBack}>Back</button>
        )}
      </footer>
    </div>
  );
}
