// ---------------------------------------------------------------------------
// MobileDeliveryFieldsCard — the run sheet's "Delivery details" card.
//
// Extracted out of MobileDeliveryPlanning.tsx (which sits under a 2,449-line
// ceiling in scripts/file-size-ceilings.json and had ten lines of headroom).
// The card is the mobile counterpart of the desktop drawer
// `vendor/scm/components/DeliveryFieldsDrawer.tsx`; both PATCH the same
// `/delivery-planning/so/:id/fields`, so the two files are a pair and change
// together (docs/modules/delivery-tms.md §7).
//
// TWO GROUPS, SPLIT BY WHERE THE DATA IS OWNED — the desktop drawer's rule:
//   • SO-context   — move-in (possession) date, house type, referral,
//     replacement / disposal. Saved on the SO header, so they are editable
//     WITH OR WITHOUT a delivery order.
//   • DO-execution — time window + confirmed, arrival / departure clock,
//     shipout date, customer-delivered date, port ref, HC "Remark 4"
//     sub-status. These live on the DO, so they need one to exist.
//
// THE DISPOSAL LANE — why this is not just four more inputs.
// `replacement_disposal` is a CONTROLLED SO field (owner 2026-07-27). On a
// processing- or PO-locked order a change to it "appears in SO Amendment —
// Logistics reviews → approves", and the backend enforces exactly that:
// backend/src/scm/routes/delivery-planning.ts answers 409 `so_locked_processing`
// for a genuine disposal change on a locked SO. A client that simply PATCHes
// the field therefore gets a refusal with nowhere to go, which is why the
// desktop drawer recognises the lock and raises the amendment itself — and why
// the same routing has to exist here. The driver is the person who learns at
// the customer's door that the old set has to go.
//
// pdRow / hhmm / EM live in THIS file rather than in MobileDeliveryPlanning
// because both modules need them and MobileDeliveryPlanning already imports
// this one; putting them the other way round would make the import circular.
// ---------------------------------------------------------------------------

import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { HC_SUBSTATUS_VALUES } from "../vendor/scm/lib/delivery-planning-queries";
import { procLockActive } from "../vendor/scm/lib/so-detail-gates";
import { DateField } from "../vendor/scm/components/DateField";
import { DateTimeField } from "../vendor/scm/components/DateTimeField";
import { formatDate } from "../lib/utils";

// ── Shared presentational primitives (see the header note) ──
export const EM = "—";

// Time-of-day HH:MM from an ISO timestamp (for the tracking timeline).
export const hhmm = (ts: string | null | undefined): string => {
  if (!ts) return "";
  const dt = new Date(ts);
  if (isNaN(+dt)) return "";
  return `${String(dt.getHours()).padStart(2, "0")}:${String(
    dt.getMinutes(),
  ).padStart(2, "0")}`;
};

// pdRow — a canonical label:value row (.row / .row-l / .row-v). `last` drops
// the divider (matches .row:last-child).
export function pdRow(label: string, val: ReactNode, strong?: boolean, last?: boolean) {
  return (
    <div className="row" style={last ? { borderBottom: "none" } : undefined}>
      <span className="row-l">{label}</span>
      <span className={strong ? "row-v strong" : "row-v"}>{val}</span>
    </div>
  );
}

// A TIMESTAMPTZ ISO → the wall-clock YYYY-MM-DDTHH:mm DateTimeField reads and
// writes (the same shape the native datetime-local used, unchanged when
// Departure/Arrival moved onto DateTimeField on 2026-08-18).
const toDtLocal = (iso: string | null | undefined): string =>
  iso ? String(iso).slice(0, 16) : "";
// A YYYY-MM-DD date-ish string → the ISO value DateField takes.
const toDateInput = (d: string | null | undefined): string =>
  d ? String(d).slice(0, 10) : "";

// The desktop drawer's own option list — the two values HC records.
const HOUSE_TYPES = ["New House", "Replacement"] as const;

/* The row fields this card reads. Declared structurally rather than imported
   from MobileDeliveryPlanning's `BoardRow` so the dependency stays one-way;
   `BoardRow` satisfies it by shape. */
export type DeliveryFieldsOrder = {
  so_doc_no: string;
  status: string | null;
  processing_date: string | null;
  po_locked?: boolean | null;
  possession_date: string | null;
  house_type: string | null;
  replacement_disposal: string | null;
  referral: string | null;
  time_range?: string | null;
  time_confirmed?: boolean | null;
  arrival_at?: string | null;
  departure_at?: string | null;
  shipout_date?: string | null;
  customer_delivered_date?: string | null;
  eta_arriving_port?: string | null;
  delivery_substatus?: string | null;
};

/* The editor's draft — every field a string (or the one checkbox) so the diff
   below is a plain comparison and blank collapses to null on the wire. */
