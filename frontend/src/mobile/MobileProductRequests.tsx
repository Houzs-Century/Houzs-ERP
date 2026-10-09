/* ------------------------------------------------------------------------- *
 * MobileProductRequests — a new product or repack request on the phone (owner
 * 2026-10-06: to request new product / repack product; Sales 都能提, Purchaser 批;
 * 然后这个会连接 purchase consignment order).
 *
 * A salesperson on the floor asks for a product — an existing SKU, or a Model
 * the catalogue has not got, in a fabric, seat size and leg size, for a use,
 * delivered where and by when — and watches it move: Requested → Approved →
 * PC Order raised → Closed. They edit or withdraw it while it waits and fix one
 * the Purchaser rejected. The Purchaser reads every request, approves or
 * rejects it here and builds the new Model + SKU from it; the Purchase
 * Consignment Order itself is raised on the computer (PC Order New,
 * ?fromProductRequest=) — the order form is desktop-only.
 *
 * IT OWNS NO RULES. Every read and write is the desktop page's own hook
 * (vendor/scm/lib/product-request-queries.ts); the status words are its table.
 *
 * Gate: the menu row points at /scm/product-requests, whose NAV_TABS entries
 * (Sidebar.tsx — the rep leaf, or the office leaf's keys) MobileApp's allowed()
 * resolves, so phone and desktop are gated by one declaration.
 * ------------------------------------------------------------------------- */

import { useMemo, useState } from "react";
import { activeOptions, maintPickerValues } from "@2990s/shared";
import {
  APPLICATION_LABEL, REQUEST_STATUS, REQUEST_TYPE_LABEL, awaitsPurchaser, mayClose, mayRaisePco, needsModel, productText, requesterMayChange, specText,
  useApproveProductRequest, useCloseProductRequest, useCreateModelFromRequest, useCreateProductRequest, useProductRequest, useProductRequests,
  useProductRequestSupplierOptions, useRejectProductRequest, useUpdateProductRequest, useWithdrawProductRequest,
  type ProductRequest, type ProductRequestApplication, type ProductRequestInput, type ProductRequestType,
} from "../vendor/scm/lib/product-request-queries";
import { MoneyInput } from "../vendor/scm/components/MoneyInput";
import { useMfgProducts, useMaintenanceConfig, mfgCategoryLabel } from "../vendor/scm/lib/mfg-products-queries";
import { MFG_PRODUCT_CATEGORIES } from "../vendor/shared/product-categories";
import { useFabricTrackings, fabricOptionLabel } from "../vendor/scm/lib/fabric-queries";
import { useWarehouses } from "../vendor/scm/lib/inventory-queries";
import { sortByNumeric, sortByText } from "../vendor/scm/lib/sort-options";
import { DateField } from "../vendor/scm/components/DateField";
import { useConfirm, usePrompt } from "../vendor/scm/components/ConfirmDialog";
import { useNotify } from "../vendor/scm/components/NotifyDialog";
import { useAuth } from "../auth/AuthContext";
import { fmtDateOrDash, fmtSen } from "../vendor/shared/format";

type View = { t: "list" } | { t: "new" } | { t: "edit"; req: ProductRequest } | { t: "detail"; id: string };
type Filter = "all" | "waiting" | "approved" | "closed";

export function MobileProductRequests({ onBack }: { onBack: () => void }) {
  const [view, setView] = useState<View>({ t: "list" });
  if (view.t === "new") return <RequestFormScreen initial={null} onBack={() => setView({ t: "list" })} onDone={(id) => setView({ t: "detail", id })} />;
  if (view.t === "edit") return <RequestFormScreen initial={view.req} onBack={() => setView({ t: "detail", id: view.req.id })} onDone={(id) => setView({ t: "detail", id })} />;
  if (view.t === "detail") return <RequestDetailScreen id={view.id} onBack={() => setView({ t: "list" })} onEdit={(req) => setView({ t: "edit", req })} />;
  return <RequestListScreen onBack={onBack} onNew={() => setView({ t: "new" })} onOpen={(id) => setView({ t: "detail", id })} />;
}

