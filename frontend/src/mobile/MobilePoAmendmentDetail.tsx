import { useMemo } from "react";
import { fmtMoneySen } from "@2990s/shared";
import { formatDate } from "../lib/utils";
import { useConfirm } from "../vendor/scm/components/ConfirmDialog";
import { useNotify } from "../vendor/scm/components/NotifyDialog";
import { usePrompt } from "../vendor/scm/components/PromptDialog";
import { useAuth as useHouzsAuth } from "../auth/AuthContext";
import { useAuth as useScmAuth } from "../vendor/scm/lib/auth";
import { useStaffLookup } from "../hooks/useStaffLookup";
import {
  simplifiedAmendmentPill,
  amendmentBucketOf,
  type StatusTone,
} from "../vendor/scm/lib/status-pill";
import {
  usePoAmendmentDetail,
  useApprovePoAmendment,
  useRejectPoAmendment,
  useWithdrawPoAmendment,
  poLineFieldKinds,
  poHeaderFieldKind,
  type PoAmendmentLine,
} from "../vendor/scm/lib/po-amendment-queries";
import {
  routeField,
  summariseRouting,
  FIELD_KIND_LABEL,
  TYPE_LABEL,
  type AmendmentFieldKind,
} from "../vendor/scm/lib/amendment-routing";
import { humanApiError } from "../vendor/scm/lib/authed-fetch";
import { generateAmendmentPdf } from "../vendor/scm/lib/amendment-pdf";
import { PrintPreviewModal, usePrintPreview } from "../components/scm-v2/PrintPreviewModal";
import type { PdfAction } from "../vendor/scm/lib/pdf-common";
import { amendmentPrintedStatus, poAmendmentToPdfInput } from "../vendor/scm/lib/amendment-pdf-map";
import "./mobile.css";

/* ------------------------------------------------------------------ *
 * Mobile PO amendment job card — the phone twin of desktop
 * pages/scm-v2/PoAmendmentDetailV2.tsx. View the before -> after diff and, for
 * an approver on the go, run the single-approver gate (approve / reject /
 * withdraw). Print reuses the shared amendment PDF (poAmendmentToPdfInput).
 * ------------------------------------------------------------------ */

const TONE_BADGE_CLASS: Record<StatusTone, string> = {
  neutral: "b-grey", info: "b-brand", progress: "b-amber",
  success: "b-green", danger: "b-red", pending: "b-amber",
};

const fmtSen = (centi: number | null | undefined): string => fmtMoneySen(centi);

type PoOldSnapshot = {
  item_code?: string | null;
  material_name?: string | null;
  qty?: number | null;
  unit_price_sen?: number | null;
  delivery_date?: string | null;
};
const oldOf = (l: PoAmendmentLine): PoOldSnapshot => (l.old_snapshot as PoOldSnapshot | null) ?? {};

const HEADER_LABEL: Record<string, string> = {
  supplier_id: "Supplier", expected_at: "Delivery date", notes: "Notes",
};

const plainError = (e: unknown): string => {
  const err = e as { status?: number; body?: string; message?: string };
  if (typeof err?.status === "number" && typeof err?.body === "string") return humanApiError(err.status, err.body);
  return err?.message ?? "Something went wrong. Please try again.";
};

/* Per-row department routing chips (mobile idiom). Advisory accountability — it
   never gates the single-signature apply. */
function RoutingChips({ kinds }: { kinds: AmendmentFieldKind[] }) {
  if (kinds.length === 0) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 4 }}>
      {kinds.map((k) => (
        <span
          key={k}
          style={{
            display: "inline-flex", alignItems: "center", gap: 3, fontSize: 10,
            padding: "1px 5px", borderRadius: 4, border: "1px solid var(--line2)",
            background: "var(--card2, var(--card))", color: "var(--mut)",
          }}
        >
          <span style={{ color: "var(--ink)", fontWeight: 600 }}>{FIELD_KIND_LABEL[k]}</span>
          <span aria-hidden>&rarr;</span>
          <span style={{ fontWeight: 700, color: "var(--brand)" }}>{routeField(k).department}</span>
        </span>
      ))}
    </div>
  );
}

