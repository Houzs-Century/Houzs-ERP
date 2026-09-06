// ----------------------------------------------------------------------------
// AP Invoices — /scm/ap-invoices, the Finance side's supplier bills.
//
// The owner's design (2026-09-06, AutoCount in hand), confirmed line by line:
// 可以不可以像 autocount 这样 purchase invoice 一边,然后再多一个 AP invoice …
// 我想要两个都看到, 现有的 purchase invoice remain. So: ONE table, a Kind
// column — the operational purchase invoices as a read-only mirror (they are
// raised and edited on Procurement → Purchase Invoices, which this page never
// touches; a row links there) beside the AP INVOICES raised HERE (rent, a
// service, an other creditor's bill — Draft → Post → paid down by the same AP
// Payment → Paid, or Cancelled). Lines pick their own accounts; posting books
// Dr each line / Cr the supplier's AP control by its code.
//
// The bill's paper (owner 2026-09-06: 做,附件也一起做,bundle 也带上): the New
// card READS a bill with the voucher's own OCR (supplier match, number, dates,
// lines; the account from vendor memory only) and attaches the read pages on
// save; the detail shows the shared Files card; the AP Payment's print bundle
// carries these files after the voucher's own.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { useAccounts, isControlSpecial, type Account } from '../../vendor/scm/lib/accounting-queries';
import { useSuppliers } from '../../vendor/scm/lib/suppliers-queries';
import {
  useApInvoices, useApInvoiceDetail, useCreateApInvoice, usePostApInvoice, useCancelApInvoice,
  useApInvoiceFiles, useUploadApInvoiceFile, useDeleteApInvoiceFile, fetchApInvoiceFileBlobUrl,
  type ApListKind, type ApListRow,
} from '../../vendor/scm/lib/ap-invoice-queries';
import {
  useExtractBills, fileToBase64, PV_FILE_ACCEPT, type BillExtraction, type VendorMemory, type PvFilePayload,
} from '../../vendor/scm/lib/payment-voucher-queries';
import { DocFilesCard } from '../../vendor/scm/components/DocFilesCard';
import { AccountSelect } from '../../vendor/scm/components/AccountSelect';
import { SearchCombo } from '../../vendor/scm/components/SearchCombo';
import { DateField } from '../../vendor/scm/components/DateField';
import { sortByText } from '../../vendor/scm/lib/sort-options';
import { useAuth as useHouzsAuth } from '../../auth/AuthContext';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { fmtSen, fmtDateOrDash } from '../../vendor/shared/format';
import styles from './SalesOrderDetail.module.css';
import { PageHeader } from '../../components/Layout';

const ICON = { size: 16, strokeWidth: 1.75 } as const;
const myt = (): string => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

type Line = { rid: number; description: string; debitAccountCode: string; amountSen: number };
const emptyLine = (rid: number): Line => ({ rid, description: '', debitAccountCode: '', amountSen: 0 });

