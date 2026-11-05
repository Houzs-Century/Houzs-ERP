/* Punch In / Out (HC-0125 phase 2), the phone half of Employees & Attendance,
 * from Hookka's worker clock card. Drivers and warehouse crew punch with their
 * own ERP account (Nico: option B): selfie first, then GPS, then the punch.
 * Neither the selfie nor the location blocks a punch on the server; this
 * screen asks for the selfie because HR checks it, as Hookka's app did. */
import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { prepareImageForUpload } from "../lib/imagePipeline";
import { formatDate } from "../lib/utils";
import { distanceLabel } from "../vendor/shared/hr-attendance";
import { minToHhmm } from "../vendor/shared/hr-pay-rules";
import { MyPayBody } from "./MobileMyPay";
import "./mobile.css";

type Side = { clock: string; geo: "IN" | "OUT" | "NONE" | null; siteName: string | null; distanceM: number | null; source: string | null } | null;
type Day = { id: number; workDate: string; status: string; in: Side; out: Side; open: boolean; lateMin: number; otMin: number; spanMin: number | null; notes: string | null };
type Me =
  | { linked: false }
  | {
      linked: true;
      employee: { empNo: string; name: string };
      today: string;
      shift: { startMin: number; endMin: number };
      open: Day | null;
      todayDay: Day | null;
      recent: Day[];
      sitesConfigured: number;
    };
type PunchResult = { ok: true; action: "CLOCK_IN" | "CLOCK_OUT"; already: boolean; location: { geo: "IN" | "OUT" | "NONE"; siteName: string | null; distanceM: number | null }; photoSaved: boolean };

const hm = (min: number) => `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, "0")}m`;

function where(side: Side): string {
  if (!side) return "";
  if (side.source === "MANUAL") return "keyed by HR";
  if (side.source === "AUTO") return "closed automatically";
  if (side.geo === "IN") return `at ${side.siteName ?? "site"}`;
  if (side.geo === "OUT" && side.distanceM != null) return `${distanceLabel(side.distanceM)} from ${side.siteName ?? "site"}`;
  return "no location";
}

function getLocation(): Promise<{ lat: number; lng: number; accuracy: number } | null> {
  return new Promise((resolve) => {
    if (!("geolocation" in navigator)) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 30_000 },
    );
  });
}

