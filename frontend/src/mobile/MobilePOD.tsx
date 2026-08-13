import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { orderLineIdentity } from "@2990s/shared";
import { invalidateDoShared, invalidateInventoryShared, invalidateSoShared } from "./sharedInvalidate";
import {
  useMfgDeliveryOrderDetail,
  useMfgDeliveryOrdersPaged,
} from "../vendor/scm/lib/delivery-order-queries";
import { authedFetch } from "../vendor/scm/lib/authed-fetch";
import { uploadSlipFull, ALLOWED_SLIP_MIMES } from "../vendor/scm/lib/slip";
import { useConfirm } from "../vendor/scm/components/ConfirmDialog";
import { useAuth } from "../auth/AuthContext";
import { canOperateDeliveryOrders } from "../auth/salesAccess";
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

   The delivery PHOTO is uploaded to R2 (the shared slip Worker-proxy
   pipeline: uploadSlipFull → { r2Key }) and its key is persisted as
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
/* How many rows the docNo lookup asks for. The server's `q` is NOT a do_number
   lookup — it is a substring OR across eight columns (do_number, so_doc_no,
   debtor_name, debtor_code, ref, branding, sales_location, driver_name;
   delivery-orders-mfg.ts:2082) — so a DO number can incidentally match another
   row (a `ref` that cites it, say). do_number itself is unique, so the exact
   match below is what decides; this is only the window that match must land in. */
const DOC_NO_LOOKUP_ROWS = 20;

/* A DO whose status is already a terminal delivered/invoiced state is done —
   the primary action is hidden and the header pill reads accordingly. */
const isDelivered = (status: string | null): boolean => {
  const s = (status ?? "").toUpperCase();
  return s === "DELIVERED" || s === "INVOICED" || s === "SIGNED";
};
const isCancelled = (status: string | null): boolean => (status ?? "").toUpperCase() === "CANCELLED";

/** Proof of Delivery — full-height overlay. `docNo` is a Delivery Order NUMBER;
 *  we resolve it to the DO UUID via the list route, then read the detail. */
