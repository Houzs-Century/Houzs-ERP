// ----------------------------------------------------------------------------
// PvDocParts — the payment voucher page's redesign pieces (the owner's Claude
// Design, batch 4): the stage tag, the books line, the trail read inline, and
// Add task with the voucher already linked. Every figure is the voucher's own;
// nothing here posts.
// ----------------------------------------------------------------------------

import { History } from 'lucide-react';
import { fmtDateTime, todayMY } from '../../vendor/shared/format';
import { fmtMoneySen } from '@2990s/shared';
import { useEntityAuditLog } from '../../vendor/scm/lib/entity-audit-queries';
import { useTodoSettings, type TaskLink } from './finance/finance-todo-queries';
import { AddTaskDrawer } from './finance/TaskDrawers';
import styles from './SalesOrderDetail.module.css';
import mo from './MoneyOut.module.css';

type Pv = Record<string, unknown>;

/** Where the voucher stands, in the design's words: the four layers ride on a DRAFT as marks. */
export const pvStage = (pv: Pv): 'Draft' | 'Prepared' | 'Checked' | 'Approved' | 'Cancelled' =>
  pv.status === 'CANCELLED' ? 'Cancelled' : pv.status === 'POSTED' ? 'Approved' : pv.checked_at ? 'Checked' : pv.submitted_at ? 'Prepared' : 'Draft';

export function StageTag({ pv }: { pv: Pv }) {
  const s = pvStage(pv);
  const tone = s === 'Prepared' ? mo.toneWarn : s === 'Checked' ? mo.toneInfo : s === 'Cancelled' ? mo.toneLate : mo.toneCalm;
  return <span className={`${mo.tag} ${tone}`}>{s}</span>;
}

/** The books line: whether it has posted, debit to credit, and the money (the design). */
export function BooksLine({ pv, lines, accountName }: {
  pv: Pv; lines: Array<Record<string, unknown>>; accountName: (code: string) => string | null;
}) {
  const jeNo = (pv.je_no as string | null | undefined) ?? null;
  const state = pv.status === 'POSTED' ? 'Posted' : pv.status === 'CANCELLED' ? (jeNo ? 'Reversed' : 'Never posted') : 'Posts at approval';
  const named = (code: string) => { const n = accountName(code); return n ? `${code} ${n}` : code; };
  const debits = [...new Set(lines.map((l) => String(l.debit_account_code ?? '')).filter(Boolean))].map(named).join(', ');
  const credit = pv.credit_account_code ? named(String(pv.credit_account_code)) : '—';
  const currency = String(pv.currency ?? 'MYR').toUpperCase();
  const charge = Number(pv.bank_charge_sen ?? 0);
  return (
    <div className={mo.booksLine}>
      <b>{state}</b> · Dr {debits || '—'} · Cr {credit} · {fmtMoneySen(Number(pv.total_sen ?? 0), currency)}
      {currency !== 'MYR' ? ` · ${currency} at ${String(pv.exchange_rate ?? '1')}` : ''}
      {charge > 0 ? ` · bank charge ${fmtMoneySen(charge, 'MYR')} besides` : ''}
    </div>
  );
}

const actionWord = (a: string): string => {
  const t = a.replace(/[_-]+/g, ' ').trim();
  return t ? t[0]!.toUpperCase() + t.slice(1).toLowerCase() : 'Changed';
};

/** The trail, read inline: who did what and when, the reject reasons with it (the design). */
export function PvTrail({ pvId, onFullHistory }: { pvId: string; onFullHistory: () => void }) {
  const q = useEntityAuditLog('PAYMENT_VOUCHER', pvId);
  const entries = q.data ?? [];
  return (
    <section className={styles.card}>
      <div className={styles.cardHeader}>
        <h2 className={styles.cardTitle}>Trail</h2>
        <button type="button" className={mo.actLink} onClick={onFullHistory}><History size={13} /> Full history ›</button>
      </div>
      <div className={styles.cardBody}>
        {q.isLoading && <div className={mo.hint}>Reading the trail…</div>}
        {q.isError && <div className={mo.hint}>The trail did not load. Full history › opens it on its own.</div>}
        {entries.length > 0 && (
          <ol className={mo.trail}>
            {entries.slice(0, 8).map((e) => (
              <li key={e.id}>
                <b>{actionWord(e.action)}</b>{e.status_snapshot ? ` · ${actionWord(e.status_snapshot)}` : ''}
                <span className={mo.trailWho}> · {e.actor_name_snapshot ?? 'System'} · {fmtDateTime(e.created_at)}</span>
                {e.note && <div className={mo.trailNote}>“{e.note}”</div>}
              </li>
            ))}
          </ol>
        )}
        {entries.length > 8 && <div className={mo.hint}>{entries.length - 8} earlier step{entries.length - 8 === 1 ? '' : 's'} in Full history ›</div>}
        <div className={mo.hint}>Every voucher walks all four steps. Check and approve can be the same person if they hold both rights.</div>
      </div>
    </section>
  );
}

/** Add task with this voucher already linked; the groups come from To do's settings. */
export function VoucherTaskDrawer({ link, onClose }: { link: TaskLink; onClose: () => void }) {
  const settings = useTodoSettings();
  if (!settings.data) return null;
  return <AddTaskDrawer open onClose={onClose} today={todayMY()} groups={settings.data.groups} initialLink={link} />;
}
