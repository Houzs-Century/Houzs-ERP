// ----------------------------------------------------------------------------
// ProductRequests — a request for a new product or a repack (owner 2026-10-06:
// to request new product / repack product — Application, Model, Compartment,
// Fabric, Sofa size, Leg size, Special remarks, Delivery location, Expected
// delivery date; 要审批, Purchaser 批; Sales 都能提; 然后这个会连接 purchase
// consignment order).
//
// One page, two readers:
//   • a salesperson raises a request — an existing SKU, or a Model the
//     catalogue does not have yet, in a fabric, seat size and leg size, for a
//     use, delivered where and by when — and watches it move: Requested →
//     Approved → PC Order raised → Closed. A rejected one says why; they fix
//     it and send it again, or withdraw it.
//   • the Purchaser (scm.product_request.approve) sees every request, approves
//     or rejects it, builds the new Model + SKU from it, raises the Purchase
//     Consignment Order from it (PC Order New, ?fromProductRequest=) and closes
//     it. Every rule is the server's; this page only asks.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { activeOptions, maintPickerValues } from '@2990s/shared';
import {
  APPLICATION_LABEL, REQUEST_STATUS, REQUEST_TYPE_LABEL, awaitsPurchaser, mayClose, mayRaisePco, needsModel, pcoNewFromRequestPath, productText,
  requesterMayChange, specText, useApproveProductRequest, useCloseProductRequest, useCreateModelFromRequest, useCreateProductRequest,
  useProductRequest, useProductRequests, useRejectProductRequest, useUpdateProductRequest, useWithdrawProductRequest,
  type ProductRequest, type ProductRequestApplication, type ProductRequestInput, type ProductRequestType,
} from '../../vendor/scm/lib/product-request-queries';
import { useMfgProducts, useMaintenanceConfig, mfgCategoryLabel } from '../../vendor/scm/lib/mfg-products-queries';
import { MFG_PRODUCT_CATEGORIES } from '../../vendor/shared/product-categories';
import { useFabricTrackings, fabricOptionLabel } from '../../vendor/scm/lib/fabric-queries';
import { useWarehouses } from '../../vendor/scm/lib/inventory-queries';
import { sortByNumeric, sortByText } from '../../vendor/scm/lib/sort-options';
import { Modal } from '../../vendor/scm/components/Modal';
import { DateField } from '../../vendor/scm/components/DateField';
import { NumberInput } from '../../vendor/scm/components/NumberInput';
import { useConfirm, usePrompt } from '../../vendor/scm/components/ConfirmDialog';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { useAuth as useHouzsAuth } from '../../auth/AuthContext';
import { DataTable, type Column } from '../../components/DataTable';
import { PageHeader } from '../../components/Layout';
import { fmtDateOrDash } from '../../vendor/shared/format';
import styles from './SalesOrderDetail.module.css';

const soft: React.CSSProperties = { fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' };
const mono: React.CSSProperties = { fontFamily: 'var(--font-mono)' };
const linkBtn: React.CSSProperties = { background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--c-orange)', textDecoration: 'underline' };

const StatusChip = ({ r }: { r: Pick<ProductRequest, 'status'> }) => (
  <span style={{ fontSize: 'var(--fs-11)', fontWeight: 600, color: REQUEST_STATUS[r.status].tone, whiteSpace: 'nowrap' }}>{REQUEST_STATUS[r.status].label}</span>
);

type Filter = 'all' | 'waiting' | 'approved' | 'issued' | 'closed';
const FILTERS: Array<[Filter, string]> = [['all', 'All'], ['waiting', 'Waiting for the Purchaser'], ['approved', 'Approved'], ['issued', 'PC Order raised'], ['closed', 'Rejected / withdrawn / closed']];
const inFilter = (r: ProductRequest, f: Filter): boolean => {
  if (f === 'all') return true;
  if (f === 'waiting') return r.status === 'REQUESTED';
  if (f === 'approved') return r.status === 'APPROVED';
  if (f === 'issued') return r.status === 'PCO_ISSUED';
  return r.status === 'REJECTED' || r.status === 'WITHDRAWN' || r.status === 'CLOSED';
};

const Meta = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <div>
    <div style={{ ...soft, textTransform: 'uppercase', letterSpacing: '0.04em', fontSize: 'var(--fs-11)' }}>{label}</div>
    <div>{value}</div>
  </div>
);

