// ----------------------------------------------------------------------------
// OtherDebtors — /scm/other-debtors (owner 2026-09-03, confirmed line by line).
//
// other debtor 主要就是我会开 bill 其他和生意性质没有关系的人或公司收回钱:
// a REGISTRY (资料 lives here — 照理 chart of account 只能维护其他的, the GL
// keeps one 305-0000 control and never per-party sub-accounts).
// 2026-09-21 (owner: 他要填的资料就和 supplier 的一样): the registry takes the
// party's data as the supplier master carries it — one pop-out form for New
// and Edit (DebtorPartyForm) — and the INVOICE's BILL TO prints the address.
// 2026-09-29 (owner: 我希望 other debtor 那边只是 maintain other debtor 就好, 开
// other debtor 的 bill 就直接在 ar invoice 页面): this page is the REGISTRY
// ALONE. A debtor's bills are raised, edited, copied, cancelled and printed on
// AR Invoices (/scm/ar-invoices, beside the sales invoices); their money is
// received — and a posted receipt voided — on Receipts; a debtor's card here
// links to its bills. The bill and receipt UI that lived here until then is
// gone, and with it the four-layer receipt walk (no page walks it now).
// ----------------------------------------------------------------------------

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Ban, FileText, Pencil, Plus, RotateCcw } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { useOtherDebtors, useCreateDebtor, useUpdateDebtor, type OtherDebtor } from '../../vendor/scm/lib/accounting-queries';
import { DataTable, type Column } from '../../components/DataTable';
import { Modal } from '../../vendor/scm/components/Modal';
import { useAuth as useHouzsAuth } from '../../auth/AuthContext';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import styles from './SalesOrderDetail.module.css';
import { PageHeader } from '../../components/Layout';
import { fmtSen } from '../../vendor/shared/format';
import { DebtorPartyForm } from './DebtorPartyForm';
import { debtorPartyBody, debtorPartyFrom, emptyDebtorParty, partyAddressLines, type DebtorPartyValues } from '../../vendor/scm/lib/debtor-party';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

const fmtRm = (sen: number | null | undefined): string => fmtSen(sen ?? 0);

const DEBTOR_COLUMNS: Column<OtherDebtor>[] = [
  { key: 'name', label: 'Name', render: (d) => <span style={{ fontWeight: 600 }}>{d.name}</span>, getValue: (d) => d.name },
  { key: 'phone', label: 'Phone', render: (d) => d.phone ?? '—', getValue: (d) => d.phone ?? '' },
  {
    key: 'outstanding', label: 'Outstanding', align: 'right',
    render: (d) => <span style={{ fontFamily: 'var(--font-mono)' }}>{fmtRm(d.outstanding_sen)}</span>,
    getValue: (d) => d.outstanding_sen, exportValue: (d) => d.outstanding_sen / 100, exportFormat: 'money',
  },
  {
    key: 'status', label: 'Status',
    render: (d) => (
      <span style={{ fontSize: 'var(--fs-11)', color: d.is_active ? 'var(--c-secondary-a, #2F5D4F)' : 'var(--fg-muted)' }}>
        {d.is_active ? 'Active' : 'Inactive'}
      </span>
    ),
    getValue: (d) => (d.is_active ? 'ACTIVE' : 'INACTIVE'),
  },
];