export type DeliveryFieldsForm = {
  // SO-context
  possessionDate: string;
  houseType: string;
  referral: string;
  replacementDisposal: string;
  // DO-execution
  timeRange: string;
  timeConfirmed: boolean;
  arrivalAt: string;
  departureAt: string;
  shipoutDate: string;
  customerDeliveredDate: string;
  etaArrivingPort: string;
  deliverySubstatus: string;
};

export type DeliveryFieldsPatch = {
  /** The direct PATCH body — changed keys only. */
  body: Record<string, unknown>;
  /** TRUE when the disposal change must be raised as an SO Amendment instead.
      This is the flag to branch on: `amendmentDisposal` is null both when there
      is no amendment AND when the amendment CLEARS the field. */
  disposalViaAmendment: boolean;
  /** The value the amendment carries; null when the field is being cleared. */
  amendmentDisposal: string | null;
  /** Nothing to send down either lane. */
  empty: boolean;
};

/* buildDeliveryFieldsPatch — the whole save DECISION, as a pure function.
   Changed-only (mobile keeps its diff; the desktop drawer posts the full form),
   plus the desktop drawer's two gates: DO-execution needs a DO, and a disposal
   change on a locked order leaves the body and becomes an amendment. */
export function buildDeliveryFieldsPatch(
  initial: DeliveryFieldsForm,
  form: DeliveryFieldsForm,
  opts: { procLocked: boolean; hasDo: boolean },
): DeliveryFieldsPatch {
  const body: Record<string, unknown> = {};

  // ── SO-context: always eligible, DO or no DO ──
  if (form.possessionDate !== initial.possessionDate)
    body.possessionDate = form.possessionDate || null;
  if (form.houseType !== initial.houseType) body.houseType = form.houseType || null;
  if (form.referral !== initial.referral) body.referral = form.referral || null;

  /* Disposal is compared TRIMMED on both sides so re-saving the same text with
     stray spaces is not a "change" the backend would 409 (its own genuineChange
     test compares the stored value). */
  const disposalNow = form.replacementDisposal.trim() || null;
  const disposalWas = initial.replacementDisposal.trim() || null;
  const disposalDirty = disposalNow !== disposalWas;
  const disposalViaAmendment = opts.procLocked && disposalDirty;
  if (disposalDirty && !disposalViaAmendment) body.replacementDisposal = disposalNow;

  // ── DO-execution: only once a DO exists (the fields live on it) ──
  if (opts.hasDo) {
    if (form.timeRange !== initial.timeRange) body.timeRange = form.timeRange || null;
    if (form.timeConfirmed !== initial.timeConfirmed) body.timeConfirmed = form.timeConfirmed;
    if (form.arrivalAt !== initial.arrivalAt) body.arrivalAt = form.arrivalAt || null;
    if (form.departureAt !== initial.departureAt) body.departureAt = form.departureAt || null;
    if (form.shipoutDate !== initial.shipoutDate) body.shipoutDate = form.shipoutDate || null;
    if (form.customerDeliveredDate !== initial.customerDeliveredDate)
      body.customerDeliveredDate = form.customerDeliveredDate || null;
    if (form.etaArrivingPort !== initial.etaArrivingPort)
      body.etaArrivingPort = form.etaArrivingPort || null;
    if (form.deliverySubstatus !== initial.deliverySubstatus)
      body.deliverySubstatus = form.deliverySubstatus || null;
  }

  return {
    body,
    disposalViaAmendment,
    amendmentDisposal: disposalViaAmendment ? disposalNow : null,
    empty: Object.keys(body).length === 0 && !disposalViaAmendment,
  };
}