export function MobilePOD({ docNo, onBack, onDone }: { docNo: string; onBack: () => void; onDone?: () => void }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  /* DO OPERATE gate — mirrors the desktop DeliveryOrderDetailV2 `canWriteDo`
     (canOperateDeliveryOrders) and the SAME gate the delivery-planning board +
     MobileModuleDetail status actions use. Confirming a delivery DEDUCTS STOCK +
     SYNCS THE SO, so a view-only user (the Sales cohort) must not reach it — the
     Confirm action is gated on this; reads stay
     open (off, not hide). MobileApp already withholds the POD entry for these
     users, so this is the defence-in-depth layer on the actions themselves. */
  const { user, can, pageAccess } = useAuth();
  const canOperate = canOperateDeliveryOrders(user, can, pageAccess);

  /* Resolve docNo (a DO number) → the DO row (carries the UUID every other route
     keys on). ASK THE SERVER FOR THE ONE DOCUMENT, don't scan the org's DOs on a
     phone: the no-param branch of this route is capped at `.limit(500)` newest-first
     (delivery-orders-mfg.ts:2047), so it shipped ~500 wide header rows over mobile
     data to read a single id — and once the org passes 500 DOs, a REAL DO older than
     the newest 500 simply was not in the answer, so this screen told the driver it
     "could not be found. Please refresh" — advice that can never come true, on a
     delivery they are standing in front of. Paging + `q` narrows it to the match.

     The shared hooks (and their shared query keys) are deliberate, not incidental:
     the private ["mobile-do-list-for-pod"] / ["mobile-pod-*"] keys these replace were
     a second cache over the same URLs, invisible to invalidateDoShared — so a write
     from the desktop or the planning board left this screen stale, and this screen's
     own writes left theirs stale. One namespace, one logic layer. */
  const listQ = useMfgDeliveryOrdersPaged({ page: 0, pageSize: DOC_NO_LOOKUP_ROWS, q: docNo });
  const doId = useMemo(() => {
    const rows = listQ.data?.deliveryOrders;
    // No rows yet (pending, or the read failed) is NOT "no such DO" — leave it
    // null and let the render tell those two apart. See `notFound` below.
    if (!rows) return null;
    return (rows.find((d: DoHeader) => (d.do_number ?? "") === docNo)?.id ?? null) as string | null;
  }, [listQ.data, docNo]);

  const detailQ = useMfgDeliveryOrderDetail(doId);

  const h = detailQ.data?.deliveryOrder as DoHeader | undefined;
  /* CANCELLED lines are excluded from the driver checklist AND the "delivered
     X/N" count — desktop parity: DeliveryOrderDetailV2 filters `!l.cancelled`.
     Without this a cancelled line entered the tick-list and inflated N, so a
     fully-delivered DO could never read 100%. Filtering here fixes both the
     render and `deliveredCount`/`items.length` below in one place. */
  const items = ((detailQ.data?.items ?? []) as DoItem[]).filter((l) => !l.cancelled);

  // Checklist — which line items the driver has ticked as delivered.
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const deliveredCount = items.reduce((n, it) => n + (ticked[it.id] ? 1 : 0), 0);

  // Signature pad + GPS + photo (captured locally — see file header).
  const sigRef = useRef<HTMLCanvasElement | null>(null);
  const [hasSignature, setHasSignature] = useState(false);
  const [sigClearNonce, setSigClearNonce] = useState(0);
  const [gps, setGps] = useState<{ lat: number; lng: number; accuracyM: number | null; atIso: string } | null>(null);
  const [gpsState, setGpsState] = useState<"idle" | "asking" | "ok" | "denied">("idle");
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const photoName = photoFile?.name ?? null;

  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const delivered = h ? isDelivered(h.status) : false;
  const cancelled = h ? isCancelled(h.status) : false;

  const confirmDelivered = async () => {
    // Defence-in-depth: the Confirm button is already withheld for a view-only
    // user, but the delivery write (stock + SO sync) must never fire without the
    // operate gate even if the button is somehow reached.
    if (busy || !doId || !h || !canOperate) return;
    const notes: string[] = [];
    if (deliveredCount < items.length) {
      notes.push(`Only ${deliveredCount} of ${items.length} items are ticked.`);
    }
    if (!(await confirm({
      title: `Mark ${h.do_number ?? docNo} delivered?`,
      body: notes.length ? notes.join(" ") : undefined,
      confirmLabel: "Confirm delivered",
    }))) return;
    setActionError(null);
    setBusy(true);
    try {
      // Deliver action — the DO status endpoint persists the POD signature
      // (base64 PNG) onto delivery_orders.signature_data, the delivery photo's
      // R2 key onto delivery_orders.pod_r2_key, and (since mig 0249) the GPS
      // reading onto pod_lat / pod_lng / pod_accuracy_m / pod_located_at. The
      // last sentence here used to read "GPS stays client-side (no server
      // column)", which stopped being true at 0249 and is corrected in place
      // rather than left to teach the next reader the old shape.
      // Upload the photo to R2 FIRST (shared slip Worker-proxy pipeline) so
      // its key rides the same PATCH. A failed upload aborts the whole action —
      // we never mark delivered while claiming a photo we didn't store.
      let podKey: string | null = null;
      if (photoFile) {
        const { r2Key } = await uploadSlipFull({ file: photoFile });
        podKey = r2Key;
      }
      /* `hasSignature` — NOT the canvas — decides whether a signature is sent.
         An untouched pad is a sized, fully transparent bitmap, so
         `toDataURL("image/png")` returns a perfectly valid non-empty data URL
         for it; `sig ? …` was therefore true on EVERY confirm once the pad had
         mounted, and every delivery stored a blank PNG into
         `delivery_orders.signature_data`. The screen said "Ask the customer to
         sign above" and filed the delivery as signed anyway — worse than storing
         nothing, because a blank image is indistinguishable from a real POD that
         failed to render, and it is the only customer-side evidence the DO
         carries. `hasSignature` is set by the pad's own `start()` on the first
         pointerdown (and cleared by Clear), so it is the one flag that means a
         human drew something. `podKey` and `gps` in the same object literal were
         already gated on real capture; this brings the third field in line. */
      const sig = hasSignature
        ? (() => { try { return sigRef.current?.toDataURL("image/png") ?? ""; } catch { return ""; } })()
        : "";
      await authedFetch(`/delivery-orders-mfg/${encodeURIComponent(doId)}/status`, {
        method: "PATCH",
        body: JSON.stringify({
          status: "DELIVERED",
          ...(sig ? { signatureData: sig } : {}),
          ...(podKey ? { podKey } : {}),
          /* Mig 0249. This reading was taken and thrown away on every delivery
             since this screen shipped — the header used to end "GPS stays
             client-side (no server column)". Sent only when the driver actually
             captured one; a denial or an indoor dead spot must never block a
             delivery from closing. */
          ...(gps ? { podLat: gps.lat, podLng: gps.lng, podAccuracyM: gps.accuracyM ?? undefined, podLocatedAt: gps.atIso } : {}),
        }),
      });
      await qc.invalidateQueries({ queryKey: ["mobile-so-list-paged"] });
      // Delivering moves stock + flips the DO + touches SO readiness — refresh
      // the shared/desktop DO, inventory and SO caches too. This screen's own
      // reads are shared keys, so invalidateDoShared's DO_ROOTS prefix-match
      // already covers them (list + detail) — there is no private mobile key
      // left to refresh separately.
      invalidateDoShared(qc);
      invalidateInventoryShared(qc);
      invalidateSoShared(qc);
      onDone?.();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
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
          /* Kept because two coordinates look equally authoritative whether they
             came from GPS on a clear street or a wifi guess inside a warehouse.
             The radius is what tells them apart. */
          accuracyM: Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : null,
          /* The reading's OWN time, not the moment the driver finishes the
             paperwork — those can be minutes apart. */
          atIso: new Date(pos.timestamp || Date.now()).toISOString(),
        });
        setGpsState("ok");
      },
      () => setGpsState("denied"),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 30_000 },
    );
  };

  // isPending, not isLoading: isLoading is (isPending && isFetching), so it is
  // FALSE while a query is pending-but-not-fetching — which is exactly what a
  // driver's phone does when it drops off the carrier for a moment (the query
  // PAUSES). On isLoading the notFound branch then painted "could not be found"
  // in red before any fetch had run. detailQ is enabled:!!doId, and a disabled
  // query stays isPending forever, so its check must stay behind the doId guard.
  const loading = listQ.isPending || (!!doId && detailQ.isPending);
  // `!listQ.error` is load-bearing: without it a FAILED lookup (no rows, so no
  // doId) fell into this branch and told the driver the delivery "could not be
  // found" — stating as fact something we had not learned. A read that did not
  // answer must fall through to loadError below and say so.
  const notFound = !listQ.isPending && !listQ.error && !doId;
  const loadError = listQ.error || detailQ.error;
  const pillLabel = cancelled ? "Cancelled" : delivered ? "Delivered" : "Arrived";
  // Header status badge → canonical .badge variant (spec: DISPATCHED/arrived =
  // brand, DELIVERED = green, cancelled = red).
  const pillClass = cancelled ? "b-red" : delivered ? "b-green" : "b-brand";

  return (
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      {/* .hdr — back-to-DO + "Proof of Delivery" + status pill (design POD header) */}
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
            {/* Items to deliver · N — .fld-l label + list-note + tickable cards */}
            <div className="fld-l" style={{ marginBottom: 8 }}>
              Items to deliver · {items.length}
              {items.length > 0 ? ` · ${deliveredCount} of ${items.length} delivered` : ""}
            </div>
            {items.length > 0 && <span className="list-note">Tick each item as it comes off the lorry</span>}
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {items.length ? items.map((it) => {
                const on = !!ticked[it.id];
                // Item CODE + variant (description2); description dropped —
                // mirror DeliveryOrderDetailV2's
                // `orderLineIdentity({ code, description, variant: l.description2 })`.
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

            {/* Delivery photos — designer two-column row: Take-photo button + a
                preview tile that lights up once captured. Photos are captured
                locally and uploaded to R2 on Confirm. */}
            <div className="fld-l" style={{ margin: "18px 0 8px" }}>Delivery photos</div>
            <div style={{ display: "flex", gap: 9 }}>
              <label style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 6, background: "var(--brand)", border: "none", borderRadius: 13, padding: 14, color: "#fff", fontFamily: "inherit", fontSize: 11.5, fontWeight: 700, cursor: "pointer" }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z" />
                  <circle cx="12" cy="13" r="3" />
                </svg>
                {photoName ? "Retake photo" : "Take photo"}
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  capture="environment"
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const f = e.target.files?.[0] ?? null;
                    if (!f) return;
                    // Guard against the R2 pipeline's contract (jpeg/png/webp)
                    // up front so the operator learns before Confirm, not
                    // mid-upload. No size guard here any more: uploadSlipFull
                    // compresses photos (WO-7), so a raw 8 MB camera capture
                    // is EXPECTED input now — it leaves the phone at well
                    // under the 5 MiB slip ceiling.
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
              <div style={{ flex: 1, borderRadius: 13, minHeight: 70, background: photoName ? "linear-gradient(135deg,#d7ded6,#c7d0c4)" : "linear-gradient(135deg,#eceee9,#e3e6e0)" }} />
            </div>
            {photoName && <div style={{ fontSize: 10.5, color: "var(--mut)", marginTop: 6 }} className="tnum">{photoName}</div>}
            {photoError && <div style={{ fontSize: 10.5, color: "var(--red)", marginTop: 6 }}>{photoError}</div>}

            {/* Customer signature — design signature pad (canvas keeps the real capture). */}
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

            {/* Delivery location — saved with the POD since mig 0249. */}
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

            {actionError && <div style={{ marginTop: 14, fontSize: 11.5, color: "var(--red)", textAlign: "center" }}>{actionError}</div>}
          </>
        )}
      </div>

      {/* .actbar — primary confirm action (design POD footer) */}
      <footer className="actbar">
        {!loading && !notFound && !loadError && h && !delivered && !cancelled && canOperate && (
          <button type="button" className="btn" disabled={busy} onClick={confirmDelivered} style={{ opacity: busy ? 0.6 : 1, cursor: busy ? "default" : "pointer" }}>
            {busy ? "Working…" : "Confirm delivered →"}
          </button>
        )}
        {/* View-only (Sales cohort): confirming a delivery is the Office team's
            job. State it plainly instead of showing a button the backend 403s. */}
        {!loading && !notFound && !loadError && h && !delivered && !cancelled && !canOperate && (
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

/** Canvas signature pad — pointer/touch strokes; exposes hasSignature to the
 *  parent. The captured strokes can be read via canvasRef.current.toDataURL()
 *  when a backend field to persist them exists (none today). Bumping
 *  `clearNonce` wipes the pad and re-arms the "signed" latch. */
function SignaturePad({ canvasRef, onChange, clearNonce }: {
  canvasRef: React.MutableRefObject<HTMLCanvasElement | null>;
  onChange: (hasSignature: boolean) => void;
  clearNonce: number;
}) {
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const drew = useRef(false);

  // Wipe the pad + re-arm the latch when the parent's Clear bumps the nonce.
  useEffect(() => {
    if (clearNonce === 0) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    drew.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearNonce]);

  // Size the backing store to the element's CSS box (device-pixel aware) so
  // strokes aren't stretched. Runs once on mount.
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
    // First mark of a fresh (or freshly-cleared) pad flags a signature. The
    // parent resets its own flag on Clear; we re-flag on the next real stroke.
    if (!drew.current) { drew.current = true; onChange(true); }
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* older browsers */ }
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
    <div style={{ background: "#fff", border: "1px solid var(--line)", borderRadius: 13, padding: 14, position: "relative", height: 120 }}>
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