export function MobilePunch({ onBack }: { onBack: () => void }) {
  const meQ = useQuery<Me>({ queryKey: ["attendance", "me"], queryFn: () => api.get<Me>("/api/attendance/me"), refetchInterval: 60_000 });
  const fileRef = useRef<HTMLInputElement>(null);
  const actionRef = useRef<"CLOCK_IN" | "CLOCK_OUT">("CLOCK_IN");
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ tone: "ok" | "warn" | "err"; text: string } | null>(null);
  const [view, setView] = useState<"punch" | "pay">("punch");

  const me = meQ.data;
  const open = me?.linked ? me.open : null;
  const todayDay = me?.linked ? me.todayDay : null;
  const doneToday = !open && !!todayDay?.out;
  const action: "CLOCK_IN" | "CLOCK_OUT" = open ? "CLOCK_OUT" : "CLOCK_IN";

  const startPunch = () => {
    setResult(null);
    actionRef.current = action;
    fileRef.current?.click();
  };

  const onPhoto = async (file: File | null) => {
    if (fileRef.current) fileRef.current.value = "";
    if (!file) return;
    const act = actionRef.current;
    try {
      setBusy("Preparing photo...");
      const { file: small } = await prepareImageForUpload(file, { maxDimension: 640, quality: 0.6 });
      setBusy("Getting your location...");
      const loc = await getLocation();
      setBusy(act === "CLOCK_IN" ? "Clocking in..." : "Clocking out...");
      const form = new FormData();
      form.append("action", act);
      form.append("photo", small);
      if (loc) {
        form.append("lat", String(loc.lat));
        form.append("lng", String(loc.lng));
        form.append("accuracy", String(Math.round(loc.accuracy)));
      }
      const r = await api.postForm<PunchResult>("/api/attendance/punch", form);
      const verb = act === "CLOCK_IN" ? "Clocked in" : "Clocked out";
      const place = r.location.geo === "IN" ? ` at ${r.location.siteName ?? "site"}` : "";
      if (r.already) setResult({ tone: "ok", text: "You are already clocked in." });
      else if (r.location.geo === "OUT" && r.location.distanceM != null) {
        setResult({ tone: "warn", text: `${verb}. You are ${distanceLabel(r.location.distanceM)} from ${r.location.siteName ?? "the site"}; HR will see this.` });
      } else if (!loc) setResult({ tone: "warn", text: `${verb}, but without your location. Turn on location for this browser next time.` });
      else setResult({ tone: "ok", text: `${verb}${place}.` });
      void meQ.refetch();
    } catch (e) {
      setResult({ tone: "err", text: e instanceof Error && e.message ? e.message : "Punch NOT recorded: network problem. Please tap again." });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      <header className="hdr">
        <div className="hdr-row">
          <button className="back" onClick={onBack}>
            <span className="chev">‹</span> Back
          </button>
        </div>
        <div className="scr-title">{view === "pay" ? "My pay" : "Punch In / Out"}</div>
        <div style={{ display: "flex", gap: 6, padding: "0 16px 10px" }}>
          {(["punch", "pay"] as const).map((v) => (
            <button
              key={v}
              type="button"
              className={view === v ? "btn" : "btn-ghost"}
              style={{ flex: 1, minHeight: 34, fontSize: 13 }}
              onClick={() => setView(v)}
            >
              {v === "punch" ? "Punch" : "My pay"}
            </button>
          ))}
        </div>
      </header>
      <div className="scroll hz-scroll" style={{ padding: "14px 16px" }}>
        {view === "pay" ? <MyPayBody /> : <>
        {meQ.isLoading && <div style={{ color: "var(--mut)", fontSize: 13 }}>Loading...</div>}
        {meQ.isError && <div className="card" style={{ padding: 14, color: "var(--red)", fontSize: 13 }}>Could not load your attendance. Pull down or reopen to retry.</div>}
        {me && !me.linked && (
          <div className="card" style={{ padding: 16, fontSize: 13, color: "var(--ink)" }}>
            Your account is not linked to an employee yet, so you cannot punch in. Ask HR to link it in Employees &amp; Attendance.
          </div>
        )}
        {me?.linked && (
          <>
            <div className="card" style={{ padding: 16 }}>
              <div style={{ fontSize: 12, color: "var(--mut)" }}>
                {me.employee.empNo} · {me.employee.name}
              </div>
              <div style={{ fontSize: 13, color: "var(--mut)", marginTop: 2 }}>
                {formatDate(me.today)} · shift {minToHhmm(me.shift.startMin)} to {minToHhmm(me.shift.endMin)}
              </div>
              <div style={{ marginTop: 12, fontSize: 15, fontWeight: 700, color: "var(--ink)" }}>
                {open
                  ? `Clocked in at ${open.in?.clock ?? ""}${open.workDate !== me.today ? ` on ${formatDate(open.workDate)}` : ""}`
                  : doneToday
                    ? `Done for today: ${todayDay.in?.clock ?? "--"} to ${todayDay.out?.clock ?? "--"}`
                    : "Not clocked in"}
              </div>
              {open?.in && <div style={{ fontSize: 12, color: "var(--mut)" }}>{where(open.in)}</div>}
              {open && open.spanMin != null && <div style={{ fontSize: 12.5, color: "var(--ink)", marginTop: 6 }}>On the clock {hm(open.spanMin)}</div>}
              {open && open.lateMin > 0 && <div style={{ fontSize: 12, color: "var(--red)", marginTop: 2 }}>Late {open.lateMin} min</div>}
            </div>

            {result && (
              <div
                className="card"
                style={{ padding: 12, marginTop: 10, fontSize: 13, color: result.tone === "err" ? "var(--red)" : result.tone === "warn" ? "var(--warn, #9a6b00)" : "var(--green)" }}
              >
                {result.text}
              </div>
            )}

            {me.sitesConfigured === 0 && (
              <div style={{ fontSize: 11.5, color: "var(--mut)", marginTop: 10 }}>No punch location is set up yet, so your location is recorded but not checked.</div>
            )}

            <div style={{ marginTop: 18, fontSize: 11, fontWeight: 700, letterSpacing: 0.6, color: "var(--mut)", textTransform: "uppercase" }}>Last 14 days</div>
            {me.recent.length === 0 && <div style={{ fontSize: 12.5, color: "var(--mut)", marginTop: 6 }}>No punches yet.</div>}
            {me.recent.map((d) => (
              <div key={d.id} className="card" style={{ padding: "10px 12px", marginTop: 8, fontSize: 12.5 }}>
                <div style={{ display: "flex", justifyContent: "space-between", color: "var(--ink)", fontWeight: 600 }}>
                  <span>{formatDate(d.workDate)}</span>
                  <span>{d.in ? `${d.in.clock} to ${d.out?.clock ?? "..."}` : d.status.replace(/_/g, " ").toLowerCase()}</span>
                </div>
                <div style={{ color: "var(--mut)", marginTop: 2 }}>
                  {[d.lateMin > 0 ? `late ${d.lateMin} min` : null, d.otMin > 0 ? `OT ${hm(d.otMin)}` : null, d.out?.source === "AUTO" ? "forgot to punch out" : null]
                    .filter(Boolean)
                    .join(" · ") || where(d.in)}
                </div>
              </div>
            ))}
          </>
        )}
        </>}
      </div>
      {me?.linked && view === "punch" && (
        <footer className="actbar">
          <input ref={fileRef} type="file" accept="image/*" capture="user" style={{ display: "none" }} onChange={(e) => void onPhoto(e.target.files?.[0] ?? null)} />
          <button type="button" className="btn" disabled={!!busy || doneToday} onClick={startPunch} style={{ minHeight: 56, fontSize: 16 }}>
            {busy ?? (doneToday ? "Done for today" : action === "CLOCK_IN" ? "Clock in (take a selfie)" : "Clock out (take a selfie)")}
          </button>
        </footer>
      )}
    </div>
  );
}