export function DeliveryFieldsCard({
  order,
  hasDo,
  editing,
  saving,
  onEdit,
  onCancel,
  onSave,
}: {
  order: DeliveryFieldsOrder;
  hasDo: boolean;
  editing: boolean;
  saving: boolean;
  onEdit: () => void;
  onCancel: () => void;
  /* `amendment` is REQUIRED and nullable, never optional: it DECIDES whether a
     second write happens, and an optional argument every caller can forget is
     how a decision silently defaults (CLAUDE.md, optional-param-noop). */
  onSave: (
    body: Record<string, unknown>,
    amendment: { disposal: string | null } | null,
  ) => void;
}) {
  /* The same predicate the SO editor and the desktop drawer use. `po_locked`
     arrives on the board payload — it cannot be derived here, the feed carries
     no PO linkage — and absent (Houzs, or a pre-deploy cache) reads as false,
     so the gate degrades to the date rule alone. */
  const procLocked = procLockActive({
    processing_date: order.processing_date,
    status: order.status,
    po_locked: order.po_locked,
  });

  const initial = useMemo(
    () => ({
      possessionDate: toDateInput(order.possession_date),
      houseType: order.house_type ?? "",
      referral: order.referral ?? "",
      replacementDisposal: order.replacement_disposal ?? "",
      timeRange: order.time_range ?? "",
      timeConfirmed: !!order.time_confirmed,
      arrivalAt: toDtLocal(order.arrival_at),
      departureAt: toDtLocal(order.departure_at),
      shipoutDate: toDateInput(order.shipout_date),
      customerDeliveredDate: toDateInput(order.customer_delivered_date),
      etaArrivingPort: order.eta_arriving_port ?? "",
      deliverySubstatus: order.delivery_substatus ?? "",
    }),
    [order],
  );
  const [form, setForm] = useState(initial);
  // Re-seed the draft each time the editor is (re)opened so a fresh board fetch
  // isn't shadowed by a stale draft.
  const startEdit = () => {
    setForm(initial);
    onEdit();
  };
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((s) => ({ ...s, [k]: v }));

  const save = () => {
    const patch = buildDeliveryFieldsPatch(initial, form, { procLocked, hasDo });
    if (patch.empty) {
      onCancel();
      return;
    }
    onSave(
      patch.body,
      patch.disposalViaAmendment ? { disposal: patch.amendmentDisposal } : null,
    );
  };

  const inputStyle: CSSProperties = {
    width: "100%",
    fontFamily: "inherit",
    fontSize: 13,
    color: "var(--ink)",
    background: "var(--bg)",
    border: "1px solid var(--line)",
    borderRadius: 9,
    padding: "9px 10px",
    marginTop: 3,
  };
  const groupStyle: CSSProperties = {
    fontSize: 11,
    fontWeight: 800,
    letterSpacing: 0.4,
    textTransform: "uppercase",
    color: "var(--mut)",
    margin: "2px 0 8px",
  };
  const hintStyle: CSSProperties = {
    background: "rgba(232, 107, 58, 0.06)",
    border: "1px solid #e86b3a",
    color: "#8a3d15",
    padding: "8px 10px",
    borderRadius: 9,
    fontSize: 11.5,
    lineHeight: 1.45,
    marginBottom: 10,
  };

  const disposal = (order.replacement_disposal && order.replacement_disposal.trim()) || "";

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="card-h">
        <span className="card-t">Delivery details</span>
        {!editing && (
          <span
            onClick={startEdit}
            className="card-sub"
            style={{ color: "var(--brand)", fontWeight: 700, cursor: "pointer" }}
          >
            Edit
          </span>
        )}
      </div>
      {editing ? (
        <div className="card-b">
          {/* ── Order context — saved on the SO, so editable with or without a
              DO. Mirrors the desktop drawer's always-editable group. ── */}
          <div style={groupStyle}>Order context</div>
          <label style={{ display: "block", marginBottom: 10 }}>
            <span className="fld-l">Move-in date</span>
            <DateField
              value={form.possessionDate}
              onChange={(iso) => set("possessionDate", iso)}
              style={inputStyle}
            />
          </label>
          <label style={{ display: "block", marginBottom: 10 }}>
            <span className="fld-l">House type</span>
            <select
              value={form.houseType}
              onChange={(e) => set("houseType", e.target.value)}
              style={inputStyle}
            >
              <option value="">{EM}</option>
              {HOUSE_TYPES.map((h) => (
                <option key={h} value={h}>
                  {h}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: "block", marginBottom: 10 }}>
            <span className="fld-l">Referral</span>
            <input
              value={form.referral}
              placeholder="Referral source / channel"
              onChange={(e) => set("referral", e.target.value)}
              style={inputStyle}
            />
          </label>
          <label style={{ display: "block", marginBottom: 10 }}>
            <span className="fld-l">Replacement / disposal</span>
            <input
              value={form.replacementDisposal}
              placeholder="What's being disposed / how the old set is handled"
              onChange={(e) => set("replacementDisposal", e.target.value)}
              style={inputStyle}
            />
            {/* Shown whenever the order is locked, not only once the field is
                dirty — the driver should know the cost before typing. */}
            {procLocked && (
              <span
                style={{
                  display: "block",
                  marginTop: 4,
                  fontSize: 11,
                  lineHeight: 1.45,
                  color: "#8a3d15",
                }}
              >
                Order is locked — saving a change here raises an SO Amendment for
                Logistics to approve.
              </span>
            )}
          </label>

          {/* ── Delivery execution — these columns live on the DO. ── */}
          <div style={{ ...groupStyle, marginTop: 16 }}>
            Delivery execution {hasDo ? "" : "(needs a DO)"}
          </div>
          {hasDo ? (
            <>
              <label style={{ display: "block", marginBottom: 10 }}>
                <span className="fld-l">Time window</span>
                <input
                  value={form.timeRange}
                  placeholder="e.g. 10am-12pm"
                  onChange={(e) => set("timeRange", e.target.value)}
                  style={inputStyle}
                />
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                <input
                  type="checkbox"
                  checked={form.timeConfirmed}
                  onChange={(e) => set("timeConfirmed", e.target.checked)}
                  style={{ width: 18, height: 18, accentColor: "#16695f" }}
                />
                <span style={{ fontSize: 12.5, color: "var(--ink2)" }}>Time confirmed with customer</span>
              </label>
              <label style={{ display: "block", marginBottom: 10 }}>
                <span className="fld-l">Departure</span>
                <DateTimeField
                  fullWidth
                  aria-label="Departure"
                  value={form.departureAt}
                  onChange={(v) => set("departureAt", v)}
                  style={inputStyle}
                />
              </label>
              <label style={{ display: "block", marginBottom: 10 }}>
                <span className="fld-l">Arrival</span>
                <DateTimeField
                  fullWidth
                  aria-label="Arrival"
                  value={form.arrivalAt}
                  onChange={(v) => set("arrivalAt", v)}
                  style={inputStyle}
                />
              </label>
              <label style={{ display: "block", marginBottom: 10 }}>
                <span className="fld-l">Shipout date (EM/SG)</span>
                <DateField value={form.shipoutDate} onChange={(iso) => set("shipoutDate", iso)} style={inputStyle}/>
              </label>
              <label style={{ display: "block", marginBottom: 10 }}>
                <span className="fld-l">Customer delivered date</span>
                <DateField value={form.customerDeliveredDate} onChange={(iso) => set("customerDeliveredDate", iso)} style={inputStyle}/>
              </label>
              <label style={{ display: "block", marginBottom: 10 }}>
                <span className="fld-l">ETA / arriving port (EM/SG)</span>
                <input
                  value={form.etaArrivingPort}
                  placeholder="Port / shipment ref e.g. KUC3012008"
                  onChange={(e) => set("etaArrivingPort", e.target.value)}
                  style={inputStyle}
                />
              </label>
              <label style={{ display: "block", marginBottom: 12 }}>
                <span className="fld-l">Delivery status</span>
                <select
                  value={form.deliverySubstatus}
                  onChange={(e) => set("deliverySubstatus", e.target.value)}
                  style={inputStyle}
                >
                  <option value="">{EM}</option>
                  {HC_SUBSTATUS_VALUES.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
            </>
          ) : (
            /* Eight disabled inputs is a lot of dead space on a phone, so the
               group is replaced by the reason rather than greyed out (the
               desktop drawer has the room to disable a fieldset instead). */
            <div style={hintStyle}>
              No delivery order yet — create one to record the time window,
              shipout, port and delivery status.
            </div>
          )}

          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={onCancel}
              disabled={saving}
              style={{
                flex: 1,
                height: 42,
                border: "1px solid #d6d9d2",
                borderRadius: 11,
                background: "#fff",
                color: "var(--ink2)",
                fontFamily: "inherit",
                fontSize: 13,
                fontWeight: 700,
                cursor: saving ? "default" : "pointer",
              }}
            >
              Cancel
            </button>
            <button
              onClick={save}
              disabled={saving}
              style={{
                flex: 1,
                height: 42,
                border: "none",
                borderRadius: 11,
                background: saving ? "#7fb4ad" : "#16695f",
                color: "#fff",
                fontFamily: "inherit",
                fontSize: 13,
                fontWeight: 800,
                cursor: saving ? "default" : "pointer",
              }}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* Of the four SO-context fields only the disposal gets a read row
              here: move-in date, house type and referral already have one on
              this same screen (the Delivery card and the document card), and a
              second copy would just be noise. */}
          {pdRow("Replacement / disposal", disposal || EM, true, !hasDo)}
          {hasDo && (
            <>
              {pdRow("Time window", (order.time_range && order.time_range.trim()) || EM, true)}
              {pdRow(
                "Time confirmed",
                order.time_confirmed == null ? EM : order.time_confirmed ? "Yes" : "No",
                true,
              )}
              {pdRow("Departure", order.departure_at ? hhmm(order.departure_at) : EM, false)}
              {pdRow("Arrival", order.arrival_at ? hhmm(order.arrival_at) : EM, true)}
              {pdRow("Shipout date", formatDate(order.shipout_date), false)}
              {pdRow("Delivered date", formatDate(order.customer_delivered_date), true)}
              {pdRow(
                "Arriving port",
                (order.eta_arriving_port && order.eta_arriving_port.trim()) || EM,
                false,
              )}
              {pdRow(
                "Delivery status",
                (order.delivery_substatus && order.delivery_substatus.trim()) || EM,
                true,
                true,
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