const KIND_LABEL: Record<ApListRow['kind'], string> = { API: 'AP Invoice', PI: 'Purchase Invoice' };
const soft: React.CSSProperties = { fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' };
const chip = (on: boolean): React.CSSProperties => ({
  padding: '4px 10px', borderRadius: 999, fontSize: 'var(--fs-13)', cursor: 'pointer',
  border: '1px solid var(--c-line, rgba(34,31,32,0.2))',
  background: on ? 'var(--c-ink)' : 'transparent', color: on ? 'var(--c-cream)' : 'var(--c-ink)',
});
const inputStyle: React.CSSProperties = { padding: '6px 8px', border: '1px solid var(--border-weak, #d8d5cd)', borderRadius: 6 };

export const ApInvoices = () => {
  const askConfirm = useConfirm();
  const notify = useNotify();
  const { can } = useHouzsAuth();
  const canCreate = can('scm.payment_voucher.create') || can('scm.payment_voucher.write');
  const canPost = can('scm.payment_voucher.post');
  const canCancel = can('scm.payment_voucher.cancel');

  const [kind, setKind] = useState<ApListKind>('ALL');
  const listQ = useApInvoices(kind);
  const rows = listQ.data?.rows ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const detailQ = useApInvoiceDetail(selectedId);

  const suppliersQ = useSuppliers({ status: 'ACTIVE' });
  const accountsQ = useAccounts();
  /* A line debits an ordinary LEAF: active, not a control (由模块过账) and
     not a header (父户不记账) — the same door the PV's lines walk. */
  const lineAccounts = useMemo<Account[]>(() => {
    const all = accountsQ.data?.accounts ?? [];
    const parents = new Set(all.map((a) => a.parent_code).filter((p): p is string => !!p));
    return all.filter((a) => a.is_active && !isControlSpecial(a.special_type) && !parents.has(a.account_code));
  }, [accountsQ.data]);

  const create = useCreateApInvoice();
  const post = usePostApInvoice();
  const cancel = useCancelApInvoice();

  /* New-bill card. */
  const [adding, setAdding] = useState(false);
  const [supplierId, setSupplierId] = useState('');
  const [supplierRef, setSupplierRef] = useState('');
  const [invoiceDate, setInvoiceDate] = useState(myt());
  const [dueDate, setDueDate] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<Line[]>([emptyLine(1)]);
  const total = lines.reduce((s, l) => s + (l.amountSen > 0 ? l.amountSen : 0), 0);
  const patchLine = (rid: number, patch: Partial<Line>) =>
    setLines((prev) => prev.map((l) => (l.rid === rid ? { ...l, ...patch } : l)));
  const ready = !!supplierId && !!invoiceDate && total > 0 && lines.filter((l) => l.amountSen > 0).every((l) => !!l.debitAccountCode);

  /* ── Scan bill (OCR) — the voucher's reader (POST /payment-vouchers/extract)
     fills THIS card: the supplier from the server's match, the bill's own
     number, its dates and lines; the account ONLY from vendor memory (what a
     person saved for this vendor before — a save here teaches it too), never
     a model guess. MULTI-SELECT MEANS ONE BILL (its pages); the read pages
     become the bill's files after save. */
  const extract = useExtractBills();
  const uploadFile = useUploadApInvoiceFile();
  const [scanNote, setScanNote] = useState<string | null>(null);
  const [pendingFiles, setPendingFiles] = useState<PvFilePayload[]>([]);
  const applyExtraction = (ex: BillExtraction, match: { id: string } | null, memory: VendorMemory | null) => {
    if (match) setSupplierId(match.id);
    if (ex.invoiceNumber) setSupplierRef(ex.invoiceNumber);
    if (ex.invoiceDate) setInvoiceDate(ex.invoiceDate);
    if (ex.dueDate) setDueDate(ex.dueDate);
    const account = memory?.debitAccountCode ?? '';
    const drafts: Line[] = ex.lines
      .filter((l): l is { description: string | null; amountSen: number } => l.amountSen != null && l.amountSen > 0)
      .map((l, i) => ({ rid: i + 1, description: l.description ?? '', debitAccountCode: account, amountSen: l.amountSen }));
    /* A bill with no readable lines still carries its total — one line. */
    if (drafts.length === 0 && ex.totalSen != null && ex.totalSen > 0) {
      drafts.push({ rid: 1, description: ex.invoiceNumber ? `Bill ${ex.invoiceNumber}` : 'As per bill', debitAccountCode: account, amountSen: ex.totalSen });
    }
    if (drafts.length > 0) setLines(drafts);
  };
  const onScanFiles = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    setScanNote('Reading the bill…');
    try {
      const files = await Promise.all([...list].map(async (f) => ({ name: f.name, mime: f.type || 'application/pdf', dataBase64: await fileToBase64(f) })));
      const res = await extract.mutateAsync([{ files }]);
      const bill = res.bills.at(0);
      if (!bill) { setScanNote('The bill could not be read.'); return; }
      if (!bill.ok) { setScanNote(bill.reason); return; }
      applyExtraction(bill.extraction, bill.supplierMatch, bill.memory);
      /* The LAST successful read wins, matching applyExtraction overwriting
         the lines — this card reads ONE bill at a time. */
      setPendingFiles(files);
      setScanNote([
        'Read — check every figure before saving.',
        bill.supplierMatch ? `Looks like supplier ${bill.supplierMatch.name}.` : 'No supplier matched the printed name — pick it yourself.',
        bill.memory?.debitAccountCode
          ? `Account ${bill.memory.debitAccountCode} filled from your last ${bill.memory.payeeName ?? 'same-vendor'} bill — check it.`
          : null,
        bill.extraction.totalSen == null ? 'The TOTAL was not readable — enter it yourself.' : null,
        bill.extraction.currency !== 'MYR' ? `The bill reads as ${bill.extraction.currency}; AP invoices are MYR — a foreign bill goes through a purchase invoice.` : null,
      ].filter(Boolean).join(' '));
    } catch (e) {
      setScanNote(e instanceof Error ? e.message : 'The bill could not be read.');
    }
  };

  const save = async () => {
    try {
      const res = await create.mutateAsync({
        supplierId,
        ...(supplierRef.trim() ? { supplierInvoiceRef: supplierRef.trim() } : {}),
        invoiceDate,
        dueDate: dueDate || null,
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        lines: lines
          .filter((l) => l.debitAccountCode && l.amountSen > 0)
          .map((l) => ({ ...(l.description.trim() ? { description: l.description.trim() } : {}), debitAccountCode: l.debitAccountCode, amountSen: l.amountSen })),
      });
      /* Attach the scanned bill AFTER the invoice exists — sequentially, so
         sort_no (= print order) is the scan order. A failed upload never
         un-saves the bill: the notice says what still needs adding, and the
         detail's Files card takes it; nothing stays pending for the NEXT
         bill this card raises. */
      let attached = 0;
      let attachErr: string | null = null;
      for (const f of pendingFiles) {
        try {
          await uploadFile.mutateAsync({ invoiceId: res.invoice.id, file: f });
          attached += 1;
        } catch (e) {
          attachErr = e instanceof Error ? e.message : 'The file could not be uploaded.';
          break;
        }
      }
      setAdding(false);
      setSupplierId(''); setSupplierRef(''); setDueDate(''); setNotes(''); setLines([emptyLine(1)]);
      setPendingFiles([]); setScanNote(null);
      setSelectedId(res.invoice.id);
      void notify({
        title: `${res.invoice.invoice_number} raised`,
        body: [
          `${fmtSen(res.invoice.total_sen)} as a draft — post it below to put it on the books.`,
          attached > 0 ? `${attached} scanned file(s) attached.` : null,
          attachErr ? `${pendingFiles.length - attached} file(s) did not attach (${attachErr}) — add them from the bill's Files card.` : null,
        ].filter(Boolean).join(' '),
        tone: attachErr ? 'error' : 'info',
      });
    } catch (e) {
      void notify({ title: 'Bill not saved', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
    }
  };

  const onPost = async (id: string, no: string) => {
    const ok = await askConfirm({
      title: `Post ${no}?`,
      body: 'Books Dr each line\'s account / Cr the supplier\'s AP control, dated by the invoice. From then on it is paid through an AP Payment.',
      confirmLabel: 'Post',
    });
    if (!ok) return;
    try {
      await post.mutateAsync(id);
    } catch (e) {
      void notify({ title: 'Post failed', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
    }
  };
  const onCancel = async (id: string, no: string, posted: boolean) => {
    const ok = await askConfirm({
      title: `Cancel ${no}?`,
      body: posted ? 'The journal is reversed with a contra — the ledger keeps both sides. A bill with a payment on it refuses.' : 'The draft is closed; nothing was ever posted.',
      confirmLabel: 'Cancel bill', danger: true,
    });
    if (!ok) return;
    try {
      await cancel.mutateAsync(id);
    } catch (e) {
      void notify({ title: 'Cancel failed', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
    }
  };

  const detail = detailQ.data;

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Finance"
        title="AP Invoices"
        actions={canCreate ? (
          <button type="button" onClick={() => setAdding(true)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--c-orange)', fontWeight: 600, cursor: 'pointer', fontSize: 'var(--fs-13)', background: 'none', border: 'none', padding: 0 }}>
            <Plus {...ICON} /> New AP invoice
          </button>
        ) : undefined}
      />

      {adding && (
        <section className={styles.card}>
          <div className={styles.cardHeader}><h2 className={styles.cardTitle}>New AP invoice — 非库存的供应商账单</h2></div>
          <div className={styles.cardBody} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', fontSize: 'var(--fs-13)' }}>
            <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap' }}>
              {/* Scan bill — pick the bill's page(s); MULTI-SELECT = ONE BILL. */}
              <label style={{ fontSize: 'var(--fs-12)', color: 'var(--c-orange)', cursor: 'pointer', fontWeight: 600 }}>
                📷 {extract.isPending ? 'Reading…' : 'Scan bill (OCR)'}
                <input type="file" multiple accept={PV_FILE_ACCEPT} aria-label="Scan bill files" style={{ display: 'none' }}
                  disabled={extract.isPending}
                  onChange={(e) => { void onScanFiles(e.target.files); e.target.value = ''; }} />
              </label>
              {scanNote && (
                <span style={{ fontSize: 'var(--fs-12)', color: extract.isPending ? 'var(--fg-muted)' : 'var(--c-orange)' }}>{scanNote}</span>
              )}
            </div>
            {pendingFiles.length > 0 && (
              <div style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
                📎 {pendingFiles.length} scanned file(s) will be attached to this bill on save: {pendingFiles.map((f) => f.name).join(', ')}
              </div>
            )}
            <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 260px' }}>
                <span style={soft}>Supplier *</span>
                <SearchCombo
                  options={sortByText(suppliersQ.data ?? []).map((s) => ({ value: s.id, label: `${s.code} · ${s.name}` }))}
                  value={supplierId} onChange={setSupplierId} aria-label="AP invoice supplier"
                  placeholder={suppliersQ.isLoading ? 'Loading suppliers…' : 'Type to find the supplier'} />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={soft}>Supplier's invoice no.</span>
                <input value={supplierRef} onChange={(e) => setSupplierRef(e.target.value)} aria-label="Supplier invoice ref" style={inputStyle} />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={soft}>Invoice date *</span>
                <DateField value={invoiceDate} onChange={setInvoiceDate} aria-label="AP invoice date" />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={soft}>Due date</span>
                <DateField value={dueDate} onChange={setDueDate} aria-label="AP invoice due date" />
              </label>
            </div>
            {lines.map((l) => (
              <div key={l.rid} style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
                <input placeholder="Description" value={l.description} aria-label={`line ${l.rid} description`}
                  onChange={(e) => patchLine(l.rid, { description: e.target.value })} style={{ ...inputStyle, flex: '1 1 200px' }} />
                <div style={{ flex: '1 1 240px' }}>
                  <AccountSelect accounts={lineAccounts} value={l.debitAccountCode}
                    onChange={(code) => patchLine(l.rid, { debitAccountCode: code })} placeholder="— account this line charges —" />
                </div>
                <input type="number" min={0} step="0.01" placeholder="Amount (RM)" aria-label={`line ${l.rid} amount`}
                  value={l.amountSen > 0 ? String(l.amountSen / 100) : ''}
                  onChange={(e) => patchLine(l.rid, { amountSen: Math.round(Number(e.target.value || 0) * 100) })}
                  style={{ ...inputStyle, width: 130, textAlign: 'right' }} />
              </div>
            ))}
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={soft}>Notes</span>
              <input value={notes} onChange={(e) => setNotes(e.target.value)} aria-label="AP invoice notes" style={inputStyle} />
            </label>
            <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
              <Button variant="ghost" size="sm" onClick={() => setLines((p) => [...p, emptyLine(Math.max(...p.map((x) => x.rid)) + 1)])}>
                <Plus {...ICON} /> Line
              </Button>
              <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)' }}>Total {fmtSen(total)}</span>
              <Button variant="primary" size="sm" onClick={() => void save()} disabled={create.isPending || !ready}>
                {create.isPending ? 'Saving…' : 'Save as draft'}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setAdding(false)}>Close</Button>
            </div>
          </div>
        </section>
      )}

      {selectedId && detail && (
        <section className={styles.card}>
          <div className={styles.cardHeader}>
            <h2 className={styles.cardTitle}>{detail.invoice.invoice_number} · {detail.supplier?.name ?? '—'}</h2>
            <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
              <span style={soft}>{detail.invoice.status}{detail.invoice.supplier_invoice_ref ? ` · ref ${detail.invoice.supplier_invoice_ref}` : ''}</span>
              {canPost && detail.invoice.status === 'DRAFT' && (
                <Button variant="primary" size="sm" onClick={() => void onPost(detail.invoice.id, detail.invoice.invoice_number)} disabled={post.isPending}>
                  {post.isPending ? 'Posting…' : 'Post'}
                </Button>
              )}
              {canCancel && detail.invoice.status !== 'CANCELLED' && Number(detail.invoice.paid_sen) === 0 && (
                <Button variant="ghost" size="sm" onClick={() => void onCancel(detail.invoice.id, detail.invoice.invoice_number, detail.invoice.status !== 'DRAFT')} disabled={cancel.isPending}>
                  Cancel bill
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={() => setSelectedId(null)}>Close</Button>
            </div>
          </div>
          <div className={styles.cardBody} style={{ fontSize: 'var(--fs-13)' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead>
                <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border-weak, #e3e1da)' }}>
                  <th style={{ padding: '6px 8px' }}>#</th>
                  <th style={{ padding: '6px 8px' }}>Description</th>
                  <th style={{ padding: '6px 8px' }}>Account</th>
                  <th style={{ padding: '6px 8px', textAlign: 'right' }}>Amount</th>
                </tr>
              </thead>
              <tbody>
                {detail.lines.map((l) => (
                  <tr key={l.id}>
                    <td style={{ padding: '4px 8px' }}>{l.line_no}</td>
                    <td style={{ padding: '4px 8px' }}>{l.description ?? '—'}</td>
                    <td style={{ padding: '4px 8px', fontFamily: 'var(--font-mono)' }}>{l.debit_account_code}</td>
                    <td style={{ padding: '4px 8px', textAlign: 'right', fontFamily: 'var(--font-mono)' }}>{fmtSen(l.amount_sen)}</td>
                  </tr>
                ))}
                <tr style={{ borderTop: '1px solid var(--border-weak, #e3e1da)' }}>
                  <td colSpan={3} style={{ padding: '4px 8px', fontWeight: 600 }}>Total · paid {fmtSen(detail.invoice.paid_sen)}</td>
                  <td style={{ padding: '4px 8px', textAlign: 'right', fontWeight: 700, fontFamily: 'var(--font-mono)' }}>{fmtSen(detail.invoice.total_sen)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      )}

      {selectedId && detail && (
        <ApInvoiceFilesCard invoiceId={detail.invoice.id} canWrite={canCreate}
          locked={detail.invoice.status !== 'DRAFT' && detail.invoice.status !== 'CANCELLED'}
          closed={detail.invoice.status === 'CANCELLED'} />
      )}

      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Supplier invoices — both kinds</h2>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {([['ALL', 'All'], ['API', 'AP invoices'], ['PI', 'Purchase invoices']] as const).map(([v, label]) => (
              <button key={v} type="button" style={chip(kind === v)} onClick={() => setKind(v)}>{label}</button>
            ))}
          </div>
        </div>
        <div className={styles.cardBody} style={{ overflowX: 'auto' }}>
          {listQ.isLoading && <div style={{ fontSize: 'var(--fs-13)' }}>Loading…</div>}
          {/* A refused or failed read says so — an empty sentence over a 403 hid
             docs/bugs/0648 for an afternoon. */}
          {listQ.isError && (
            <div style={{ fontSize: 'var(--fs-13)', color: 'var(--c-red, #b3261e)' }}>The list could not be loaded — {listQ.error instanceof Error ? listQ.error.message : 'something went wrong.'}</div>
          )}
          {!listQ.isLoading && !listQ.isError && rows.length === 0 && (
            <div style={{ fontSize: 'var(--fs-13)', color: 'var(--fg-muted)' }}>No supplier invoices here yet — purchase invoices show once posted on the Procurement side; raise an AP invoice for a non-stock bill.</div>
          )}
          {rows.length > 0 && (
            <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 'var(--fs-13)' }}>
              <thead>
                <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border-weak, #e3e1da)' }}>
                  <th style={{ padding: '6px 8px' }}>Kind</th>
                  <th style={{ padding: '6px 8px' }}>No.</th>
                  <th style={{ padding: '6px 8px' }}>Supplier</th>
                  <th style={{ padding: '6px 8px' }}>Ref</th>
                  <th style={{ padding: '6px 8px' }}>Date</th>
                  <th style={{ padding: '6px 8px' }}>Due</th>
                  <th style={{ padding: '6px 8px', textAlign: 'right' }}>Total</th>
                  <th style={{ padding: '6px 8px', textAlign: 'right' }}>Outstanding</th>
                  <th style={{ padding: '6px 8px' }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.kind}-${r.id}`} style={{ borderBottom: '1px solid var(--border-weak, #f0eee8)', opacity: r.status === 'CANCELLED' ? 0.55 : 1 }}>
                    <td style={{ padding: '4px 8px', fontSize: 'var(--fs-11)', fontWeight: 600 }}>{KIND_LABEL[r.kind]}</td>
                    <td style={{ padding: '4px 8px', fontFamily: 'var(--font-mono)' }}>
                      {r.kind === 'PI'
                        ? <Link to={`/scm/purchase-invoices/${r.id}`} style={{ color: 'inherit' }}>{r.invoiceNumber}</Link>
                        : <button type="button" onClick={() => setSelectedId(r.id)} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--c-orange)', fontFamily: 'var(--font-mono)' }}>{r.invoiceNumber}</button>}
                    </td>
                    <td style={{ padding: '4px 8px' }}>{r.supplierName ?? '—'}{r.supplierCode ? <span style={soft}> · {r.supplierCode}</span> : null}</td>
                    <td style={{ padding: '4px 8px' }}>{r.supplierInvoiceRef ?? '—'}</td>
                    <td style={{ padding: '4px 8px', whiteSpace: 'nowrap' }}>{fmtDateOrDash(r.invoiceDate)}</td>
                    <td style={{ padding: '4px 8px', whiteSpace: 'nowrap' }}>{fmtDateOrDash(r.dueDate)}</td>
                    <td style={{ padding: '4px 8px', textAlign: 'right', fontFamily: 'var(--font-mono)' }}>{fmtSen(r.totalSen)}</td>
                    <td style={{ padding: '4px 8px', textAlign: 'right', fontFamily: 'var(--font-mono)', fontWeight: r.outstandingSen > 0 ? 700 : 400 }}>{fmtSen(r.outstandingSen)}</td>
                    <td style={{ padding: '4px 8px', fontSize: 'var(--fs-11)' }}>{r.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  );
};

/* ── Files card — the supplier's bill behind this AP invoice (mig
   20260906T2100): the voucher's DocFilesCard bound to this document's hooks
   and rule — a POSTED bill keeps its files (no check layer; the ledger is its
   lock) but still takes a late scan, a CANCELLED one takes no more. */
const ApInvoiceFilesCard = ({ invoiceId, canWrite, locked, closed }: { invoiceId: string; canWrite: boolean; locked: boolean; closed: boolean }) => {
  const filesQ = useApInvoiceFiles(invoiceId);
  const upload = useUploadApInvoiceFile();
  const remove = useDeleteApInvoiceFile();
  return (
    <DocFilesCard
      files={filesQ.data?.files ?? []}
      canWrite={canWrite} locked={locked} closed={closed}
      lockedNote=" · locked with the posted bill"
      emptyNote="No files yet. A bill scanned on the New card attaches its pages here by itself; use Attach file for anything else."
      removeBody="The stored file is deleted with its row. A posted bill refuses this — evidence locks with the document."
      attachAriaLabel="Attach bill files"
      uploading={upload.isPending} removing={remove.isPending}
      onUpload={(file) => upload.mutateAsync({ invoiceId, file })}
      onRemove={(fileId) => remove.mutateAsync({ invoiceId, fileId })}
      openUrl={(fileId) => fetchApInvoiceFileBlobUrl(invoiceId, fileId)}
    />
  );
};
