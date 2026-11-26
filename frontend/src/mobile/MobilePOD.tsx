import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { orderLineIdentity } from "@2990s/shared";
import { invalidateDoShared, invalidateInventoryShared, invalidateSoShared } from "./sharedInvalidate";
import {
  useMfgDeliveryOrderDetail,
  useMfgDeliveryOrdersPaged,
  useUpdateMfgDeliveryOrderStatus,
} from "../vendor/scm/lib/delivery-order-queries";
import { fieldPhotoContext, uploadFieldPhoto } from "../vendor/scm/lib/slip";
import { serverFieldPhotoRestore, useFieldPhotos } from "../lib/fieldPhotos";
import { CREW_STOP_POLL_MS } from "../vendor/scm/lib/crew-stop-photos";
import { FieldPhotos } from "../components/FieldPhotos";
import { useConfirm } from "../vendor/scm/components/ConfirmDialog";
import { useAuth } from "../auth/AuthContext";
import { canOperateDeliveryOrders, canDriverCompleteDelivery } from "../auth/salesAccess";
import { authedFetch } from "../vendor/scm/lib/authed-fetch";
import {
  deliveryIssueDraftError, invalidateDeliveryIssues, reportDoDeliveryIssue, useDoDeliveryIssues, useRunDeliveryIssues,
  type DeliveryIssueDraft,
} from "../vendor/scm/lib/delivery-issue-queries";
import { DeliveryIssueForm, MobileDeliveryIssues, EMPTY_ISSUE_DRAFT } from "./DeliveryIssueForm";
import "./mobile.css";

/* Proof-of-Delivery (POD) — mobile driver screen for confirming a Delivery
   Order as DELIVERED. Wired to the REAL DO backend
   (backend/src/scm/routes/delivery-orders-mfg.ts):

     • The list route  GET  /delivery-orders-mfg?page=0&pageSize=..&q=<docNo>
       resolves the docNo (a DO NUMBER like "DO-2406-0188") to the DO's UUID —
       every detail/status route keys on the UUID (:id), never the number.
     • The detail      GET  /delivery-orders-mfg/:id   → { deliveryOrder, items }
       gives the header (debtor, city/state, status) and the line items to
       tick off.
     • Deliver         PATCH /delivery-orders-mfg/:id/status  body { status:
       "DELIVERED" }  flips the DO delivered (deducts stock + syncs the SO).

   The delivery PHOTOS are uploaded to R2 one by one THE MOMENT THEY ARE TAKEN
   (FieldPhotos -> uploadFieldPhoto, the shared slip Worker-proxy pipeline),
   with no time watermark (owner 2026-11-11); Confirm sends only the uploaded
   keys. The first key is persisted as
   PATCH /:id/status { podKey } → delivery_orders.pod_r2_key. The customer
   SIGNATURE (base64 PNG) is persisted as { signatureData } →
   delivery_orders.signature_data. The delivery LOCATION (lat/lng + accuracy +
   the reading's own timestamp) persists as { podLat, podLng, podAccuracyM,
   podLocatedAt } -> delivery_orders.pod_* (mig 0249). It used to be captured
   here and discarded; it is the answer to "where was this actually delivered". */

type DoHeader = {
  id: string;
  do_number: string | null;
  debtor_name: string | null;
  status: string | null;
  phone: string | null;
  city: string | null;
  state: string | null;
  customer_state: string | null;
};
type DoItem = {
  id: string;
  description: string | null;
  description2: string | null;
  item_code: string | null;
  qty: number | null;
  cancelled?: boolean;
};
const DOC_NO_LOOKUP_ROWS = 20;

const isDelivered = (status: string | null): boolean => {
  const s = (status ?? "").toUpperCase();
  return s === "DELIVERED" || s === "INVOICED" || s === "SIGNED";
};
const isCancelled = (status: string | null): boolean => (status ?? "").toUpperCase() === "CANCELLED";

/** Proof of Delivery — full-height overlay. `docNo` is a Delivery Order NUMBER;
 *  we resolve it to the DO UUID via the list route, then read the detail. */