function Shell({ eyebrow, title, onBack, footer, children }: { eyebrow: string; title: string; onBack: () => void; footer?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      <header className="hdr">
        <div className="hdr-row">
          <button className="back" onClick={onBack}><span className="chev">‹</span> Back</button>
          <span className="eyebrow">{eyebrow}</span>
        </div>
        <div className="hdr-row" style={{ marginTop: 2 }}>
          <div className="scr-title">{title}</div>
        </div>
      </header>
      <div className="hz-scroll" style={{ flex: 1, overflowY: "auto", padding: 14, paddingBottom: 40, display: "flex", flexDirection: "column", gap: 12 }}>
        {children}
      </div>
      {footer && <div className="actbar" style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>{footer}</div>}
    </div>
  );
}

const Note = ({ children }: { children: React.ReactNode }) => (
  <div style={{ padding: "18px 4px", fontSize: 12.5, color: "var(--mut)", textAlign: "center" }}>{children}</div>
);
const StatusText = ({ r }: { r: Pick<ProductRequest, "status"> }) => (
  <span style={{ fontSize: 11.5, fontWeight: 600, color: REQUEST_STATUS[r.status].tone }}>{REQUEST_STATUS[r.status].label}</span>
);

/* ── The list ─────────────────────────────────────────────────────────────── */
function RequestListScreen({ onBack, onNew, onOpen }: { onBack: () => void; onNew: () => void; onOpen: (id: string) => void }) {
  const q = useProductRequests(false);
  const rows = useMemo(() => q.data?.requests ?? [], [q.data]);
  const approver = q.data?.approver ?? false;
  const mayRequest = q.data?.mayRequest ?? false;
  const [filter, setFilter] = useState<Filter>("all");
  const shown = rows.filter((r) =>
    filter === "all" ? true
      : filter === "waiting" ? r.status === "REQUESTED"
        : filter === "approved" ? r.status === "APPROVED" || r.status === "PCO_ISSUED"
          : r.status === "REJECTED" || r.status === "WITHDRAWN" || r.status === "CLOSED");
  const chips: Array<[Filter, string]> = [["all", "All"], ["waiting", "Waiting"], ["approved", "Approved"], ["closed", "Closed"]];

  const body = () => {
    if (q.isLoading) return <Note>Loading requests…</Note>;
    if (q.isError) return <Note>Could not load the requests. Pull down or try again.</Note>;
    if (rows.length === 0) return <Note>{approver ? "No product request has been raised yet." : "You have not asked for a product yet — tap New request."}</Note>;
    if (shown.length === 0) return <Note>No request in this view.</Note>;
    return shown.map((r) => (
      <button key={r.id} type="button" className="so-row" onClick={() => onOpen(r.id)} style={{ textAlign: "left", width: "100%" }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <span style={{ fontWeight: 700, fontSize: 13 }}>{productText(r)}</span>
          <span style={{ fontWeight: 700, fontSize: 13 }}>× {r.qty}</span>
        </div>
        <div style={{ fontSize: 11.5, color: "var(--mut)", marginTop: 2 }}>
          {r.request_no} · {REQUEST_TYPE_LABEL[r.request_type]} · {fmtDateOrDash(r.created_at)}{approver && r.requested_by_name ? ` · ${r.requested_by_name}` : ""}
        </div>
        <div style={{ fontSize: 11.5, marginTop: 2 }}>{specText(r)} · {APPLICATION_LABEL[r.application]}</div>
        <div style={{ marginTop: 4 }}><StatusText r={r} />{r.pco ? <span style={{ fontSize: 11, color: "var(--mut)" }}> · {r.pco.pcNumber}</span> : null}</div>
      </button>
    ));
  };

  return (
    <Shell eyebrow="Products" title="Product Requests" onBack={onBack}
      footer={mayRequest ? <button className="btn" style={{ flex: 1 }} onClick={onNew}>New request</button> : undefined}>
      <div className="chips" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {chips.map(([key, label]) => (
          <button key={key} type="button" className={`chip${filter === key ? " on" : ""}`} aria-pressed={filter === key} onClick={() => setFilter(key)}>
            {label}{key === "waiting" ? ` (${rows.filter(awaitsPurchaser).length})` : ""}
          </button>
        ))}
      </div>
      {body()}
    </Shell>
  );
}

/* ── One request ──────────────────────────────────────────────────────────── */
function RequestDetailScreen({ id, onBack, onEdit }: { id: string; onBack: () => void; onEdit: (r: ProductRequest) => void }) {
  const { user } = useAuth();
  const me = Number(user?.id);
  const q = useProductRequest(id);
  const r = q.data?.request ?? null;
  const approver = q.data?.approver ?? false;
  const askConfirm = useConfirm();
  const askPrompt = usePrompt();
  const notify = useNotify();
  const withdraw = useWithdrawProductRequest();
  const approve = useApproveProductRequest();
  const reject = useRejectProductRequest();
  const build = useCreateModelFromRequest();
  const close = useCloseProductRequest();

  if (!r) return <Shell eyebrow="Product request" title="Request" onBack={onBack}><Note>{q.isLoading ? "Loading…" : "Could not load this request."}</Note></Shell>;
  const mine = Number(r.requested_by) === me;
  const mayChange = mine && requesterMayChange(r);

  const onWithdraw = async () => {
    if (!(await askConfirm({ title: `Withdraw ${r.request_no}?`, body: "The Purchaser will not act on it.", confirmLabel: "Withdraw", danger: true }))) return;
    withdraw.mutate(r.id);
  };
  const onApprove = async () => {
    if (!(await askConfirm({ title: `Approve ${r.request_no}?`, body: r.item_code ? `${r.item_code} × ${r.qty}.` : `${r.proposed_model_name ?? "The new Model"} is not in the catalogue yet — build the Model and SKU after approving.`, confirmLabel: "Approve" }))) return;
    approve.mutate({ id: r.id });
  };
  const onReject = async () => {
    const note = await askPrompt({ title: `Reject ${r.request_no}?`, body: "The requester reads your reason and can send it again.", confirmLabel: "Reject", input: { label: "Why it is rejected", required: true } });
    if (!note) return;
    reject.mutate({ id: r.id, note });
  };
  const onBuild = async () => {
    const code = await askPrompt({ title: "Create Model + SKU", body: `${r.proposed_model_name ?? "The new Model"} · ${mfgCategoryLabel(r.category)}${r.compartment ? ` · ${r.compartment}` : ""}. The SKU code follows (model, or model-compartment for a sofa); it lands in the catalogue but not on POS.`, confirmLabel: "Create", input: { label: "Model code", placeholder: "e.g. 5530", required: true } });
    if (!code) return;
    try {
      const res = await build.mutateAsync({ id: r.id, modelCode: code.trim() });
      void notify({ title: `${res.sku.code} created`, body: `Model ${res.model.modelCode}. Raise the Purchase Consignment Order on the computer.` });
    } catch { /* the mutation's own onError told the user */ }
  };
  const onClose = async () => {
    if (!(await askConfirm({ title: `Close ${r.request_no}?`, body: "Nothing more will be done on it.", confirmLabel: "Close request" }))) return;
    close.mutate({ id: r.id });
  };

  const row = (k: string, v: React.ReactNode) => (
    <div className="so-kv" style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 12.5 }}>
      <span style={{ color: "var(--mut)" }}>{k}</span><span style={{ textAlign: "right" }}>{v}</span>
    </div>
  );
  const footerButtons = [
    mayChange && <button key="edit" className="btn" style={{ flex: 1 }} onClick={() => onEdit(r)}>{r.status === "REJECTED" ? "Fix and send again" : "Edit"}</button>,
    mayChange && <button key="withdraw" className="btn" style={{ flex: 1, background: "var(--bg)", color: "var(--ink)" }} onClick={() => void onWithdraw()} disabled={withdraw.isPending}>Withdraw</button>,
    approver && awaitsPurchaser(r) && <button key="approve" className="btn" style={{ flex: 1 }} onClick={() => void onApprove()} disabled={approve.isPending}>Approve</button>,
    approver && awaitsPurchaser(r) && <button key="reject" className="btn-danger" style={{ flex: 1 }} onClick={() => void onReject()} disabled={reject.isPending}>Reject…</button>,
    approver && needsModel(r) && <button key="build" className="btn" style={{ flex: 1 }} onClick={() => void onBuild()} disabled={build.isPending}>Create Model + SKU</button>,
    approver && mayClose(r) && <button key="close" className="btn" style={{ flex: 1, background: "var(--bg)", color: "var(--ink)" }} onClick={() => void onClose()} disabled={close.isPending}>Close</button>,
  ].filter(Boolean);

  return (
    <Shell eyebrow="Product request" title={r.request_no} onBack={onBack} footer={footerButtons.length > 0 ? <>{footerButtons}</> : undefined}>
      <div className="card" style={{ padding: 12, display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontWeight: 700, fontSize: 14 }}>{productText(r)}</span>
          <StatusText r={r} />
        </div>
        {r.status === "REJECTED" && r.decision_note && (
          <div style={{ fontSize: 12.5, color: "var(--red)" }}>Rejected by {r.decided_by ?? "the Purchaser"}: {r.decision_note}</div>
        )}
        {approver && needsModel(r) && (
          <div style={{ fontSize: 12, color: "var(--mut)" }}>{r.proposed_model_name} is not in the catalogue yet — build the Model and SKU, then raise the Purchase Consignment Order on the computer.</div>
        )}
        {approver && mayRaisePco(r) && (
          <div style={{ fontSize: 12, color: "var(--mut)" }}>Approved. Raise the Purchase Consignment Order from this request on the computer (PC Order New).</div>
        )}
        {row("Type", REQUEST_TYPE_LABEL[r.request_type])}
        {row("Application", APPLICATION_LABEL[r.application])}
        {row("Requested by", `${r.requested_by_name ?? "—"} · ${fmtDateOrDash(r.created_at)}`)}
        {row("Category", mfgCategoryLabel(r.category))}
        {row("Compartment", r.compartment ?? "—")}
        {row("Fabric", r.fabric_code ?? "—")}
        {row("Sofa size", r.seat_size ?? "—")}
        {row("Leg size", r.leg_size ?? "—")}
        {row("Qty", r.qty)}
        {row("Deliver to", r.deliveryLocation ? `${r.deliveryLocation.name} (${r.deliveryLocation.code})` : "—")}
        {row("Expected", fmtDateOrDash(r.expected_delivery_date))}
        {row("Supplier", r.supplier ? `${r.supplier.name} (${r.supplier.code})` : "—")}
        {row("Unit price", r.unit_price_sen != null ? fmtSen(r.unit_price_sen) : "—")}
        {r.special_remarks && row("Remarks", r.special_remarks)}
        {r.status !== "REJECTED" && r.decided_by && row("Decided by", `${r.decided_by}${r.decision_note ? ` · ${r.decision_note}` : ""}`)}
        {r.pco && row("PC Order", `${r.pco.pcNumber} · ${r.pco.status.toLowerCase().replace("_", " ")}`)}
      </div>
    </Shell>
  );
}