/* The amendment TYPE badge(s) — Processing vs Delivery / Commercial, Mixed when both. */
function TypeBadges({ kinds }: { kinds: AmendmentFieldKind[] }) {
  const { types, isMixed } = summariseRouting(kinds);
  if (types.length === 0) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 6 }}>
      {isMixed && (
        <span style={{ fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".04em", padding: "1px 6px", borderRadius: 4, background: "var(--line2)", color: "var(--mut)" }}>
          Mixed
        </span>
      )}
      {types.map((t) => (
        <span key={t} style={{ fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".04em", padding: "1px 6px", borderRadius: 4, background: "var(--brand-tint, var(--line2))", color: "var(--brand)" }}>
          {TYPE_LABEL[t]}
        </span>
      ))}
    </div>
  );
}

function DiffRow({ line }: { line: PoAmendmentLine }) {
  const old = oldOf(line);
  const isAdd = line.change_type === "ADD";
  const isRemove = line.change_type === "REMOVE";
  const newCode = line.new_item_code ?? old.item_code ?? null;
  return (
    <div style={{ padding: "9px 0", borderTop: "1px solid var(--line2)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: ".04em", textTransform: "uppercase", color: "var(--mut2)" }}>
          {line.change_type}
        </div>
      </div>
      <RoutingChips kinds={poLineFieldKinds(line)} />
      {isRemove ? (
        <div style={{ marginTop: 3, fontSize: 12.5 }}>
          <span style={{ textDecoration: "line-through", color: "var(--mut)" }}>
            {old.item_code ?? "—"} · Qty {old.qty ?? "—"}
          </span>
          <span style={{ color: "var(--red)", fontWeight: 700 }}> → Removed</span>
        </div>
      ) : isAdd ? (
        <div style={{ marginTop: 3, fontSize: 12.5, fontWeight: 600 }}>
          {newCode ?? "—"} · Qty {line.new_qty ?? "—"} @ {fmtSen(line.new_unit_price_sen)}
        </div>
      ) : (
        <div style={{ marginTop: 3, fontSize: 12.5 }}>
          <div style={{ fontWeight: 600 }}>{newCode ?? "—"}</div>
          <div style={{ color: "var(--mut)", marginTop: 2 }}>
            <span style={{ textDecoration: "line-through" }}>
              Qty {old.qty ?? "—"}
              {typeof old.unit_price_sen === "number" ? ` · ${fmtSen(old.unit_price_sen)}` : ""}
              {old.delivery_date ? ` · ${formatDate(old.delivery_date)}` : ""}
            </span>
            <span style={{ color: "var(--ink)", fontWeight: 600 }}>
              {"  →  Qty "}{line.new_qty ?? old.qty ?? "—"}
              {typeof line.new_unit_price_sen === "number" ? ` · ${fmtSen(line.new_unit_price_sen)}` : ""}
              {line.new_delivery_date ? ` · ${formatDate(line.new_delivery_date)}` : ""}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

export function MobilePoAmendmentDetail({
  amendmentId,
  onBack,
}: {
  amendmentId: string;
  onBack: () => void;
}) {
  const { data, isPending, error } = usePoAmendmentDetail(amendmentId);
  const { can } = useHouzsAuth();
  const { staff: currentStaff } = useScmAuth();
  const { actorNameOf } = useStaffLookup();
  const askConfirm = useConfirm();
  const askPrompt = usePrompt();
  const notify = useNotify();

  const approve = useApprovePoAmendment();
  const rejectAmendment = useRejectPoAmendment();
  const withdrawAmendment = useWithdrawPoAmendment();

  const amendment = (data?.amendment ?? null) as (Record<string, unknown> & {
    status?: string; amendment_no?: string | null; reason?: string | null;
    requested_by?: string | null; created_at?: string | null; po_number?: string; po_id?: string;
    resolution?: string | null; rejection_reason?: string | null;
    approved_by?: string | null; approved_at?: string | null;
  }) | null;
  const lines = useMemo(() => (data?.lines ?? []) as PoAmendmentLine[], [data]);
  const purchaseOrder = data?.purchaseOrder ?? null;

  const headerDiffs = useMemo(() => {
    const changes = (amendment?.header_changes ?? null) as Record<string, string | null> | null;
    const oldSnap = (amendment?.old_header_snapshot ?? null) as Record<string, string | null> | null;
    if (!changes) return [] as Array<{ key: string; label: string; from: string; to: string }>;
    return Object.keys(changes).map((k) => ({
      key: k, label: HEADER_LABEL[k] ?? k,
      from: (oldSnap?.[k] ?? "—") || "—",
      to: (changes[k] ?? "—") || "—",
    }));
  }, [amendment]);

  const allFieldKinds = useMemo<AmendmentFieldKind[]>(() => {
    const fromLines = lines.flatMap((l) => poLineFieldKinds(l));
    const fromHeader = headerDiffs
      .map((d) => poHeaderFieldKind(d.key))
      .filter((k): k is AmendmentFieldKind => k != null);
    return [...fromLines, ...fromHeader];
  }, [lines, headerDiffs]);

  const status = String(amendment?.status ?? "");
  const poId = String(amendment?.po_id ?? purchaseOrder?.id ?? "");
  const poNumber = String(amendment?.po_number ?? "");
  const amendmentNo = amendment?.amendment_no != null ? String(amendment.amendment_no) : null;
  const reason = (amendment?.reason ?? "")?.toString().trim() || null;
  const { label: pillLabel, tone } = simplifiedAmendmentPill(status);

  const canApprove = can("scm.po_amendment.approve");
  const isRequester =
    amendment?.requested_by != null && currentStaff?.id != null
    && String(amendment.requested_by) === String(currentStaff.id);
  const canWithdraw = status === "REQUESTED" && (isRequester || canApprove);

  const deliverPrintPdf = (action: PdfAction) => {
    if (!amendment) return;
    const input = poAmendmentToPdfInput({
      amendment: {
        amendment_no: amendmentNo, status, reason,
        created_at: (amendment.created_at as string) ?? null,
        requested_by_name: actorNameOf(amendment.requested_by as string | null),
        approved_by_name: amendment.approved_by ? actorNameOf(amendment.approved_by as string) : null,
        approved_at: (amendment.approved_at as string) ?? null,
      },
      lines: lines as never,
      purchaseOrder: purchaseOrder as never,
      supplierName: null,
    });
    return Promise.resolve(generateAmendmentPdf(input, { action })).catch((e: unknown) =>
      notify({ title: "PDF generation failed", body: e instanceof Error ? e.message : "Something went wrong.", tone: "error" }));
  };
  const print = usePrintPreview(deliverPrintPdf);

  const handleApprove = async () => {
    if (!(await askConfirm({
      title: `Approve amendment for ${poNumber}?`,
      body: "This applies the requested changes and snapshots the prior revision. This cannot be undone.",
      confirmLabel: "Approve amendment",
    }))) return;
    try {
      const res = await approve.mutateAsync({ id: amendmentId, poId });
      const warnings = (res?.warnings ?? []) as string[];
      notify({ title: "PO amendment approved", body: warnings.length > 0 ? warnings.join(" ") : undefined });
    } catch (e) {
      notify({ title: "Could not approve", body: `${plainError(e)} The PO was NOT changed — please try again.`, tone: "error" });
    }
  };

  const handleReject = async () => {
    const r = await askPrompt({
      title: `Reject amendment ${amendmentNo ?? ""}?`.trim(),
      body: "The Purchase Order keeps its current revision. Say what is wrong — the requester will see this.",
      placeholder: "e.g. supplier cannot meet this cost", multiline: true, confirmLabel: "Reject amendment",
      validate: (v) => (v.trim().length < 5 ? "Give a reason the requester can act on." : null),
    });
    if (r == null) return;
    try {
      const res = await rejectAmendment.mutateAsync({ id: amendmentId, reason: r.trim(), poId });
      const released = res.releasedToStock ?? [];
      notify({
        title: "Amendment rejected",
        ...(released.length > 0
          ? { body: `Released to STOCK: ${released.map((x) => `${x.itemCode} ×${x.qty}`).join(", ")} — MRP will re-show the corrected spec as shortage.` }
          : {}),
      });
    } catch (e) {
      notify({ title: "Could not reject", body: `${plainError(e)} Nothing was changed.`, tone: "error" });
    }
  };

  const handleWithdraw = async () => {
    if (!(await askConfirm({
      title: `Withdraw amendment ${amendmentNo ?? ""}?`.trim(),
      body: "This closes the request without changing the Purchase Order. It cannot be reopened.",
      confirmLabel: "Withdraw request", danger: true,
    }))) return;
    const r = await askPrompt({
      title: "Why are you withdrawing it?", body: "Optional — recorded on the PO history.",
      placeholder: "e.g. raised against the wrong line", multiline: true, confirmLabel: "Withdraw request",
    });
    if (r == null) return;
    try {
      await withdrawAmendment.mutateAsync({ id: amendmentId, reason: r.trim() || undefined, poId });
      notify({ title: "Amendment withdrawn" });
    } catch (e) {
      notify({ title: "Could not withdraw", body: `${plainError(e)} It is still open.`, tone: "error" });
    }
  };

  return (
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      <header className="hdr">
        <div className="hdr-row">
          <button className="back" onClick={onBack}>
            <span className="chev">‹</span> PO Amendments
          </button>
          <span className="eyebrow">PO Amendment</span>
        </div>
        <div className="hdr-row" style={{ marginTop: 2 }}>
          <div className="scr-title">{amendmentNo ?? "Amendment"}</div>
          <span className={`badge ${TONE_BADGE_CLASS[tone]}`}>{pillLabel}</span>
        </div>
        <div style={{ marginTop: 3, fontSize: 12, color: "var(--mut)" }}>
          <span className="tnum" style={{ fontWeight: 700 }}>{poNumber}</span>
          {typeof purchaseOrder?.revision === "number" ? ` · r${purchaseOrder.revision}` : ""}
        </div>
        <TypeBadges kinds={allFieldKinds} />
      </header>

      <div className="hz-scroll" style={{ flex: 1, overflowY: "auto", padding: 14, paddingBottom: 40 }}>
        {isPending && <div style={{ textAlign: "center", color: "var(--mut2)", fontSize: 12, padding: "26px 0" }}>Loading…</div>}
        {error && !isPending && (
          <div style={{ textAlign: "center", color: "var(--red)", fontSize: 12, padding: "26px 0" }}>Couldn't load this amendment.</div>
        )}

        {!isPending && !error && amendment && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {status === "REJECTED" && (
              <div className="card" style={{ padding: 12, borderColor: "#e6cccc" }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--red)" }}>
                  {amendment.resolution === "WITHDRAWN" ? "Withdrawn by the requester." : "Rejected — the PO keeps its prior revision."}
                </div>
                {amendment.rejection_reason && (
                  <div style={{ marginTop: 4, fontSize: 12, color: "var(--mut)" }}>"{String(amendment.rejection_reason)}"</div>
                )}
              </div>
            )}

            {headerDiffs.length > 0 && (
              <div className="card">
                <div className="card-h"><span className="card-t">Order changes · {headerDiffs.length}</span></div>
                <div className="card-b">
                  {headerDiffs.map((d) => (
                    <div key={d.key} style={{ fontSize: 12.5, padding: "5px 0" }}>
                      <span style={{ fontWeight: 600 }}>{d.label}: </span>
                      <span style={{ textDecoration: "line-through", color: "var(--mut)" }}>{d.from}</span>
                      <span style={{ color: "var(--ink)", fontWeight: 600 }}>{"  →  "}{d.to}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="card">
              <div className="card-h"><span className="card-t">Requested changes · {lines.length}</span></div>
              <div className="card-b">
                {lines.length === 0 ? (
                  <div style={{ fontSize: 12, color: "var(--mut2)" }}>
                    {headerDiffs.length > 0 ? "Only the order details above change." : "No line changes recorded."}
                  </div>
                ) : (
                  <div>{lines.map((l) => <DiffRow key={l.id} line={l} />)}</div>
                )}
              </div>
            </div>

            {allFieldKinds.length > 0 && (
              <div className="card">
                <div className="card-h"><span className="card-t">Department routing</span></div>
                <div className="card-b" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {summariseRouting(allFieldKinds).departments.map((d) => (
                    <div key={d.department} style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 12 }}>
                      <span style={{ fontWeight: 700 }}>{d.department}</span>
                      <span style={{ color: "var(--mut)", textAlign: "right" }}>
                        {d.kinds.map((k) => FIELD_KIND_LABEL[k]).join(", ")}
                      </span>
                    </div>
                  ))}
                  <div style={{ marginTop: 2, paddingTop: 6, borderTop: "1px solid var(--line2)", fontSize: 11, color: "var(--mut2)", lineHeight: 1.4 }}>
                    Advisory — any authorized approver applies the whole amendment in one signature; the approval is recorded on the PO history.
                  </div>
                </div>
              </div>
            )}

            {reason && (
              <div className="card">
                <div className="card-h"><span className="card-t">Reason</span></div>
                <div className="card-b" style={{ fontSize: 12.5, color: "var(--mut)" }}>{reason}</div>
              </div>
            )}

            <div className="card">
              <div className="card-h"><span className="card-t">Requested by</span></div>
              <div className="card-b" style={{ fontSize: 12.5, display: "flex", flexDirection: "column", gap: 5 }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "var(--mut)" }}>Requested by</span>
                  <span style={{ fontWeight: 600 }}>{actorNameOf(amendment.requested_by as string | null)}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "var(--mut)" }}>Created</span>
                  <span style={{ fontWeight: 600 }}>{formatDate((amendment.created_at as string) ?? null)}</span>
                </div>
                {amendment.approved_by != null && (
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ color: "var(--mut)" }}>Approved by</span>
                    <span style={{ fontWeight: 600 }}>{actorNameOf(amendment.approved_by as string)}</span>
                  </div>
                )}
              </div>
            </div>

            {/* Actions */}
            <div style={{ display: "flex", flexDirection: "column", gap: 9, marginTop: 2 }}>
              <button className="btn-ghost" onClick={print.openPreview}>Print amendment</button>
              <PrintPreviewModal
                open={print.open}
                onClose={print.close}
                docTitle="Purchase Order Amendment"
                docNo={amendmentNo ?? "Amendment"}
                rows={[
                  { label: "Against PO", value: poNumber || "—" },
                  { label: "Status", value: amendmentPrintedStatus(status) },
                  { label: "Reason", value: reason || "—" },
                  { label: "Changes", value: `${lines.length} change${lines.length === 1 ? "" : "s"}` },
                ]}
                {...print.handlers}
              />
              {status === "REQUESTED" && canApprove && (
                <button className="btn" onClick={() => void handleApprove()} disabled={approve.isPending}>
                  {approve.isPending ? "Approving…" : "Approve amendment"}
                </button>
              )}
              {status === "REQUESTED" && canApprove && (
                <button className="btn-danger" onClick={() => void handleReject()} disabled={rejectAmendment.isPending}>
                  {rejectAmendment.isPending ? "Rejecting…" : "Reject amendment"}
                </button>
              )}
              {canWithdraw && (
                <button className="btn-ghost" onClick={() => void handleWithdraw()} disabled={withdrawAmendment.isPending}>
                  {withdrawAmendment.isPending ? "Withdrawing…" : "Withdraw this request"}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default MobilePoAmendmentDetail;
