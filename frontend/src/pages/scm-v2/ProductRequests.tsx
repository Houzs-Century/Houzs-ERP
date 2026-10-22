// ----------------------------------------------------------------------------
// ProductRequests — a request for new products or repacks (owner 2026-10-06:
// to request new product / repack product — Application, Model,
// Fabric, Sofa size, Leg size, Special remarks, Delivery location, Expected
// delivery date; 要审批, Purchaser 批; Sales 都能提; 然后这个会连接 purchase
// consignment order. 2026-10-15, 方案 A: a request is a header plus LINES, the
// shape a Purchase Consignment Order has, so dozens of showroom pieces go in
// one request and come out as one PC Order).
//
// One page, two readers:
//   • a salesperson raises a request — each line an existing SKU, or a Model
//     the catalogue does not have yet, in a fabric, seat size and leg size —
//     for a use, delivered where and by when — and watches it move: Requested →
//     Approved → PC Order raised → Closed. A rejected one says why; they fix
//     it and send it again, or withdraw it.
//   • the Purchaser (scm.product_request.approve) sees every request, approves
//     or rejects it as a whole, builds each new-Model line's Model + SKU,
//     raises the Purchase Consignment Order from it (PC Order New,
//     ?fromProductRequest=) and closes it. Every rule is the server's; this
//     page only asks.
// ----------------------------------------------------------------------------

import { useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Paperclip, Plus, Trash2 } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { activeOptions, maintPickerValues } from '@2990s/shared';
import {
  APPLICATION_LABEL, REQUEST_STATUS, REQUEST_TYPE_LABEL, awaitsPurchaser, emptyRequestLine, lineProductText, lineToInput, linesNeedingModel,
  mayClose, mayRaisePco, needsModel, pcoNewFromRequestPath, productText, requesterMayChange, specText, totalQty,
  fetchProductRequestFileBlobUrl, useApproveProductRequest, useCloseProductRequest, useCreateModelFromRequest, useCreateProductRequest, useDeleteProductRequestFile,
  useProductRequest, useProductRequestFiles, useProductRequestSupplierOptions, useProductRequests, useRejectProductRequest, useUpdateProductRequest, useUploadProductRequestFile, useWithdrawProductRequest,
  type ProductRequest, type ProductRequestApplication, type ProductRequestInput, type ProductRequestLine, type ProductRequestLineInput, type ProductRequestType,
} from '../../vendor/scm/lib/product-request-queries';
import { useMfgProducts, useMaintenanceConfig, mfgCategoryLabel } from '../../vendor/scm/lib/mfg-products-queries';
import { MFG_PRODUCT_CATEGORIES } from '../../vendor/shared/product-categories';
import { useFabricTrackings, fabricOptionLabel } from '../../vendor/scm/lib/fabric-queries';
import { useWarehouses } from '../../vendor/scm/lib/inventory-queries';
import { sortByNumeric, sortByText } from '../../vendor/scm/lib/sort-options';
import { Modal } from '../../vendor/scm/components/Modal';
import { DocFilesCard } from '../../vendor/scm/components/DocFilesCard';
import { fileToBase64, PV_FILE_ACCEPT, type PvFilePayload } from '../../vendor/scm/lib/payment-voucher-queries';
import { docFileMime } from '../../vendor/scm/lib/doc-file-mime';
import { takePickedFiles } from '../../vendor/scm/lib/pick-files';
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
/* The line tables draw their own skin: SalesOrderDetail's .table pins
   nth-child widths for the sales-line layout, which these columns are not. */
