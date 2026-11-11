// ----------------------------------------------------------------------------
// AdvanceKnockOff — the advance card on a payment voucher: money this voucher
// paid ahead, spent from here (owner 2026-11-06: 和平常 knock off 一样，可以 tick).
// The credit note's own table: tick = in full, as far as the advance reaches;
// untick = back; a typed figure = part of it.
//
// Knock-off only: applying settles the invoice's paid_sen and burns the advance;
// NOTHING posts, because both legs already live in AP. The card disappears when
// the advance is spent to zero.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { Button } from '@2990s/design-system';
import { useApInvoices } from '../../vendor/scm/lib/ap-invoice-queries';
import type { KnockOffRow } from '../../vendor/scm/lib/credit-note-queries';
import { useApplyAdvance, useSupplierAdvances } from '../../vendor/scm/lib/payment-voucher-queries';
import { usePurchaseInvoices } from '../../vendor/scm/lib/purchase-invoice-queries';
import { fmtSen } from '../../vendor/shared/format';
import { KnockOffTable, pickSen, type KnockOffPick } from './CreditNoteKnockOff';
import styles from './SalesOrderDetail.module.css';

const soft: React.CSSProperties = { fontSize: 'var(--fs-13)', color: 'var(--fg-muted)', margin: 0 };

export const AdvanceKnockOff = ({ pvId, supplierId }: { pvId: string; supplierId: string }) => {
  const advancesQ = useSupplierAdvances(supplierId);
  const applyM = useApplyAdvance();
  const piListQ = usePurchaseInvoices();
  /* The other creditor's bills (2026-09-06): an advance to a 405-x supplier
     lands on its AP INVOICES, which the purchase-invoice list never carries. */
  const apListQ = useApInvoices('API');
  const [pick, setPick] = useState<KnockOffPick>({});
  const [note, setNote] = useState<string | null>(null);

  const mine = (advancesQ.data?.advances ?? []).find((a: { pv_id: string }) => a.pv_id === pvId) ?? null;

  const rows = useMemo<KnockOffRow[]>(() => {
    const pis = ((piListQ.data?.purchaseInvoices ?? []) as Array<{
      id: string; invoice_number?: string | null; supplier_id?: string | null;
      supplier?: { id?: string | null } | null; status?: string | null; supplier_invoice_ref?: string | null;
      total_sen?: number | null; paid_sen?: number | null; invoice_date?: string | null;
    }>)
      .filter((r) => {
        const sid = String(r.supplier_id ?? r.supplier?.id ?? '');
        const st = String(r.status ?? '').toUpperCase();
        return sid === supplierId && (st === 'POSTED' || st === 'PARTIALLY_PAID')
          && Number(r.total_sen ?? 0) - Number(r.paid_sen ?? 0) > 0;
      })
      .map((r): KnockOffRow => ({
        kind: 'PI', id: String(r.id), number: String(r.invoice_number ?? r.id), invoiceRef: r.supplier_invoice_ref ?? null, invoiceDate: r.invoice_date ?? null,
        totalSen: Number(r.total_sen ?? 0), owedSen: Number(r.total_sen ?? 0) - Number(r.paid_sen ?? 0), noteSen: 0, status: String(r.status ?? ''),
      }));
    const apis = (apListQ.data?.rows ?? [])
      .filter((r) => r.supplierId === supplierId && (r.status === 'POSTED' || r.status === 'PARTIALLY_PAID') && r.outstandingSen > 0)
      .map((r): KnockOffRow => ({
        kind: 'API', id: r.id, number: r.invoiceNumber, invoiceRef: r.supplierInvoiceRef, invoiceDate: r.invoiceDate,
        totalSen: r.totalSen, owedSen: r.outstandingSen, noteSen: 0, status: r.status,
      }));
    return [...pis, ...apis].sort((a, b) => String(a.invoiceDate ?? '').localeCompare(String(b.invoiceDate ?? '')));
  }, [piListQ.data, apListQ.data, supplierId]);

  if (!mine) return null;
  const remaining = mine.remaining_sen;
  const asked = pickSen(pick);
  const over = asked > remaining;

  const apply = () => {
    setNote(null);
    const allocations = rows.flatMap((r) => {
      const amountSen = pick[r.id]?.amountSen ?? 0;
      if (amountSen <= 0) return [];
      return [r.kind === 'API' ? { apInvoiceId: r.id, amountSen } : { piId: r.id, amountSen }];
    });
    applyM.mutate({ pvId, allocations }, {
      onSuccess: (d: { appliedSen: number; remainingSen: number }) => {
        setPick({});
        setNote(`Knocked off ${fmtSen(d.appliedSen)} — ${fmtSen(d.remainingSen)} of the advance remains.`);
      },
      onError: (e) => setNote(e instanceof Error ? e.message : 'Not applied.'),
    });
  };

  return (
    <section className={styles.card}>
      <div className={styles.cardHeader}>
        <h2 className={styles.cardTitle}>Advance on this voucher</h2>
        <span style={{ fontSize: 'var(--fs-12)', color: over ? 'var(--c-festive-b, var(--hz-dk-festive-b, #B8331F))' : 'var(--fg-muted)' }}>
          {fmtSen(remaining)} unspent{asked > 0 ? ` · applying ${fmtSen(asked)}` : ''}
        </span>
      </div>
      <div className={styles.cardBody} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        <p style={soft}>
          This voucher paid ahead of any invoice. Tick an invoice to knock it off in full, as far as the advance reaches,
          or type a smaller amount for part of it. No money moves: both legs are already in AP.
        </p>
        {rows.length === 0 ? (
          <p style={soft}>
            {piListQ.isLoading || apListQ.isLoading ? "Reading the supplier's invoices…" : 'No outstanding invoice from this supplier yet — the advance waits.'}
          </p>
        ) : (
          <KnockOffTable rows={rows} creditSen={remaining} pick={pick} onChange={setPick} disabled={applyM.isPending} />
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
          <span style={{ flex: 1, fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>{note}</span>
          <Button variant="primary" size="sm" disabled={applyM.isPending || asked === 0 || over} onClick={apply}>
            {applyM.isPending ? 'Applying…' : 'Apply advance'}
          </Button>
        </div>
      </div>
    </section>
  );
};
