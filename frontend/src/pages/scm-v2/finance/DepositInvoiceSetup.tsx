// ----------------------------------------------------------------------------
// DepositInvoiceSetup — Finance › Setup › Deposit invoices,
// /scm/finance/deposit-invoices (the owner's Claude Design, batch 5 §3.1
// vSetup). The per-company switch that issues a deposit invoice for every
// customer payment (owner 2026-09-12; docs/bugs/0828), and the day it counts
// from — moved here from the old Deposit invoices page, whose list folded into
// Money in › Invoices. The same reads and the same save as before
// (GET / POST /deposit-invoices/settings); its two backlogs (payments without
// a deposit invoice, delivered orders without a final invoice) and their
// buttons sit at the head of Invoices.
// ----------------------------------------------------------------------------

import { useState } from 'react';
import { PageHeader } from '../../../components/Layout';
import { DateField } from '../../../vendor/scm/components/DateField';
import { useDepositInvoiceSettings, useSaveDepositInvoiceSettings } from '../../../vendor/scm/lib/deposit-invoice-queries';
import { useAuth as useHouzsAuth } from '../../../auth/AuthContext';
import { useToastOptional } from '../../../hooks/useToast';
import { fmtDate } from '../../../vendor/shared/format';
import { Skeleton, Switch } from './SetupParts';
import css from './SetupParts.module.css';

const errText = (e: unknown): string => (e instanceof Error && e.message ? e.message : 'Something went wrong.');

export function DepositInvoiceSetup() {
  const toast = useToastOptional();
  const { can } = useHouzsAuth();
  /* The switch is the post key's, as the server says (deposit-invoices.ts). */
  const canSave = can('scm.payment_voucher.post');
  const q = useDepositInvoiceSettings();
  const save = useSaveDepositInvoiceSettings();
  const [draft, setDraft] = useState<{ enabled: boolean; fromDate: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const saved = q.data?.settings;
  const v = draft ?? { enabled: saved?.enabled ?? false, fromDate: saved?.fromDate ?? '' };
  const dirty = draft != null && (draft.enabled !== (saved?.enabled ?? false) || draft.fromDate !== (saved?.fromDate ?? ''));

  const onSave = () => {
    setError(null);
    /* Switching on needs the day it counts from. */
    if (v.enabled && !v.fromDate) { setError('Type the start day as 2026/09/15'); return; }
    save.mutate({ enabled: v.enabled, fromDate: v.fromDate.trim() || null }, {
      onSuccess: (r) => {
        setDraft(null);
        toast?.success(r.settings.enabled ? `Saved · on for payments dated from ${fmtDate(r.settings.fromDate)}` : 'Saved · off');
      },
      onError: (e) => setError(errText(e)),
    });
  };

  return (
    <div className={css.page}>
      <PageHeader eyebrow="Finance · Setup" title="Deposit invoices" />
      {q.isLoading && <Skeleton rows={2} label="Reading the switch" />}
      {q.isError && <div className={css.card}><div className={`${css.cardBody} ${css.hint}`} role="alert">The switch was not read — {errText(q.error)}</div></div>}
      {saved && (
        <section className={css.card} aria-label="Deposit invoice switch">
          <div className={css.cardHead}><span className={css.cardTitle}>Deposit invoices</span></div>
          <div className={css.cardBody} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px 14px' }}>
            <Switch on={v.enabled} label="Issue a deposit invoice for every customer payment" disabled={!canSave || save.isPending}
              onClick={() => setDraft({ ...v, enabled: !v.enabled })}>
              <span style={{ fontSize: 13 }}>Issue a deposit invoice for every customer payment</span>
            </Switch>
            <span className={css.muted}>from</span>
            <DateField value={v.fromDate} onChange={(d) => setDraft({ ...v, fromDate: d })} aria-label="Deposit invoices start from"
              placeholder="2026/09/15" disabled={!canSave || save.isPending} />
            {dirty && canSave && (
              <button type="button" className={css.btnSolid} onClick={onSave} disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</button>
            )}
            <span className={css.grow} />
            <span style={{ fontSize: 12.5, fontWeight: 600, color: saved.enabled ? 'var(--hz-c-synced)' : 'var(--hz-c-ink-muted)' }}>
              {saved.enabled ? `On · payments dated from ${fmtDate(saved.fromDate)}` : 'Off'}
            </span>
          </div>
          {error && <div className={css.cardFoot} role="alert" style={{ color: 'var(--hz-dk-err, #a83434)' }}>{error}</div>}
          <div className={css.cardFoot}>
            One deposit invoice per customer payment received before the order’s final invoice — Dr the customer, Cr the deposit
            account. Payments dated before the day are left alone; the ones the day leaves without an invoice, and the delivered
            orders still without a final invoice, wait at the head of Money in › Invoices with their buttons.
          </div>
        </section>
      )}
    </div>
  );
}