const lineTable: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-12)' };
const th: React.CSSProperties = { fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', textAlign: 'left', padding: '4px 6px', background: '#e3e6e0', borderBottom: '2px solid #d6d9d2', whiteSpace: 'nowrap' };
const td: React.CSSProperties = { padding: '4px 6px', borderBottom: '1px solid var(--line, #ece9e2)', verticalAlign: 'top' };

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
  const [buildFor, setBuildFor] = useState<{ request: ProductRequest; line: ProductRequestLine } | null>(null);
  const withdraw = useWithdrawProductRequest();
  const approve = useApproveProductRequest();
  const reject = useRejectProductRequest();
  const close = useCloseProductRequest();

  const columns = useMemo<Column<ProductRequest>[]>(() => [
    { key: 'no', label: 'No.', render: (r) => <button type="button" onClick={() => setOpenId(r.id)} style={{ ...linkBtn, ...mono }}>{r.request_no}</button>, getValue: (r) => r.request_no },
    { key: 'date', label: 'Date', render: (r) => fmtDateOrDash(r.created_at), getValue: (r) => r.created_at, exportFormat: 'date' },
    { key: 'type', label: 'Type', render: (r) => REQUEST_TYPE_LABEL[r.request_type], getValue: (r) => REQUEST_TYPE_LABEL[r.request_type] },
    ...(approver ? [{ key: 'by', label: 'Requested by', render: (r: ProductRequest) => r.requested_by_name ?? '—', getValue: (r: ProductRequest) => r.requested_by_name ?? '' }] : []),
    { key: 'product', label: 'Products', render: (r) => <span style={mono}>{productText(r)}</span>, getValue: (r) => r.lines.map(lineProductText).join('; ') },
    { key: 'lines', label: 'Lines', align: 'right', render: (r) => r.lines.length, getValue: (r) => r.lines.length },
    { key: 'qty', label: 'Qty', align: 'right', render: (r) => totalQty(r), getValue: (r) => totalQty(r) },
    { key: 'application', label: 'For', render: (r) => APPLICATION_LABEL[r.application], getValue: (r) => APPLICATION_LABEL[r.application] },
    { key: 'supplier', label: 'Supplier', render: (r) => r.supplier?.name ?? '—', getValue: (r) => r.supplier?.name ?? '' },
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
    const pending = linesNeedingModel(r).length;
    const ok = await askConfirm({
      title: `Approve ${r.request_no}?`,
      body: pending === 0
        ? `${r.lines.length} line${r.lines.length === 1 ? '' : 's'}, ${totalQty(r)} pcs — a Purchase Consignment Order can then be raised from it.`
        : `${pending} line${pending === 1 ? '' : 's'} ask${pending === 1 ? 's' : ''} for a Model the catalogue does not have yet — after approving, build the Model and SKU on each of those lines, then raise the Purchase Consignment Order.`,
      confirmLabel: 'Approve',
    });
    if (!ok) return;
    approve.mutate({ id: r.id }, { onSuccess: (res) => { if (res.needsModel) void notify({ title: 'Approved', body: `Build the Model and SKU on ${res.pendingModels} line${res.pendingModels === 1 ? '' : 's'} next — each line has a button for it.` }); } });
  };
  const onReject = async (r: ProductRequest) => {
    const note = await askPrompt({
      title: `Reject ${r.request_no}?`,
      body: `${r.requested_by_name ?? 'The requester'} reads your reason, fixes the request and can send it again.`,
      confirmLabel: 'Reject',
      input: { label: 'Why it is rejected', placeholder: 'e.g. line 2: 5530 already comes in this fabric — pick that SKU', required: true },
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
      <PageHeader eyebrow="Products" title="Product Requests" />
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
            emptyLabel={rows.length > 0 ? 'No request in this view — pick another filter.' : (approver ? 'No product request has been raised yet.' : 'You have not raised a product request yet — New request asks the Purchaser for new products or a repack.')}
            getRowKey={(r) => r.id}
            getRowStyle={(r) => (r.status === 'WITHDRAWN' || r.status === 'CLOSED' ? { opacity: 0.55 } : undefined)}
          />
        </div>
      </section>

      {openId && detail && (
        <Modal
          title={`${detail.request_no} · ${productText(detail)}`}
          onClose={() => setOpenId(null)}
          width="min(1080px, 100%)"
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
              {linesNeedingModel(detail).length === 1 ? 'One line asks' : `${linesNeedingModel(detail).length} lines ask`} for a Model the catalogue does not have yet. Build the Model and its first SKU on each of those lines, then raise the Purchase Consignment Order — a consignment receive books stock by SKU code.
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 'var(--space-3)', fontSize: 'var(--fs-13)' }}>
            <Meta label="Requested by" value={`${detail.requested_by_name ?? '—'} · ${fmtDateOrDash(detail.created_at)}`} />
            <Meta label="Type" value={REQUEST_TYPE_LABEL[detail.request_type]} />
            <Meta label="Application" value={APPLICATION_LABEL[detail.application]} />
            <Meta label="Delivery location" value={detail.deliveryLocation ? `${detail.deliveryLocation.name} (${detail.deliveryLocation.code})` : '—'} />
            <Meta label="Expected delivery" value={fmtDateOrDash(detail.expected_delivery_date)} />
            <Meta label="Supplier" value={detail.supplier ? `${detail.supplier.name} (${detail.supplier.code})` : '—'} />
            {detail.special_remarks && <Meta label="Special remarks" value={detail.special_remarks} />}
            {detail.status !== 'REJECTED' && detail.decided_by && (
              <Meta label="Decided by" value={`${detail.decided_by}${detail.decided_at ? ` · ${fmtDateOrDash(detail.decided_at)}` : ''}${detail.decision_note ? ` · ${detail.decision_note}` : ''}`} />
            )}
            <Meta label="PC Order" value={detail.pco ? <>{detail.pco.pcNumber} <span style={soft}>· {detail.pco.status.toLowerCase().replace('_', ' ')}</span></> : '—'} />
          </div>
          <LinesTable
            request={detail}
            onBuild={approver && detail.status === 'APPROVED' ? (line) => setBuildFor({ request: detail, line }) : null}
          />
          <RequestFiles request={detail} canWrite={approver || mine(detail)} approver={approver} />
        </Modal>
      )}

      {buildFor && (
        <Modal title={`Create Model + SKU — ${buildFor.request.request_no} line ${buildFor.line.line_no}`} onClose={() => setBuildFor(null)} width="min(560px, 100%)" ariaLabel="Create Model and SKU">
          <BuildModelForm request={buildFor.request} line={buildFor.line} onDone={() => setBuildFor(null)} onCancel={() => setBuildFor(null)} />
        </Modal>
      )}

      {form && (
        <Modal title={form.mode === 'new' ? 'New product request' : `Edit ${form.req.request_no}`} onClose={() => setForm(null)} width="min(1180px, 100%)"
          ariaLabel={form.mode === 'new' ? 'New product request' : `Edit ${form.req.request_no}`}>
          <RequestForm initial={form.mode === 'edit' ? form.req : null} onDone={(id) => { setForm(null); setOpenId(id); }} onCancel={() => setForm(null)} />
        </Modal>
      )}
    </div>
  );
};

/* ── The request's files (owner 2026-10-15: 需要可以 attach 文件功能) ──────────
   The same card the payment request's bill uses. A requester attaches to
   their own request and removes while it waits; once the Purchaser has
   decided their files stay (the Purchaser may still remove one); a withdrawn
   or closed request takes no more. */
function RequestFiles({ request, canWrite, approver }: { request: ProductRequest; canWrite: boolean; approver: boolean }) {
  const filesQ = useProductRequestFiles(request.id);
  const upload = useUploadProductRequestFile();
  const remove = useDeleteProductRequestFile();
  return (
    <DocFilesCard
      files={filesQ.data?.files ?? []}
      canWrite={canWrite}
      locked={!approver && !requesterMayChange(request)}
      closed={request.status === 'WITHDRAWN' || request.status === 'CLOSED'}
      lockedNote=" · kept as the Purchaser read them"
      emptyNote="No file yet — attach the supplier's quotation, a photo or a drawing (image or PDF)."
      removeBody="The file leaves this request."
      attachAriaLabel="Attach a file"
      uploading={upload.isPending}
      removing={remove.isPending}
      onUpload={(file) => upload.mutateAsync({ id: request.id, file })}
      onRemove={(fileId) => remove.mutateAsync({ id: request.id, fileId })}
      openUrl={(fileId) => fetchProductRequestFileBlobUrl(request.id, fileId)}
    />
  );
}

/* ── The request's lines, read-only, with the per-line build button ───────── */
function LinesTable({ request, onBuild }: { request: ProductRequest; onBuild: ((line: ProductRequestLine) => void) | null }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={lineTable} aria-label={`Lines of ${request.request_no}`}>
        <thead>
          <tr>
            <th style={th}>#</th>
            <th style={th}>Model / SKU</th>
            <th style={th}>Category</th>
            <th style={th}>Spec</th>
            <th style={{ ...th, textAlign: 'right' }}>Qty</th>
            <th style={th}>Remarks</th>
            {onBuild && <th style={th} />}
          </tr>
        </thead>
        <tbody>
          {request.lines.map((l) => (
            <tr key={l.id}>
              <td style={{ ...td, ...soft }}>{l.line_no}</td>
              <td style={{ ...td, ...mono }}>
                {/* Once the line is built, its SKU code links through to the new
                    catalogue Model (owner 2026-10-16: link 去新建好的 code). The
                    product page is a desktop-only route; the route guard handles a
                    viewer who may not open it, as the PC Order cross-link does. */}
                {l.model?.id
                  ? <Link to={`/scm/product-models/${l.model.id}`} style={{ color: 'var(--c-orange)' }}>{lineProductText(l)}</Link>
                  : lineProductText(l)}
                {l.model ? <span style={soft}> · Model {l.model.modelCode}</span> : null}
              </td>
              <td style={td}>{mfgCategoryLabel(l.category)}</td>
              <td style={td}>{specText(l)}</td>
              <td style={{ ...td, textAlign: 'right' }}>{l.qty}</td>
              <td style={td}>{l.remarks ?? '—'}</td>
              {onBuild && (
                <td style={{ ...td, whiteSpace: 'nowrap' }}>
                  {!l.item_code && <Button variant="primary" size="sm" onClick={() => onBuild(l)}>Create Model + SKU</Button>}
                </td>
              )}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td style={{ ...td, borderBottom: 'none' }} colSpan={4}><span style={soft}>{request.lines.length} line{request.lines.length === 1 ? '' : 's'}</span></td>
            <td style={{ ...td, borderBottom: 'none', textAlign: 'right', fontWeight: 600 }}>{totalQty(request)}</td>
            <td style={{ ...td, borderBottom: 'none' }} colSpan={1 + (onBuild ? 1 : 0)} />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/* ── The Purchaser builds one line's new Model + its first SKU ─────────────── */
function BuildModelForm({ request, line, onDone, onCancel }: { request: ProductRequest; line: ProductRequestLine; onDone: () => void; onCancel: () => void }) {
  const build = useCreateModelFromRequest();
  const notify = useNotify();
  const [modelCode, setModelCode] = useState('');
  const [skuCode, setSkuCode] = useState('');
  const [name, setName] = useState(line.proposed_model_name ?? '');
  const code = modelCode.trim().toUpperCase().replace(/\s+/g, '-');
  const defaultSku = code;
  const save = async () => {
    if (!code) { void notify({ title: 'Not yet complete', body: 'Give the new Model a code.', tone: 'error' }); return; }
    try {
      const res = await build.mutateAsync({ id: request.id, lineId: line.id, modelCode: code, skuCode: skuCode.trim() || null, name: name.trim() || null });
      const left = linesNeedingModel(res.request).length;
      void notify({ title: `${res.sku.code} created`, body: `Model ${res.model.modelCode} · the SKU is in the catalogue but not on POS until someone turns it on. ${left === 0 ? 'Every line has its SKU — raise the Purchase Consignment Order next.' : `${left} line${left === 1 ? '' : 's'} still need${left === 1 ? 's' : ''} a Model.`}` });
      onDone();
    } catch { /* the mutation's own onError told the user */ }
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
      <div style={soft}>Line {line.line_no}: {line.proposed_model_name} · {mfgCategoryLabel(line.category)} · ×{line.qty}</div>
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
        <input className={styles.fieldInput} value={skuCode} onChange={(e) => setSkuCode(e.target.value)} aria-label="SKU code" placeholder={defaultSku || 'defaults to the model code'} style={mono} />
      </label>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button variant="primary" size="sm" onClick={() => void save()} disabled={build.isPending}>{build.isPending ? 'Creating…' : 'Create Model + SKU'}</Button>
      </div>
    </div>
  );
}

/* ── New / edit ─────────────────────────────────────────────────────────── */
type DraftLine = ProductRequestLineInput & { rid: string; newModel: boolean };
const draftLine = (from: ProductRequestLineInput | null): DraftLine => ({
  rid: `l${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  newModel: !!from && !from.itemCode,
  ...(from ?? emptyRequestLine()),
});

export function RequestForm({ initial, onDone, onCancel }: { initial: ProductRequest | null; onDone: (id: string) => void; onCancel: () => void }) {
  const notify = useNotify();
  const create = useCreateProductRequest();
  const update = useUpdateProductRequest();
  const upload = useUploadProductRequestFile();
  /* Files picked before the request exists; uploaded one by one once it does
     (a new request only — an existing one attaches on its own card). */
  const [pending, setPending] = useState<File[]>([]);
  const pickRef = useRef<HTMLInputElement>(null);
  const [v, setV] = useState<Omit<ProductRequestInput, 'lines'>>(() => ({
    requestType: initial?.request_type ?? 'NEW_PRODUCT',
    application: initial?.application ?? 'CUSTOMER_ORDER',
    specialRemarks: initial?.special_remarks ?? null,
    deliveryLocationId: initial?.delivery_location_id ?? null,
    expectedDeliveryDate: initial?.expected_delivery_date ?? null,
    supplierId: initial?.supplier_id ?? null,
  }));
  const [lines, setLines] = useState<DraftLine[]>(() => (initial && initial.lines.length > 0 ? initial.lines.map((l) => draftLine(lineToInput(l))) : [draftLine(null)]));
  const set = (patch: Partial<Omit<ProductRequestInput, 'lines'>>) => setV((prev) => ({ ...prev, ...patch }));
  const setLine = (rid: string, patch: Partial<DraftLine>) => setLines((prev) => prev.map((l) => (l.rid === rid ? { ...l, ...patch } : l)));
  const isRepack = v.requestType === 'REPACK';

  const skus = useMfgProducts();
  const supplierOptions = useProductRequestSupplierOptions().data?.suppliers ?? [];
  const maint = useMaintenanceConfig('master').data?.data ?? null;
  const fabrics = useFabricTrackings().data ?? [];
  const warehouses = useWarehouses().data ?? [];
  const skuList = useMemo(() => sortByText(skus.data ?? []), [skus.data]);
  const seatSizes = sortByNumeric(maintPickerValues(maint?.sofaSizes ?? [], ''));
  const sofaLegs = sortByNumeric(activeOptions(maint?.sofaLegHeights ?? [], '')).map((o) => o.value);
  const otherLegs = sortByNumeric(activeOptions(maint?.legHeights ?? [], '')).map((o) => o.value);
  const pickableFabrics = useMemo(() => sortByText(fabrics.filter((f) => f.is_active !== false).map((f) => ({ ...f, name: fabricOptionLabel(f) }))), [fabrics]);

  const onItemCode = (rid: string, code: string) => {
    const sku = (skus.data ?? []).find((p) => p.code === code);
    setLine(rid, { itemCode: code || null, proposedModelName: null, ...(sku ? { category: String(sku.category).toUpperCase() } : {}) });
  };
  /* The line's product, as the server reads it: a SKU for an existing one, a
     name for a new Model — a repack is always existing. */
  const lineBody = (l: DraftLine): ProductRequestLineInput => {
    const existing = isRepack || !l.newModel;
    return {
      itemCode: existing ? (l.itemCode ?? '').trim() || null : null,
      proposedModelName: existing ? null : (l.proposedModelName ?? '').trim() || null,
      category: l.category, compartment: l.compartment, fabricCode: l.fabricCode, seatSize: l.seatSize, legSize: l.legSize,
      qty: l.qty, unitPriceSen: l.unitPriceSen, remarks: l.remarks?.trim() || null,
    };
  };
  const missing = lines.flatMap((l, i) => {
    const b = lineBody(l);
    const n = i + 1;
    return [
      !b.itemCode && !b.proposedModelName ? `line ${n}: ${isRepack ? 'the SKU being re-packed' : l.newModel ? "the new Model's name" : 'the SKU'}` : null,
      b.qty > 0 ? null : `line ${n}: the quantity`,
    ].filter(Boolean) as string[];
  });
  const saving = create.isPending || update.isPending;

  const save = async () => {
    if (lines.length === 0) { void notify({ title: 'Not yet complete', body: 'Add at least one product line.', tone: 'error' }); return; }
    if (missing.length > 0) { void notify({ title: 'Not yet complete', body: `Still needed: ${missing.join(', ')}.`, tone: 'error' }); return; }
    const body: ProductRequestInput = { ...v, specialRemarks: v.specialRemarks?.trim() || null, lines: lines.map(lineBody) };
    try {
      const res = initial ? await update.mutateAsync({ id: initial.id, ...body }) : await create.mutateAsync(body);
      for (const f of pending) {
        try {
          const file: PvFilePayload = { name: f.name, mime: docFileMime(f), dataBase64: await fileToBase64(f) };
          await upload.mutateAsync({ id: res.request.id, file });
        } catch { /* the mutation's own onError told the user; the request stands — attach again on it */ }
      }
      onDone(res.request.id);
    } catch { /* the mutation's own onError told the user */ }
  };

  const grid = (min: number): React.CSSProperties => ({ display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(${min}px, 1fr))`, gap: 'var(--space-3)' });
  const cell: React.CSSProperties = { fontSize: 'var(--fs-12)', padding: '4px 6px', border: '1px solid #d6d9d2', borderRadius: 6, background: '#fff', width: '100%', minWidth: 0 };

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {initial?.status === 'REJECTED' && initial.decision_note && (
        <div style={{ color: 'var(--c-festive-b, #B8331F)', fontSize: 'var(--fs-13)' }}>The Purchaser rejected it: {initial.decision_note}</div>
      )}

      <FormSection n={1} title="What kind of request" first>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 'var(--fs-13)' }}>
          {(['NEW_PRODUCT', 'REPACK'] as ProductRequestType[]).map((t) => (
            <label key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <input type="radio" name="pr-type" checked={v.requestType === t} onChange={() => { set({ requestType: t }); if (t === 'REPACK') setLines((prev) => prev.map((l) => ({ ...l, newModel: false }))); }} aria-label={REQUEST_TYPE_LABEL[t]} />
              {REQUEST_TYPE_LABEL[t]}{t === 'REPACK' ? <span style={soft}> — re-pack existing SKUs (service)</span> : null}
            </label>
          ))}
        </div>
        <label className={styles.field} style={{ maxWidth: 320 }}>
          <span className={styles.fieldLabel}>Application *</span>
          <select className={styles.fieldInput} value={v.application} onChange={(e) => set({ application: e.target.value as ProductRequestApplication })} aria-label="Application">
            {(Object.keys(APPLICATION_LABEL) as ProductRequestApplication[]).map((a) => <option key={a} value={a}>{APPLICATION_LABEL[a]}</option>)}
          </select>
        </label>
      </FormSection>

      <FormSection n={2} title="Products" required>
        <div style={soft}>One line per product. {isRepack ? 'A repack names the SKU being re-packed.' : 'Pick an existing SKU, or name a Model the catalogue does not have yet.'}</div>
        <div style={{ overflowX: 'auto' }}>
          <table style={lineTable} aria-label="Product lines">
            <thead>
              <tr>
                <th style={th}>#</th>
                <th style={{ ...th, minWidth: 260 }}>Model / SKU</th>
                <th style={{ ...th, minWidth: 110 }}>Category</th>
                <th style={{ ...th, minWidth: 130 }}>Fabric</th>
                <th style={{ ...th, minWidth: 70 }}>Size</th>
                <th style={{ ...th, minWidth: 70 }}>Leg</th>
                <th style={{ ...th, minWidth: 64 }}>Qty</th>
                <th style={{ ...th, minWidth: 140 }}>Remarks</th>
                <th style={th} />
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => {
                const n = i + 1;
                const existing = isRepack || !l.newModel;
                const isSofa = l.category === 'SOFA';
                return (
                  <tr key={l.rid}>
                    <td style={{ ...td, ...soft }}>{n}</td>
                    <td style={td}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        {!isRepack && (
                          <select style={{ ...cell, fontSize: 'var(--fs-11)' }} value={l.newModel ? 'new' : 'existing'} aria-label={`Product kind line ${n}`}
                            onChange={(e) => { const nm = e.target.value === 'new'; setLine(l.rid, { newModel: nm, ...(nm ? { itemCode: null } : { proposedModelName: null }) }); }}>
                            <option value="existing">Existing SKU</option>
                            <option value="new">New Model — not in the catalogue yet</option>
                          </select>
                        )}
                        {existing ? (
                          <input style={{ ...cell, ...mono }} list="pr-skus" value={l.itemCode ?? ''} onChange={(e) => onItemCode(l.rid, e.target.value)} aria-label={`SKU line ${n}`} placeholder="Type or pick a SKU code…" />
                        ) : (
                          <input style={cell} value={l.proposedModelName ?? ''} onChange={(e) => setLine(l.rid, { proposedModelName: e.target.value || null })} aria-label={`New Model name line ${n}`} placeholder="e.g. Aurora 2-seater" />
                        )}
                      </div>
                    </td>
                    <td style={td}>
                      <select style={cell} value={l.category} onChange={(e) => setLine(l.rid, { category: e.target.value })} aria-label={`Category line ${n}`} disabled={existing && !!l.itemCode}>
                        {MFG_PRODUCT_CATEGORIES.map((c) => <option key={c} value={c}>{mfgCategoryLabel(c)}</option>)}
                      </select>
                    </td>
                    <td style={td}>
                      <input style={{ ...cell, ...mono }} list="pr-fabrics" value={l.fabricCode ?? ''} onChange={(e) => setLine(l.rid, { fabricCode: e.target.value || null })} aria-label={`Fabric line ${n}`} placeholder="Fabric code…" />
                    </td>
                    <td style={td}>
                      <input style={cell} list={isSofa ? 'pr-seat-sizes' : undefined} value={l.seatSize ?? ''} onChange={(e) => setLine(l.rid, { seatSize: e.target.value || null })} aria-label={`${isSofa ? 'Sofa size' : 'Size'} line ${n}`} placeholder={isSofa ? '22' : 'Queen'} />
                    </td>
                    <td style={td}>
                      <input style={cell} list={isSofa ? 'pr-leg-sofa' : 'pr-leg-other'} value={l.legSize ?? ''} onChange={(e) => setLine(l.rid, { legSize: e.target.value || null })} aria-label={`Leg size line ${n}`} placeholder="4" />
                    </td>
                    <td style={td}>
                      <NumberInput value={l.qty} sign="unsigned" decimal={false} onValueChange={(q) => setLine(l.rid, { qty: q ?? 0 })} aria-label={`Qty line ${n}`} style={{ ...cell, textAlign: 'right' }} />
                    </td>
                    <td style={td}>
                      <input style={cell} value={l.remarks ?? ''} onChange={(e) => setLine(l.rid, { remarks: e.target.value || null })} aria-label={`Remarks line ${n}`} maxLength={500} placeholder="deeper seat, no piping…" />
                    </td>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>
                      <button type="button" onClick={() => setLines((prev) => prev.filter((x) => x.rid !== l.rid))} aria-label={`Remove line ${n}`} title="Remove line"
                        style={{ ...linkBtn, color: 'var(--fg-muted)', textDecoration: 'none', display: 'inline-flex' }} disabled={lines.length === 1}>
                        <Trash2 size={14} strokeWidth={1.75} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <datalist id="pr-skus">{skuList.map((p) => <option key={p.id} value={p.code}>{p.name} · {mfgCategoryLabel(p.category)}</option>)}</datalist>
        <datalist id="pr-fabrics">{pickableFabrics.map((f) => <option key={f.id} value={f.fabric_code}>{f.name}</option>)}</datalist>
        <datalist id="pr-seat-sizes">{seatSizes.map((o) => <option key={o} value={o} />)}</datalist>
        <datalist id="pr-leg-sofa">{sofaLegs.map((o) => <option key={o} value={o} />)}</datalist>
        <datalist id="pr-leg-other">{otherLegs.map((o) => <option key={o} value={o} />)}</datalist>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Button variant="secondary" size="sm" onClick={() => setLines((prev) => [...prev, draftLine(null)])}>
            <Plus size={14} strokeWidth={1.75} /> Add line
          </Button>
          <span style={soft}>{lines.length} line{lines.length === 1 ? '' : 's'} · {lines.reduce((s, l) => s + (l.qty || 0), 0)} pcs</span>
        </div>
      </FormSection>

      <FormSection n={3} title="Delivery">
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
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Special remarks</span>
          <textarea className={styles.fieldInput} rows={2} value={v.specialRemarks ?? ''} onChange={(e) => set({ specialRemarks: e.target.value || null })} aria-label="Special remarks" maxLength={2000} placeholder="Anything the Purchaser should know about the whole request" />
        </label>
      </FormSection>

      {!initial && (
        <FormSection n={4} title="Files">
          <div style={soft}>The supplier's quotation, photos or a drawing — image or PDF, 20 MB each. They attach once the request is sent; an existing request attaches on its own card.</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {pending.map((f, i) => (
              <div key={`${f.name}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--fs-13)' }}>
                <Paperclip size={14} strokeWidth={1.75} />
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setPending((prev) => prev.filter((_, j) => j !== i))}
                  style={{ ...linkBtn, color: 'var(--fg-muted)', textDecoration: 'none', display: 'inline-flex' }}>
                  <Trash2 size={14} strokeWidth={1.75} />
                </button>
              </div>
            ))}
            {/* A real button, not a link-styled label: the owner missed the link (2026-10-15: 没有反应). */}
            <div>
              <input ref={pickRef} type="file" multiple accept={PV_FILE_ACCEPT} aria-label="Pick files to attach" style={{ display: 'none' }}
                onChange={(e) => { const picked = takePickedFiles(e.target); setPending((prev) => [...prev, ...picked]); }} />
              <Button variant="secondary" size="sm" onClick={() => pickRef.current?.click()}>
                <Paperclip size={14} strokeWidth={1.75} /> Attach file…
              </Button>
            </div>
          </div>
        </FormSection>
      )}

      {/* 方案 C (owner 2026-10-08): the requester names the supplier and the agreed
          prices; the Purchaser records them and the PC Order is seeded from them. */}
      <FormSection n={initial ? 4 : 5} title="Supplier (if agreed)">
        <div style={grid(200)}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Supplier</span>
            <select className={styles.fieldInput} value={v.supplierId ?? ''} onChange={(e) => set({ supplierId: e.target.value || null })} aria-label="Supplier">
              <option value="">— not agreed yet —</option>
              {supplierOptions.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.code})</option>)}
            </select>
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