export const OtherDebtors = () => {
  const notify = useNotify();
  const { can } = useHouzsAuth();
  const canCreate = can('scm.payment_voucher.create');
  const canWrite = can('scm.payment_voucher.write');

  const listQ = useOtherDebtors();
  const debtors = listQ.data?.debtors ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /* The registry row carries the party's data (the list reads every column
     the invoice's BILL TO prints), so the card needs no second read. */
  const detail = selectedId ? debtors.find((d) => d.id === selectedId) ?? null : null;

  const createDebtor = useCreateDebtor();
  const updateDebtor = useUpdateDebtor();

  /* The debtor's own data — New and Edit share one pop-out form (2026-09-21:
     他要填的资料就和 supplier 的一样). Every box is sent: a blank on Edit clears
     the field, which the server stores as NULL. */
  const [partyForm, setPartyForm] = useState<'new' | 'edit' | null>(null);
  const savePartyForm = async (values: DebtorPartyValues) => {
    const body = debtorPartyBody(values);
    try {
      if (partyForm === 'edit' && selectedId) {
        await updateDebtor.mutateAsync({ id: selectedId, ...body });
      } else {
        const res = await createDebtor.mutateAsync(body);
        setSelectedId(res.debtor.id);
      }
      setPartyForm(null);
    } catch (e) {
      void notify({ title: 'Save failed', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Finance"
        title="Other Debtors"
        actions={canCreate ? (
          <button type="button" onClick={() => setPartyForm('new')}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--c-orange)', fontWeight: 600, cursor: 'pointer', fontSize: 'var(--fs-13)', background: 'none', border: 'none', padding: 0 }}>
            <Plus {...ICON} /> New debtor
          </button>
        ) : undefined}
      />

      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Debtors</h2>
          <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
            资料在这里维护 — the chart keeps only the 305-0000 control; bills are raised on <Link to="/scm/ar-invoices" style={{ color: 'inherit', textDecoration: 'underline' }}>AR Invoices</Link>, money is received on <Link to="/scm/receipts" style={{ color: 'inherit', textDecoration: 'underline' }}>Receipts</Link>
          </span>
        </div>
        <div className={styles.cardBody} style={{ overflowX: 'auto' }}>
          <DataTable<OtherDebtor>
            tableId="other-debtors"
            exportName="other-debtors"
            exportXlsx
            columns={DEBTOR_COLUMNS}
            rows={listQ.data ? debtors : null}
            loading={listQ.isLoading}
            error={listQ.isError ? 'The debtors did not load.' : null}
            emptyLabel='No debtors yet — add the first with "New debtor".'
            getRowKey={(d) => d.id}
            onRowClick={(d) => setSelectedId(d.id)}
            getRowStyle={(d) => (selectedId === d.id ? { background: 'var(--c-cream, #faf7f0)' } : undefined)}
          />
        </div>
      </section>

      {selectedId && detail && (
        <section className={styles.card}>
          <div className={styles.cardHeader}>
            <h2 className={styles.cardTitle}>{detail.name}</h2>
            <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
              {canWrite && (
                <Button variant="ghost" size="sm" onClick={() => setPartyForm('edit')}>
                  <Pencil {...ICON} /> Edit debtor
                </Button>
              )}
              {canWrite && (
                <Button variant="ghost" size="sm"
                  onClick={() => void updateDebtor.mutateAsync({ id: selectedId, isActive: !detail.is_active }).catch((e: unknown) => {
                    void notify({ title: 'Update failed', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
                  })}>
                  {detail.is_active ? <Ban {...ICON} /> : <RotateCcw {...ICON} />} {detail.is_active ? 'Deactivate' : 'Reactivate'}
                </Button>
              )}
              <Link to={`/scm/ar-invoices?debtor=${detail.id}`} className="inline-flex items-center gap-1.5 text-[13px] font-semibold" style={{ color: 'var(--c-orange)' }}>
                <FileText {...ICON} /> Bills on AR Invoices
              </Link>
            </div>
          </div>
          <div className={styles.cardBody} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
            {/* The party's data as the invoice's BILL TO will print it. */}
            <div style={{ fontSize: 'var(--fs-13)', color: 'var(--fg-muted)', display: 'flex', flexDirection: 'column', gap: 2 }}>
              {partyAddressLines(detail).map((line, i) => <span key={i}>{line}</span>)}
              {(() => {
                const contact = [detail.attention || detail.contact_person, detail.phone, detail.mobile, detail.email].filter(Boolean).join(' · ');
                return contact ? <span>{contact}</span> : null;
              })()}
              {(() => {
                const ids = [detail.tin_number && `TIN ${detail.tin_number}`, detail.business_reg_no && `Reg ${detail.business_reg_no}`].filter(Boolean).join(' · ');
                return ids ? <span>{ids}</span> : null;
              })()}
            </div>
            <div style={{ fontSize: 'var(--fs-13)' }}>
              Outstanding <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{fmtRm(detail.outstanding_sen)}</span>
              <span style={{ color: 'var(--fg-muted)' }}> — the bills behind it, and a new one, live on AR Invoices; the money comes in on Receipts.</span>
            </div>
          </div>
        </section>
      )}

      {partyForm && (
        <Modal
          title={partyForm === 'edit' ? `Edit debtor — ${detail?.name ?? ''}` : 'New debtor'}
          onClose={() => setPartyForm(null)}
          ariaLabel={partyForm === 'edit' ? 'Edit debtor' : 'New debtor'}
          width="min(900px, 100%)"
        >
          <DebtorPartyForm
            key={`${partyForm}-${selectedId ?? 'new'}`}
            mode={partyForm}
            initial={partyForm === 'edit' && detail ? debtorPartyFrom(detail) : emptyDebtorParty()}
            saving={createDebtor.isPending || updateDebtor.isPending}
            onSubmit={savePartyForm}
            onCancel={() => setPartyForm(null)}
          />
        </Modal>
      )}
    </div>
  );
};