export function MobilePOD({ docNo, companyCode = null, onBack, onDone }: { docNo: string; companyCode?: string | null; onBack: () => void; onDone?: () => void }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const updateStatus = useUpdateMfgDeliveryOrderStatus();
  const { user, can, pageAccess } = useAuth();
  const canOperate = canOperateDeliveryOrders(user, can, pageAccess);
  const isCrew = !canOperate && canDriverCompleteDelivery(user);
  const canComplete = canOperate || isCrew;
  const crewQ = useQuery({
    queryKey: ["mfg-delivery-order-pod", docNo],
    queryFn: () => authedFetch<{ deliveryOrder: DoHeader; items: DoItem[] }>(`/delivery-planning/do/${encodeURIComponent(docNo)}/pod`),
    enabled: isCrew,
    staleTime: 30_000,
    refetchInterval: (query) => {
      const st = query.state.data?.deliveryOrder.status ?? null;
      return isDelivered(st) || isCancelled(st) ? false : CREW_STOP_POLL_MS;
    },
  });

  const listQ = useMfgDeliveryOrdersPaged({ enabled: !isCrew, page: 0, pageSize: DOC_NO_LOOKUP_ROWS, q: docNo, companyCode });
  const doId = useMemo(() => {
    const rows = listQ.data?.deliveryOrders;
    if (isCrew) return crewQ.data?.deliveryOrder.id ?? null;
    if (!rows) return null;
    return (rows.find((d: DoHeader) => (d.do_number ?? "") === docNo)?.id ?? null) as string | null;
  }, [listQ.data, docNo, isCrew, crewQ.data]);

  const detailQ = useMfgDeliveryOrderDetail(isCrew ? null : doId, companyCode);
  const podData = isCrew ? crewQ.data : detailQ.data;

  const h = podData?.deliveryOrder as DoHeader | undefined;
  const items = ((podData?.items ?? []) as DoItem[]).filter((l) => !l.cancelled);

  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const deliveredCount = items.reduce((n, it) => n + (ticked[it.id] ? 1 : 0), 0);

  const sigRef = useRef<HTMLCanvasElement | null>(null);
  const [hasSignature, setHasSignature] = useState(false);
  const [sigClearNonce, setSigClearNonce] = useState(0);
  const [gps, setGps] = useState<{ lat: number; lng: number; accuracyM: number | null; atIso: string } | null>(null);
  const [gpsState, setGpsState] = useState<"idle" | "asking" | "ok" | "denied">("idle");
  const photoContext = doId ? fieldPhotoContext({ kind: "do", doId }) : null;
  const photos = useFieldPhotos({
    stampLabel: null, // no time watermark on photos (owner 2026-11-11)
    max: 20,
    upload: (file) => uploadFieldPhoto({ file, context: photoContext }),
    restore: photoContext && h && canComplete && !isDelivered(h.status) && !isCancelled(h.status) ? serverFieldPhotoRestore(photoContext) : null,
  });

  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [issueOn, setIssueOn] = useState(false);
  const [issueDraft, setIssueDraft] = useState<DeliveryIssueDraft>(EMPTY_ISSUE_DRAFT);
  const crewIssuesQ = useRunDeliveryIssues({ do: [docNo] }, isCrew, CREW_STOP_POLL_MS);
  const officeIssuesQ = useDoDeliveryIssues(isCrew ? null : doId);
  const reportedIssues = isCrew ? crewIssuesQ.data : officeIssuesQ.data;

  const delivered = h ? isDelivered(h.status) : false;
  const cancelled = h ? isCancelled(h.status) : false;

  const confirmDelivered = async () => {
    if (busy || !doId || !h || !canComplete) return;
    /* Every job closes with a photo (owner, 2026-10-07: 每个 Job 都必须上传 POD).
       The customer signs the paper delivery note for now, so a photo of that
       signed note is the POD; the on-screen signature stays optional. */
    const gate = photos.gate("Take a POD photo first - a photo of the signed delivery note is fine.");
    if (!gate.ok) {
      setActionError(gate.reason);
      return;
    }
    const issueError = issueOn ? deliveryIssueDraftError(issueDraft) : null;
    if (issueError) { setActionError(issueError); return; }
    const notes: string[] = [];
    if (deliveredCount < items.length) {
      notes.push(`Only ${deliveredCount} of ${items.length} items are ticked.`);
    }
    if (!hasSignature) notes.push("No customer signature has been captured.");
    if (issueOn) notes.push("The problem will be reported and a service case opened.");
    if (!(await confirm({
      title: issueOn ? `Mark ${h.do_number ?? docNo} delivered with issue?` : `Mark ${h.do_number ?? docNo} delivered?`,
      body: notes.length ? notes.join(" ") : undefined,
      confirmLabel: "Confirm delivered",
    }))) return;
    setActionError(null);
    setBusy(true);
    try {
      const podKeys = gate.keys;
      const podKey = podKeys[0];
      const sig = hasSignature
        ? (() => { try { return sigRef.current?.toDataURL("image/png") ?? ""; } catch { return ""; } })()
        : "";
      await updateStatus.mutateAsync({
        id: doId,
        status: "DELIVERED",
        companyCode,
        evidence: {
          signatureData: sig || undefined,
          podKey,
          podKeys,
          ...(gps ? { podLat: gps.lat, podLng: gps.lng, podAccuracyM: gps.accuracyM ?? undefined, podLocatedAt: gps.atIso } : {}),
        },
      });
      await qc.invalidateQueries({ queryKey: ["mobile-so-list-paged"] });
      invalidateDoShared(qc);
      invalidateInventoryShared(qc);
      invalidateSoShared(qc);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Something went wrong. Please try again.");
      invalidateDoShared(qc);
      if (isCrew) void crewQ.refetch();
      setBusy(false);
      return;
    }
    if (issueOn && !(await sendIssue("The delivery is saved, but the problem report did not send"))) {
      setBusy(false);
      return;
    }
    setBusy(false);
    onDone?.();
  };

  const sendIssue = async (failPrefix: string): Promise<boolean> => {
    try {
      await reportDoDeliveryIssue(h?.do_number ?? doId ?? docNo, issueDraft);
      setIssueDraft(EMPTY_ISSUE_DRAFT);
      setIssueOn(false);
      await invalidateDeliveryIssues(qc);
      return true;
    } catch (e) {
      setActionError(`${failPrefix}: ${e instanceof Error ? e.message : "please try again"}.`);
      return false;
    }
  };
  const sendIssueOnly = async () => {
    if (busy) return;
    const err = deliveryIssueDraftError(issueDraft);
    if (err) { setActionError(err); return; }
    setActionError(null);
    setBusy(true);
    await sendIssue("The problem report did not send");
    setBusy(false);
  };

  const captureGps = () => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setGpsState("denied");
      return;
    }
    setGpsState("asking");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGps({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracyM: Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : null,
          atIso: new Date(pos.timestamp || Date.now()).toISOString(),
        });
        setGpsState("ok");
      },
      () => setGpsState("denied"),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 30_000 },
    );
  };

  const loading = isCrew ? crewQ.isPending : listQ.isPending || (!!doId && detailQ.isPending);
  const notFound = isCrew
    ? crewQ.isError && /not_found|could not be found/i.test(String(crewQ.error))
    : !listQ.isPending && !listQ.error && !doId;
  const loadError = isCrew ? (notFound ? null : crewQ.error) : listQ.error || detailQ.error;
  const pillLabel = cancelled ? "Cancelled" : delivered ? "Delivered" : "Arrived";
  const pillClass = cancelled ? "b-red" : delivered ? "b-green" : "b-brand";

  return (
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      <header className="hdr">
        <div className="hdr-row">
          <button className="back" onClick={onBack}>
            <span className="chev">‹</span> Delivery Orders
          </button>
          <span className={`badge ${pillClass}`}>{pillLabel}</span>
        </div>
        <div className="scr-title">Proof of Delivery</div>
        <div style={{ fontSize: 11.5, color: "var(--mut)", marginTop: 2 }} className="tnum">
          {(h?.do_number ?? docNo)}
          {h?.debtor_name ? ` · ${h.debtor_name}` : ""}
          {h?.city || h?.state || h?.customer_state ? ` · ${h.city || h.state || h.customer_state}` : ""}
        </div>
      </header>

      <div className="scroll hz-scroll" style={{ padding: "14px 16px", paddingBottom: 120 }}>
        {loading && <div style={{ textAlign: "center", color: "var(--mut2)", fontSize: 12, padding: "26px 0" }}>Loading{"…"}</div>}
        {notFound && <div style={{ textAlign: "center", color: "var(--red)", fontSize: 12, padding: "26px 0" }}>This delivery could not be found. Please refresh.</div>}
        {!loading && !notFound && loadError && (
          <div style={{ textAlign: "center", color: "var(--red)", fontSize: 12, padding: "26px 0" }}>Couldn{"'"}t load this delivery. Please try again.</div>
        )}

        {!loading && !notFound && !loadError && h && (
          <>
            <div className="fld-l" style={{ marginBottom: 8 }}>
              Items to deliver · {items.length}
              {items.length > 0 ? ` · ${deliveredCount} of ${items.length} delivered` : ""}
            </div>
            {items.length > 0 && <span className="list-note">Tick each item as it comes off the lorry</span>}
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {items.length ? items.map((it) => {
                const on = !!ticked[it.id];
                const ident = orderLineIdentity({ code: it.item_code, description: it.description, variant: it.description2 });
                return (
                  <div
                    key={it.id}
                    onClick={() => setTicked((t) => ({ ...t, [it.id]: !t[it.id] }))}
                    className="card"
                    style={{ display: "flex", alignItems: "center", gap: 10, border: on ? "1.5px solid var(--brand)" : "1px solid var(--line-card)", padding: "11px 13px", cursor: "pointer" }}
                  >
                    <span style={{ width: 22, height: 22, flex: "none", borderRadius: 6, background: on ? "var(--brand)" : "transparent", border: on ? "none" : "1.5px solid var(--brand)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                      {on && (
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M20 6 9 17l-5-5" />
                        </svg>
                      )}
                    </span>
                    {/* Item CODE first, then the variant subtitle; description dropped (owner 2026-07-24) — the
                        shared rule (vendor/shared/line-identity.ts). Desktop and
                        mobile are ONE logic layer, so this POD row follows the
                        DO detail exactly. The variant (a 2-seater vs a 3-seater)
                        is the driver's only tell between otherwise-identical
                        lines, so it renders on its own line; the QTY stays below
                        it and only the code (and its "·") is dropped. */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: "var(--ink)" }}>
                        {ident.primary || "—"}
                      </div>
                      {ident.secondary && (
                        <div style={{ fontSize: 11, color: "var(--mut)" }}>{ident.secondary}</div>
                      )}
                      <div style={{ fontSize: 11, color: "var(--mut2)" }} className="tnum">{"×"}{it.qty ?? 0}</div>
                    </div>
                  </div>
                );
              }) : <div style={{ fontSize: 11.5, color: "var(--mut2)", padding: "9px 2px" }}>No items on this delivery.</div>}
            </div>

            <div style={{ margin: "18px 0 0" }}>
              <FieldPhotos api={photos} disabled={busy || delivered} title="Delivery photos" />
            </div>

            <div className="fld-l" style={{ margin: "18px 0 8px" }}>Customer signature</div>
            <SignaturePad canvasRef={sigRef} onChange={setHasSignature} clearNonce={sigClearNonce} />
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 4 }}>
              <span style={{ fontSize: 11, color: "var(--mut)" }}>{hasSignature ? "Signed" : "Ask the customer to sign above"}</span>
              <span
                onClick={() => { setHasSignature(false); setSigClearNonce((n) => n + 1); }}
                style={{ fontSize: 11.5, fontWeight: 700, color: "var(--brand)", cursor: "pointer" }}
              >
                Clear &amp; re-sign
              </span>
            </div>

            <div className="fld-l" style={{ margin: "18px 0 8px" }}>Delivery location</div>
            <div style={{ background: "var(--card)", border: "1px solid var(--line-card)", borderRadius: 13, padding: "13px 14px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
              <span className="tnum" style={{ fontSize: 12, color: gpsState === "ok" ? "var(--ink)" : "var(--mut)", minWidth: 0 }}>
                {gpsState === "ok" && gps
                  ? `${gps.lat.toFixed(5)}, ${gps.lng.toFixed(5)}`
                  : gpsState === "asking"
                  ? "Getting location…"
                  : gpsState === "denied"
                  ? "Location unavailable"
                  : "Not captured"}
              </span>
              <button
                type="button"
                onClick={captureGps}
                disabled={gpsState === "asking"}
                style={{ flex: "none", border: "1px solid var(--brand)", background: "var(--card)", color: "var(--brand)", borderRadius: 9, padding: "7px 13px", fontFamily: "inherit", fontSize: 11.5, fontWeight: 700, cursor: gpsState === "asking" ? "default" : "pointer", opacity: gpsState === "asking" ? 0.55 : 1 }}
              >
                {gpsState === "ok" ? "Recapture" : "Capture GPS"}
              </button>
            </div>

            <div className="fld-l" style={{ margin: "18px 0 8px" }}>Problem with this delivery?</div>
            <MobileDeliveryIssues issues={reportedIssues} canCreateCase={false} />
            {!cancelled && canComplete && (
              !issueOn ? (
                <button type="button" className="btn-ghost" onClick={() => setIssueOn(true)} style={{ width: "100%", color: "var(--red)", borderColor: "var(--red)" }}>
                  {delivered ? "Report a problem" : "Delivered with issue"}
                </button>
              ) : (
                <div className="card" style={{ padding: 12, border: "1px solid var(--red)" }}>
                  <DeliveryIssueForm value={issueDraft} onChange={setIssueDraft} disabled={busy} />
                  <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                    <button type="button" className="btn-ghost" disabled={busy} onClick={() => { setIssueOn(false); setIssueDraft(EMPTY_ISSUE_DRAFT); }} style={{ flex: 1 }}>No problem</button>
                    {delivered && <button type="button" className="btn" disabled={busy} onClick={sendIssueOnly} style={{ flex: 1 }}>{busy ? "Sending…" : "Send report"}</button>}
                  </div>
                  {!delivered && <div style={{ fontSize: 11, color: "var(--mut)", marginTop: 8 }}>The delivery is still recorded as delivered; the office gets a service case with your photos.</div>}
                </div>
              )
            )}

            {actionError && <div style={{ marginTop: 14, fontSize: 11.5, color: "var(--red)", textAlign: "center" }}>{actionError}</div>}
          </>
        )}
      </div>

      <footer className="actbar">
        {!loading && !notFound && !loadError && h && !delivered && !cancelled && canComplete && (
          <button type="button" className="btn" disabled={busy} onClick={confirmDelivered} style={{ opacity: busy ? 0.6 : 1, cursor: busy ? "default" : "pointer" }}>
            {busy ? "Working…" : issueOn ? "Confirm delivered with issue →" : "Confirm delivered →"}
          </button>
        )}
        {!loading && !notFound && !loadError && h && !delivered && !cancelled && !canComplete && (
          <div style={{ textAlign: "center", fontSize: 11.5, color: "var(--mut2)", padding: 6 }}>
            You can view this delivery, but confirming it is handled by the Office team.
          </div>
        )}
        {!loading && !notFound && !loadError && h && delivered && (
          <div style={{ textAlign: "center", fontSize: 11.5, color: "var(--green)", padding: 6, fontWeight: 700 }}>This delivery is confirmed delivered.</div>
        )}
        {!loading && !notFound && !loadError && h && cancelled && (
          <div style={{ textAlign: "center", fontSize: 11.5, color: "var(--mut2)", padding: 6 }}>This delivery order was cancelled.</div>
        )}
        {(loading || notFound || (loadError && !h)) && (
          <button type="button" className="btn-ghost" onClick={onBack}>
            Back
          </button>
        )}
      </footer>
    </div>
  );
}