export const ProductRequests = () => {
  const { user } = useHouzsAuth();
  const me = Number(user?.id);
  const navigate = useNavigate();
  const askConfirm = useConfirm();
  const askPrompt = usePrompt();
  const notify = useNotify();
  const [mineOnly, setMineOnly] = useState(false);
  const listQ = useProductRequests(mineOnly);
  const approver = listQ.data?.approver ?? false;
  const mayRequest = listQ.data?.mayRequest ?? false;
  const [filter, setFilter] = useState<Filter>('all');
  const rows = useMemo(() => listQ.data?.requests ?? [], [listQ.data]);
  const visible = useMemo(() => rows.filter((r) => inFilter(r, filter)), [rows, filter]);

  const [openId, setOpenId] = useState<string | null>(null);
  const detailQ = useProductRequest(openId);
  const detail = detailQ.data?.request ?? null;
  const [form, setForm] = useState<{ mode: 'new' } | { mode: 'edit'; req: ProductRequest } | null>(null);
  const [buildFor, setBuildFor] = useState<ProductRequest | null>(null);
  const withdraw = useWithdrawProductRequest();
  const approve = useApproveProductRequest();
  const reject = useRejectProductRequest();
  const close = useCloseProductRequest();

  const columns = useMemo<Column<ProductRequest>[]>(() => [
    { key: 'no', label: 'No.', render: (r) => <button type="button" onClick={() => setOpenId(r.id)} style={{ ...linkBtn, ...mono }}>{r.request_no}</button>, getValue: (r) => r.request_no },
    { key: 'date', label: 'Date', render: (r) => fmtDateOrDash(r.created_at), getValue: (r) => r.created_at, exportFormat: 'date' },
    { key: 'type', label: 'Type', render: (r) => REQUEST_TYPE_LABEL[r.request_type], getValue: (r) => REQUEST_TYPE_LABEL[r.request_type] },
    ...(approver ? [{ key: 'by', label: 'Requested by', render: (r: ProductRequest) => r.requested_by_name ?? '—', getValue: (r: ProductRequest) => r.requested_by_name ?? '' }] : []),
    { key: 'product', label: 'Model / SKU', render: (r) => <span style={mono}>{productText(r)}</span>, getValue: (r) => productText(r) },
    { key: 'spec', label: 'Spec', width: '260px', render: (r) => specText(r), getValue: (r) => specText(r) },
    { key: 'qty', label: 'Qty', align: 'right', render: (r) => r.qty, getValue: (r) => r.qty },
    { key: 'application', label: 'For', render: (r) => APPLICATION_LABEL[r.application], getValue: (r) => APPLICATION_LABEL[r.application] },
    { key: 'where', label: 'Deliver to', render: (r) => r.deliveryLocation?.name ?? '—', getValue: (r) => r.deliveryLocation?.name ?? '' },
    { key: 'when', label: 'Expected', render: (r) => fmtDateOrDash(r.expected_delivery_date), getValue: (r) => r.expected_delivery_date, exportFormat: 'date' },
    { key: 'status', label: 'Status', render: (r) => (
      <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 2 }}>
        <StatusChip r={r} />
        {r.pco && <span style={{ ...soft, ...mono }}>{r.pco.pcNumber}</span>}
      </span>
    ), getValue: (r) => REQUEST_STATUS[r.status].label },
  ], [approver]);

  const mine = (r: ProductRequest) => Number(r.requested_by) === me;
  const mayChange = (r: ProductRequest) => mine(r) && requesterMayChange(r);

  const onWithdraw = async (r: ProductRequest) => {
    const ok = await askConfirm({ title: `Withdraw ${r.request_no}?`, body: 'The Purchaser will not act on it. You can raise a new request later.', confirmLabel: 'Withdraw', danger: true });
    if (!ok) return;
    withdraw.mutate(r.id);
  };
  const onApprove = async (r: ProductRequest) => {
    const ok = await askConfirm({
      title: `Approve ${r.request_no}?`,
      body: r.item_code
        ? `${r.item_code} × ${r.qty} — a Purchase Consignment Order can then be raised from it.`
        : `${r.proposed_model_name ?? 'The new Model'} is not in the catalogue yet — after approving, build the Model and SKU from the request, then raise the Purchase Consignment Order.`,
      confirmLabel: 'Approve',
    });
    if (!ok) return;
    approve.mutate({ id: r.id }, { onSuccess: (res) => { if (res.needsModel) void notify({ title: 'Approved', body: 'Build the Model and SKU next — the request has a button for it.' }); } });
  };
  const onReject = async (r: ProductRequest) => {
    const note = await askPrompt({
      title: `Reject ${r.request_no}?`,
      body: `${r.requested_by_name ?? 'The requester'} reads your reason, fixes the request and can send it again.`,
      confirmLabel: 'Reject',
      input: { label: 'Why it is rejected', placeholder: 'e.g. 5530 already comes in this fabric — pick that SKU', required: true },
    });
    if (!note) return;
    reject.mutate({ id: r.id, note });
  };
  const onClose = async (r: ProductRequest) => {
    const ok = await askConfirm({ title: `Close ${r.request_no}?`, body: 'Nothing more will be done on it. The PC Order, if any, stays as it is.', confirmLabel: 'Close request' });
    if (!ok) return;
    close.mutate({ id: r.id });
  };

  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Products" title="Product Requests · 新品 / 重新包装申请" />
      <section className={styles.card}>
        <div className={styles.cardHeader} style={{ flexWrap: 'wrap', gap: 'var(--space-3)' }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {FILTERS.map(([key, label]) => (
              <button key={key} type="button" onClick={() => setFilter(key)} aria-pressed={filter === key}
                style={{ padding: '4px 10px', borderRadius: 999, border: '1px solid var(--line)', background: filter === key ? 'var(--c-orange)' : 'transparent', color: filter === key ? '#fff' : 'inherit', fontSize: 'var(--fs-12)', cursor: 'pointer' }}>
                {label}{key === 'waiting' ? ` (${rows.filter(awaitsPurchaser).length})` : ''}
              </button>
            ))}
          </div>
          {approver && (
            <label style={{ ...soft, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={mineOnly} onChange={(e) => setMineOnly(e.target.checked)} aria-label="Only my requests" />
              only my requests
            </label>
          )}
          <span style={{ flex: 1 }} />
          {mayRequest && (
            <Button variant="primary" size="sm" onClick={() => setForm({ mode: 'new' })}>
              <Plus size={16} strokeWidth={1.75} /> New request
            </Button>
          )}
        </div>
        <div className={styles.cardBody}>
          <DataTable<ProductRequest>
            tableId="product-requests"
            exportName="product-requests"
            columns={columns}
            rows={listQ.data ? visible : null}
            loading={listQ.isLoading}
            error={listQ.isError ? `The requests could not be loaded — ${listQ.error instanceof Error ? listQ.error.message : 'something went wrong.'}` : null}
            emptyLabel={rows.length > 0 ? 'No request in this view — pick another filter.' : (approver ? 'No product request has been raised yet.' : 'You have not raised a product request yet — New request asks the Purchaser for a new product or a repack.')}
            getRowKey={(r) => r.id}
            getRowStyle={(r) => (r.status === 'WITHDRAWN' || r.status === 'CLOSED' ? { opacity: 0.55 } : undefined)}
          />
        </div>
      </section>

      {openId && detail && (
        <Modal
          title={`${detail.request_no} · ${productText(detail)}`}
          onClose={() => setOpenId(null)}
          width="min(820px, 100%)"
          ariaLabel={`Product request ${detail.request_no}`}
          actions={(
            <>
              <StatusChip r={detail} />
              {mayChange(detail) && (
                <Button variant="secondary" size="sm" onClick={() => setForm({ mode: 'edit', req: detail })}>{detail.status === 'REJECTED' ? 'Fix and send again' : 'Edit'}</Button>
              )}
              {mayChange(detail) && (
                <Button variant="ghost" size="sm" onClick={() => void onWithdraw(detail)} disabled={withdraw.isPending}>Withdraw</Button>
              )}
              {approver && awaitsPurchaser(detail) && (
                <Button variant="primary" size="sm" onClick={() => void onApprove(detail)} disabled={approve.isPending}>Approve</Button>
              )}
              {approver && awaitsPurchaser(detail) && (
                <Button variant="ghost" size="sm" onClick={() => void onReject(detail)} disabled={reject.isPending}>Reject…</Button>
              )}
              {approver && needsModel(detail) && (
                <Button variant="primary" size="sm" onClick={() => setBuildFor(detail)}>Create Model + SKU</Button>
              )}
              {approver && mayRaisePco(detail) && (
                <Button variant="primary" size="sm" onClick={() => navigate(pcoNewFromRequestPath(detail.id))}>Raise PC Order</Button>
              )}
              {approver && mayClose(detail) && (
                <Button variant="ghost" size="sm" onClick={() => void onClose(detail)} disabled={close.isPending}>Close request</Button>
              )}
              {detail.pco && (
                <Link to={`/scm/purchase-consignment-orders/${detail.pco.id}`} style={{ fontSize: 'var(--fs-12)', color: 'var(--c-orange)' }}>Open {detail.pco.pcNumber} →</Link>
              )}
            </>
          )}
        >
          {detail.status === 'REJECTED' && detail.decision_note && (
            <div style={{ padding: 'var(--space-3)', borderRadius: 8, background: 'var(--c-cream, #faf8f3)', color: 'var(--c-festive-b, #B8331F)', fontSize: 'var(--fs-13)' }}>
              Rejected by {detail.decided_by ?? 'the Purchaser'}{detail.decided_at ? ` on ${fmtDateOrDash(detail.decided_at)}` : ''}: {detail.decision_note}
            </div>
          )}
          {needsModel(detail) && approver && (
            <div style={{ padding: 'var(--space-3)', borderRadius: 8, background: 'var(--c-cream, #faf8f3)', fontSize: 'var(--fs-13)' }}>
              {detail.proposed_model_name} is not in the catalogue yet. Build the Model and its first SKU from this request, then raise the Purchase Consignment Order — a consignment receive books stock by SKU code.
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 'var(--space-3)', fontSize: 'var(--fs-13)' }}>
            <Meta label="Requested by" value={`${detail.requested_by_name ?? '—'} · ${fmtDateOrDash(detail.created_at)}`} />
            <Meta label="Type" value={REQUEST_TYPE_LABEL[detail.request_type]} />
            <Meta label="Application" value={APPLICATION_LABEL[detail.application]} />
            <Meta label="Model / SKU" value={<span style={mono}>{productText(detail)}{detail.model ? <span style={soft}> · Model {detail.model.modelCode}</span> : null}</span>} />
            <Meta label="Category" value={mfgCategoryLabel(detail.category)} />
            <Meta label="Compartment" value={detail.compartment ?? '—'} />
            <Meta label="Fabric" value={detail.fabric_code ?? '—'} />
            <Meta label="Sofa size" value={detail.seat_size ?? '—'} />
            <Meta label="Leg size" value={detail.leg_size ?? '—'} />
            <Meta label="Qty" value={detail.qty} />
            <Meta label="Delivery location" value={detail.deliveryLocation ? `${detail.deliveryLocation.name} (${detail.deliveryLocation.code})` : '—'} />
            <Meta label="Expected delivery" value={fmtDateOrDash(detail.expected_delivery_date)} />
            {detail.special_remarks && <Meta label="Special remarks" value={detail.special_remarks} />}
            {detail.status !== 'REJECTED' && detail.decided_by && (
              <Meta label="Decided by" value={`${detail.decided_by}${detail.decided_at ? ` · ${fmtDateOrDash(detail.decided_at)}` : ''}${detail.decision_note ? ` · ${detail.decision_note}` : ''}`} />
            )}
            <Meta label="PC Order" value={detail.pco ? <>{detail.pco.pcNumber} <span style={soft}>· {detail.pco.status.toLowerCase().replace('_', ' ')}</span></> : '—'} />
          </div>
        </Modal>
      )}

      {buildFor && (
        <Modal title={`Create Model + SKU — ${buildFor.request_no}`} onClose={() => setBuildFor(null)} width="min(560px, 100%)" ariaLabel="Create Model and SKU">
          <BuildModelForm request={buildFor} onDone={() => setBuildFor(null)} onCancel={() => setBuildFor(null)} />
        </Modal>
      )}

      {form && (
        <Modal title={form.mode === 'new' ? 'New product request' : `Edit ${form.req.request_no}`} onClose={() => setForm(null)} width="min(760px, 100%)"
          ariaLabel={form.mode === 'new' ? 'New product request' : `Edit ${form.req.request_no}`}>
          <RequestForm initial={form.mode === 'edit' ? form.req : null} onDone={(id) => { setForm(null); setOpenId(id); }} onCancel={() => setForm(null)} />
        </Modal>
      )}
    </div>
  );
};

/* ── The Purchaser builds the new Model + its first SKU ─────────────────── */
function BuildModelForm({ request, onDone, onCancel }: { request: ProductRequest; onDone: () => void; onCancel: () => void }) {
  const build = useCreateModelFromRequest();
  const notify = useNotify();
  const [modelCode, setModelCode] = useState('');
  const [skuCode, setSkuCode] = useState('');
  const [name, setName] = useState(request.proposed_model_name ?? '');
  const code = modelCode.trim().toUpperCase().replace(/\s+/g, '-');
  const comp = (request.compartment ?? '').trim().toUpperCase().replace(/\s+/g, '-');
  const defaultSku = request.category === 'SOFA' && comp ? `${code}-${comp}` : code;
  const save = async () => {
    if (!code) { void notify({ title: 'Not yet complete', body: 'Give the new Model a code.', tone: 'error' }); return; }
    try {
      const res = await build.mutateAsync({ id: request.id, modelCode: code, skuCode: skuCode.trim() || null, name: name.trim() || null });
      void notify({ title: `${res.sku.code} created`, body: `Model ${res.model.modelCode} · the SKU is in the catalogue but not on POS until someone turns it on. Raise the Purchase Consignment Order next.` });
      onDone();
    } catch { /* the mutation's own onError told the user */ }
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
      <div style={soft}>Requested: {request.proposed_model_name} · {mfgCategoryLabel(request.category)}{request.compartment ? ` · ${request.compartment}` : ''}</div>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>Model code *</span>
        <input className={styles.fieldInput} value={modelCode} onChange={(e) => setModelCode(e.target.value)} aria-label="Model code" placeholder="e.g. 5530" style={mono} />
      </label>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>Model name</span>
        <input className={styles.fieldInput} value={name} onChange={(e) => setName(e.target.value)} aria-label="Model name" />
      </label>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>SKU code</span>
        <input className={styles.fieldInput} value={skuCode} onChange={(e) => setSkuCode(e.target.value)} aria-label="SKU code" placeholder={defaultSku || 'model code, or model-compartment for a sofa'} style={mono} />
      </label>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button variant="primary" size="sm" onClick={() => void save()} disabled={build.isPending}>{build.isPending ? 'Creating…' : 'Create Model + SKU'}</Button>
      </div>
    </div>
  );
}

/* ── New / edit ─────────────────────────────────────────────────────────── */
export function RequestForm({ initial, onDone, onCancel }: { initial: ProductRequest | null; onDone: (id: string) => void; onCancel: () => void }) {
  const notify = useNotify();
  const create = useCreateProductRequest();
  const update = useUpdateProductRequest();
  const [v, setV] = useState<ProductRequestInput>(() => ({
    requestType: initial?.request_type ?? 'NEW_PRODUCT',
    application: initial?.application ?? 'CUSTOMER_ORDER',
    itemCode: initial?.item_code ?? null,
    proposedModelName: initial?.proposed_model_name ?? null,
    category: initial?.category ?? 'SOFA',
    compartment: initial?.compartment ?? null,
    fabricCode: initial?.fabric_code ?? null,
    seatSize: initial?.seat_size ?? null,
    legSize: initial?.leg_size ?? null,
    qty: initial?.qty ?? 1,
    specialRemarks: initial?.special_remarks ?? null,
    deliveryLocationId: initial?.delivery_location_id ?? null,
    expectedDeliveryDate: initial?.expected_delivery_date ?? null,
  }));
  /* Existing SKU, or a Model the catalogue has not got — a repack is always existing. */
  const [newModel, setNewModel] = useState<boolean>(() => !!initial && !initial.item_code);
  const set = (patch: Partial<ProductRequestInput>) => setV((prev) => ({ ...prev, ...patch }));
  const isRepack = v.requestType === 'REPACK';
  const existing = isRepack || !newModel;

  const skus = useMfgProducts();
  const maint = useMaintenanceConfig('master').data?.data ?? null;
  const fabrics = useFabricTrackings().data ?? [];
  const warehouses = useWarehouses().data ?? [];
  const skuList = useMemo(() => sortByText((skus.data ?? []).filter((p) => !existing || !v.category || String(p.category).toUpperCase() === v.category || !!v.itemCode)), [skus.data, existing, v.category, v.itemCode]);
  const isSofa = v.category === 'SOFA';
  const compartments = isSofa ? maintPickerValues(maint?.sofaCompartments ?? [], v.compartment ?? '') : [];
  const seatSizes = isSofa ? sortByNumeric(maintPickerValues(maint?.sofaSizes ?? [], v.seatSize ?? '')) : [];
  const legSizes = sortByNumeric(activeOptions(isSofa ? (maint?.sofaLegHeights ?? []) : (maint?.legHeights ?? []), v.legSize ?? '')).map((o) => o.value);
  const pickableFabrics = sortByText(fabrics.filter((f) => f.is_active !== false || f.fabric_code === v.fabricCode).map((f) => ({ ...f, name: fabricOptionLabel(f) })));

  const onItemCode = (code: string) => {
    const sku = (skus.data ?? []).find((p) => p.code === code);
    set({ itemCode: code || null, proposedModelName: null, ...(sku ? { category: String(sku.category).toUpperCase() } : {}) });
  };

  const missing = [
    existing && !(v.itemCode ?? '').trim() ? (isRepack ? 'the SKU being re-packed' : 'the SKU') : null,
    !existing && !(v.proposedModelName ?? '').trim() ? 'the new Model\'s name' : null,
    v.qty > 0 ? null : 'the quantity',
  ].filter(Boolean) as string[];
  const saving = create.isPending || update.isPending;

  const save = async () => {
    if (missing.length > 0) { void notify({ title: 'Not yet complete', body: `Still needed: ${missing.join(', ')}.`, tone: 'error' }); return; }
    const body: ProductRequestInput = {
      ...v,
      itemCode: existing ? (v.itemCode ?? '').trim() || null : null,
      proposedModelName: existing ? null : (v.proposedModelName ?? '').trim() || null,
      specialRemarks: v.specialRemarks?.trim() || null,
    };
    try {
      const res = initial ? await update.mutateAsync({ id: initial.id, ...body }) : await create.mutateAsync(body);
      onDone(res.request.id);
    } catch { /* the mutation's own onError told the user */ }
  };

  const grid = (min: number): React.CSSProperties => ({ display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(${min}px, 1fr))`, gap: 'var(--space-3)' });
  const pickerInput = (label: string, key: keyof ProductRequestInput, options: string[], placeholder: string) => (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      <input className={styles.fieldInput} list={`pr-${String(key)}`} value={(v[key] as string | null) ?? ''} onChange={(e) => set({ [key]: e.target.value || null } as Partial<ProductRequestInput>)} aria-label={label} placeholder={placeholder} />
      <datalist id={`pr-${String(key)}`}>{options.map((o) => <option key={o} value={o} />)}</datalist>
    </label>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {initial?.status === 'REJECTED' && initial.decision_note && (
        <div style={{ color: 'var(--c-festive-b, #B8331F)', fontSize: 'var(--fs-13)' }}>The Purchaser rejected it: {initial.decision_note}</div>
      )}

      <FormSection n={1} title="申请类型 · What kind of request" first>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 'var(--fs-13)' }}>
          {(['NEW_PRODUCT', 'REPACK'] as ProductRequestType[]).map((t) => (
            <label key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <input type="radio" name="pr-type" checked={v.requestType === t} onChange={() => { set({ requestType: t }); if (t === 'REPACK') setNewModel(false); }} aria-label={REQUEST_TYPE_LABEL[t]} />
              {REQUEST_TYPE_LABEL[t]}{t === 'REPACK' ? <span style={soft}> — re-pack an existing SKU (service)</span> : null}
            </label>
          ))}
        </div>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Application · 用途 *</span>
          <select className={styles.fieldInput} value={v.application} onChange={(e) => set({ application: e.target.value as ProductRequestApplication })} aria-label="Application">
            {(Object.keys(APPLICATION_LABEL) as ProductRequestApplication[]).map((a) => <option key={a} value={a}>{APPLICATION_LABEL[a]}</option>)}
          </select>
        </label>
      </FormSection>

      <FormSection n={2} title="型号 · Model" required>
        {!isRepack && (
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 'var(--fs-13)' }}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <input type="radio" name="pr-model-kind" checked={!newModel} onChange={() => setNewModel(false)} aria-label="Existing SKU" /> Existing SKU
            </label>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <input type="radio" name="pr-model-kind" checked={newModel} onChange={() => { setNewModel(true); set({ itemCode: null }); }} aria-label="New Model" /> New Model — not in the catalogue yet
            </label>
          </div>
        )}
        <div style={grid(200)}>
          {existing ? (
            <label className={styles.field}>
              <span className={styles.fieldLabel}>SKU *</span>
              <input className={styles.fieldInput} list="pr-skus" value={v.itemCode ?? ''} onChange={(e) => onItemCode(e.target.value)} aria-label="SKU" placeholder="Type or pick a SKU code…" style={mono} />
              <datalist id="pr-skus">{skuList.map((p) => <option key={p.id} value={p.code}>{p.name} · {mfgCategoryLabel(p.category)}</option>)}</datalist>
            </label>
          ) : (
            <label className={styles.field}>
              <span className={styles.fieldLabel}>New Model name *</span>
              <input className={styles.fieldInput} value={v.proposedModelName ?? ''} onChange={(e) => set({ proposedModelName: e.target.value || null })} aria-label="New Model name" placeholder="e.g. Aurora 2-seater" />
            </label>
          )}
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Category</span>
            <select className={styles.fieldInput} value={v.category} onChange={(e) => set({ category: e.target.value })} aria-label="Category" disabled={existing && !!v.itemCode}>
              {MFG_PRODUCT_CATEGORIES.map((c) => <option key={c} value={c}>{mfgCategoryLabel(c)}</option>)}
            </select>
          </label>
          {isSofa && pickerInput('Compartment', 'compartment', compartments, 'e.g. 3S, LHF, Console')}
        </div>
      </FormSection>

      <FormSection n={3} title="规格 · Spec">
        <div style={grid(180)}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Fabric</span>
            <input className={styles.fieldInput} list="pr-fabrics" value={v.fabricCode ?? ''} onChange={(e) => set({ fabricCode: e.target.value || null })} aria-label="Fabric" placeholder="Type or pick a fabric code…" style={mono} />
            <datalist id="pr-fabrics">{pickableFabrics.map((f) => <option key={f.id} value={f.fabric_code}>{f.name}</option>)}</datalist>
          </label>
          {pickerInput(isSofa ? 'Sofa size (seat)' : 'Size', 'seatSize', seatSizes, isSofa ? 'e.g. 22' : 'e.g. Queen')}
          {pickerInput('Leg size', 'legSize', legSizes, 'e.g. 4')}
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Qty *</span>
            <NumberInput value={v.qty} sign="unsigned" decimal={false} onValueChange={(n) => set({ qty: n ?? 0 })} className={styles.fieldInput} aria-label="Qty" style={{ textAlign: 'right' }} />
          </label>
        </div>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Special remarks · 特别要求</span>
          <textarea className={styles.fieldInput} rows={2} value={v.specialRemarks ?? ''} onChange={(e) => set({ specialRemarks: e.target.value || null })} aria-label="Special remarks" maxLength={2000} placeholder="e.g. deeper seat, no piping, firm cushion" />
        </label>
      </FormSection>

      <FormSection n={4} title="交货 · Delivery">
        <div style={grid(200)}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Delivery location</span>
            <select className={styles.fieldInput} value={v.deliveryLocationId ?? ''} onChange={(e) => set({ deliveryLocationId: e.target.value || null })} aria-label="Delivery location">
              <option value="">— pick a warehouse / showroom —</option>
              {sortByText(warehouses).map((w) => <option key={w.id} value={w.id}>{w.name} ({w.code})</option>)}
            </select>
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Expected delivery date</span>
            <DateField fullWidth value={v.expectedDeliveryDate ?? ''} onChange={(iso) => set({ expectedDeliveryDate: iso || null })} className={styles.fieldInput} aria-label="Expected delivery date"
              style={{ background: '#fff', border: '1px solid #d6d9d2', borderRadius: 8 }} />
          </label>
        </div>
      </FormSection>

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', paddingTop: 'var(--space-3)' }}>
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button variant="primary" size="sm" onClick={() => void save()} disabled={saving}>
          {saving ? 'Sending…' : initial ? (initial.status === 'REJECTED' ? 'Send again' : 'Save') : 'Send to the Purchaser'}
        </Button>
      </div>
    </div>
  );
}

function FormSection({ n, title, required = false, first = false, children }: { n: number; title: string; required?: boolean; first?: boolean; children: React.ReactNode }) {
  return (
    <section aria-label={title} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', padding: 'var(--space-4, 16px) 0', borderTop: first ? 'none' : '1px solid var(--line, #ece9e2)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, fontSize: 'var(--fs-14, 14px)' }}>
        <span aria-hidden="true" style={{ width: 22, height: 22, borderRadius: '50%', background: 'var(--c-secondary-a, #2F5D4F)', color: '#fff', fontSize: 12, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{n}</span>
        <span>{title}{required && <span style={{ color: 'var(--c-festive-b, #B8331F)' }}> *</span>}</span>
      </div>
      {children}
    </section>
  );
}

export default ProductRequests;