/* ── New / edit ───────────────────────────────────────────────────────────── */
function RequestFormScreen({ initial, onBack, onDone }: { initial: ProductRequest | null; onBack: () => void; onDone: (id: string) => void }) {
  const create = useCreateProductRequest();
  const update = useUpdateProductRequest();
  const notify = useNotify();
  const [v, setV] = useState<ProductRequestInput>(() => ({
    requestType: initial?.request_type ?? "NEW_PRODUCT",
    application: initial?.application ?? "CUSTOMER_ORDER",
    itemCode: initial?.item_code ?? null,
    proposedModelName: initial?.proposed_model_name ?? null,
    category: initial?.category ?? "SOFA",
    compartment: initial?.compartment ?? null,
    fabricCode: initial?.fabric_code ?? null,
    seatSize: initial?.seat_size ?? null,
    legSize: initial?.leg_size ?? null,
    qty: initial?.qty ?? 1,
    specialRemarks: initial?.special_remarks ?? null,
    deliveryLocationId: initial?.delivery_location_id ?? null,
    expectedDeliveryDate: initial?.expected_delivery_date ?? null,
    supplierId: initial?.supplier_id ?? null,
    unitPriceSen: initial?.unit_price_sen ?? null,
  }));
  const supplierOptions = useProductRequestSupplierOptions().data?.suppliers ?? [];
  const [newModel, setNewModel] = useState<boolean>(() => !!initial && !initial.item_code);
  const set = (patch: Partial<ProductRequestInput>) => setV((prev) => ({ ...prev, ...patch }));
  const isRepack = v.requestType === "REPACK";
  const existing = isRepack || !newModel;

  const skus = useMfgProducts();
  const maint = useMaintenanceConfig("master").data?.data ?? null;
  const fabrics = useFabricTrackings().data ?? [];
  const warehouses = useWarehouses().data ?? [];
  const isSofa = v.category === "SOFA";
  const compartments = isSofa ? maintPickerValues(maint?.sofaCompartments ?? [], v.compartment ?? "") : [];
  const seatSizes = isSofa ? sortByNumeric(maintPickerValues(maint?.sofaSizes ?? [], v.seatSize ?? "")) : [];
  const legSizes = sortByNumeric(activeOptions(isSofa ? (maint?.sofaLegHeights ?? []) : (maint?.legHeights ?? []), v.legSize ?? "")).map((o) => o.value);
  const pickableFabrics = sortByText(fabrics.filter((f) => f.is_active !== false || f.fabric_code === v.fabricCode).map((f) => ({ ...f, name: fabricOptionLabel(f) })));
  const skuList = sortByText(skus.data ?? []);

  const onItemCode = (code: string) => {
    const sku = (skus.data ?? []).find((p) => p.code === code);
    set({ itemCode: code || null, proposedModelName: null, ...(sku ? { category: String(sku.category).toUpperCase() } : {}) });
  };
  const missing = [
    existing && !(v.itemCode ?? "").trim() ? "the SKU" : null,
    !existing && !(v.proposedModelName ?? "").trim() ? "the new Model's name" : null,
    v.qty > 0 ? null : "the quantity",
  ].filter(Boolean) as string[];
  const busy = create.isPending || update.isPending;

  const save = async () => {
    if (missing.length > 0) { void notify({ title: "Not yet complete", body: `Still needed: ${missing.join(", ")}.`, tone: "error" }); return; }
    const body: ProductRequestInput = {
      ...v,
      itemCode: existing ? (v.itemCode ?? "").trim() || null : null,
      proposedModelName: existing ? null : (v.proposedModelName ?? "").trim() || null,
      specialRemarks: v.specialRemarks?.trim() || null,
    };
    try {
      const res = initial ? await update.mutateAsync({ id: initial.id, ...body }) : await create.mutateAsync(body);
      onDone(res.request.id);
    } catch { /* the mutation's own onError told the user */ }
  };

  const field = (label: string, control: React.ReactNode) => (
    <div className="st-fld" style={{ flex: "none" }}>
      <span className="st-fl">{label}</span>
      {control}
    </div>
  );
  const listInput = (label: string, key: keyof ProductRequestInput, options: string[], placeholder: string) => field(label,
    <>
      <input className="cal-sel" list={`mpr-${String(key)}`} aria-label={label} value={(v[key] as string | null) ?? ""} placeholder={placeholder}
        onChange={(e) => set({ [key]: e.target.value || null } as Partial<ProductRequestInput>)} />
      <datalist id={`mpr-${String(key)}`}>{options.map((o) => <option key={o} value={o} />)}</datalist>
    </>);

  return (
    <Shell eyebrow="Product request" title={initial ? `Edit ${initial.request_no}` : "New request"} onBack={onBack}
      footer={<button className="btn" style={{ flex: 1, opacity: busy ? 0.5 : 1 }} disabled={busy} onClick={() => void save()}>{busy ? "Sending…" : initial ? (initial.status === "REJECTED" ? "Send again" : "Save") : "Send to the Purchaser"}</button>}>
      {initial?.status === "REJECTED" && initial.decision_note && (
        <div style={{ fontSize: 12.5, color: "var(--red)" }}>The Purchaser rejected it: {initial.decision_note}</div>
      )}
      <div className="sc-sl"><span className="t">① What kind of request</span><span className="ln" /></div>
      {field("Request", (
        <select className="cal-sel" aria-label="Request type" value={v.requestType} onChange={(e) => { const t = e.target.value as ProductRequestType; set({ requestType: t }); if (t === "REPACK") setNewModel(false); }}>
          {(Object.keys(REQUEST_TYPE_LABEL) as ProductRequestType[]).map((t) => <option key={t} value={t}>{REQUEST_TYPE_LABEL[t]}</option>)}
        </select>
      ))}
      {field("Application", (
        <select className="cal-sel" aria-label="Application" value={v.application} onChange={(e) => set({ application: e.target.value as ProductRequestApplication })}>
          {(Object.keys(APPLICATION_LABEL) as ProductRequestApplication[]).map((a) => <option key={a} value={a}>{APPLICATION_LABEL[a]}</option>)}
        </select>
      ))}
      <div className="sc-sl"><span className="t">② Model</span><span className="ln" /></div>
      {!isRepack && field("Product", (
        <select className="cal-sel" aria-label="Existing SKU or new Model" value={newModel ? "new" : "existing"} onChange={(e) => { const n = e.target.value === "new"; setNewModel(n); if (n) set({ itemCode: null }); }}>
          <option value="existing">Existing SKU</option>
          <option value="new">New Model — not in the catalogue yet</option>
        </select>
      ))}
      {existing
        ? field("SKU *", <>
          <input className="cal-sel" list="mpr-skus" aria-label="SKU" value={v.itemCode ?? ""} placeholder="Type or pick a SKU code…" onChange={(e) => onItemCode(e.target.value)} />
          <datalist id="mpr-skus">{skuList.map((p) => <option key={p.id} value={p.code}>{p.name} · {mfgCategoryLabel(p.category)}</option>)}</datalist>
        </>)
        : field("New Model name *", <input className="cal-sel" aria-label="New Model name" value={v.proposedModelName ?? ""} placeholder="e.g. Aurora 2-seater" onChange={(e) => set({ proposedModelName: e.target.value || null })} />)}
      {field("Category", (
        <select className="cal-sel" aria-label="Category" value={v.category} disabled={existing && !!v.itemCode} onChange={(e) => set({ category: e.target.value })}>
          {MFG_PRODUCT_CATEGORIES.map((c) => <option key={c} value={c}>{mfgCategoryLabel(c)}</option>)}
        </select>
      ))}
      {isSofa && listInput("Compartment", "compartment", compartments, "e.g. 3S, LHF, Console")}
      <div className="sc-sl"><span className="t">③ Spec</span><span className="ln" /></div>
      {field("Fabric", <>
        <input className="cal-sel" list="mpr-fabrics" aria-label="Fabric" value={v.fabricCode ?? ""} placeholder="Type or pick a fabric code…" onChange={(e) => set({ fabricCode: e.target.value || null })} />
        <datalist id="mpr-fabrics">{pickableFabrics.map((f) => <option key={f.id} value={f.fabric_code}>{f.name}</option>)}</datalist>
      </>)}
      {listInput(isSofa ? "Sofa size (seat)" : "Size", "seatSize", seatSizes, isSofa ? "e.g. 22" : "e.g. Queen")}
      {listInput("Leg size", "legSize", legSizes, "e.g. 4")}
      {field("Qty *", <input className="cal-sel" type="number" inputMode="numeric" min={1} aria-label="Qty" value={v.qty || ""} onChange={(e) => set({ qty: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />)}
      {field("Special remarks", <textarea className="cal-sel" rows={2} aria-label="Special remarks" maxLength={2000} value={v.specialRemarks ?? ""} onChange={(e) => set({ specialRemarks: e.target.value || null })} placeholder="e.g. deeper seat, no piping" />)}
      <div className="sc-sl"><span className="t">④ Delivery</span><span className="ln" /></div>
      {field("Delivery location", (
        <select className="cal-sel" aria-label="Delivery location" value={v.deliveryLocationId ?? ""} onChange={(e) => set({ deliveryLocationId: e.target.value || null })}>
          <option value="">— pick a warehouse / showroom —</option>
          {sortByText(warehouses).map((w) => <option key={w.id} value={w.id}>{w.name} ({w.code})</option>)}
        </select>
      ))}
      {field("Expected delivery date", <DateField fullWidth className="cal-sel" aria-label="Expected delivery date" value={v.expectedDeliveryDate ?? ""} onChange={(iso) => set({ expectedDeliveryDate: iso || null })} />)}
      <div className="sc-sl"><span className="t">⑤ Supplier and price (if agreed)</span><span className="ln" /></div>
      {field("Supplier", (
        <select className="cal-sel" aria-label="Supplier" value={v.supplierId ?? ""} onChange={(e) => set({ supplierId: e.target.value || null })}>
          <option value="">— not agreed yet —</option>
          {supplierOptions.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.code})</option>)}
        </select>
      ))}
      {field("Unit price (MYR)", <MoneyInput bare valueSen={v.unitPriceSen ?? 0} onCommit={(sen) => set({ unitPriceSen: sen != null && sen > 0 ? sen : null })} inputClassName="cal-sel" selectOnFocus aria-label="Unit price" />)}
    </Shell>
  );
}

export default MobileProductRequests;