function SignaturePad({ canvasRef, onChange, clearNonce }: {
  canvasRef: React.MutableRefObject<HTMLCanvasElement | null>;
  onChange: (hasSignature: boolean) => void;
  clearNonce: number;
}) {
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const drew = useRef(false);

  useEffect(() => {
    if (clearNonce === 0) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    drew.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearNonce]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(rect.width * ratio));
    canvas.height = Math.max(1, Math.round(rect.height * ratio));
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.scale(ratio, ratio);
      ctx.lineWidth = 2.4;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = "#16695f";
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const start = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    drawing.current = true;
    last.current = point(e);
    if (!drew.current) { drew.current = true; onChange(true); }
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { }
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    e.preventDefault();
    const ctx = canvasRef.current?.getContext("2d");
    const p = point(e);
    if (ctx && last.current) {
      ctx.beginPath();
      ctx.moveTo(last.current.x, last.current.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }
    last.current = p;
  };
  const end = () => { drawing.current = false; last.current = null; };

  return (
    <div style={{ background: "var(--hz-c-surface)", border: "1px solid var(--line)", borderRadius: 13, padding: 14, position: "relative", height: 120 }}>
      <canvas
        ref={canvasRef}
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerLeave={end}
        onPointerCancel={end}
        style={{ width: "100%", height: 64, touchAction: "none", display: "block" }}
      />
      <div style={{ position: "absolute", left: 14, right: 14, bottom: 34, borderBottom: "1px dashed var(--mut2)" }} />
    </div>
  );
}
