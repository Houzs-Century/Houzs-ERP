import { cn } from '../../../lib/utils';
import { Camera } from 'lucide-react';
import { fmtSen } from '../../../vendor/shared/format';
import type { StopStatus } from '../../../vendor/scm/lib/delivery-stop-status';
import { clockMY, type LorryRunVM, type DocRowVM } from './vm';
import { jobRefOf, jobKey } from '../../../vendor/scm/lib/delivery-job';
import { issuesForRow, runKeysOf, useRunDeliveryIssues } from '../../../vendor/scm/lib/delivery-issue-queries';

/** The keys a row's crew-reported delivery issues are found by. */
export function issueKeysOf(doc: DocRowVM) {
  const ref = jobRefOf(doc.order);
  return { rowType: doc.rowType, soDocNo: doc.soDocNo, doNumber: doc.doNumber, jobKey: ref ? jobKey(ref) : null };
}

const STATUS_TEXT: Record<StopStatus, { label: string; cls: string }> = {
  done: { label: 'Delivered', cls: 'text-synced' },
  active: { label: 'On the way', cls: 'text-learning' },
  overdue: { label: 'Late', cls: 'text-err' },
  scheduled: { label: 'Not started', cls: 'text-ink-muted' },
};

export type AllOrderRow = { doc: DocRowVM; run: LorryRunVM };

/** The All-orders tab: today's assigned drops flat, sorted by lorry then stop. */
export function AllOrdersTab({ rows, onOpen }: { rows: AllOrderRow[]; onOpen: (doc: DocRowVM, run: LorryRunVM) => void }) {
  const th = 'px-2 py-2 text-left font-mono text-[10px] font-semibold uppercase tracking-brand text-ink-muted';
  const td = 'px-2 py-2 text-[12.5px] text-ink';
  const issues = useRunDeliveryIssues(runKeysOf(rows.map(({ doc }) => issueKeysOf(doc)))).data;
  if (rows.length === 0) return <div className="rounded-md border border-border bg-surface p-4 text-center text-[12.5px] text-ink-muted">No orders match the current filters.</div>;
  return (
    <div className="overflow-x-auto rounded-md border border-border bg-surface">
      <table className="w-full border-collapse">
        <thead className="border-b border-border bg-surface-2">
          <tr>
            <th className={th}>Lorry</th><th className={th}>#</th><th className={th}>Status</th>
            <th className={th}>SO</th><th className={th}>DO</th><th className={th}>Ref</th>
            <th className={th}>Customer</th><th className={th}>Address</th><th className={th}>Slot</th>
            <th className={th}>Done / ETA</th><th className={th}>Amount</th><th className={th}>POD</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ doc, run }) => {
            const st = STATUS_TEXT[doc.status];
            return (
              <tr key={doc.key} className="cursor-pointer border-b border-border-subtle hover:bg-surface-2" onClick={() => onOpen(doc, run)}>
                <td className={td}>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-3 w-3 rounded-sm" style={{ background: run.color }} />
                    <span className="font-mono text-[12px]">{run.plate}</span>
                  </span>
                </td>
                <td className={cn(td, 'tabular-nums')}>{doc.stopNo ?? '—'}</td>
                <td className={cn(td, 'font-semibold', st.cls)}>
                  {st.label}{doc.late && doc.status !== 'overdue' ? ' · LATE' : ''}
                  {issuesForRow(issues, issueKeysOf(doc)).length > 0 && (
                    <span className="ml-1.5 rounded bg-err-bg px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-brand text-err">With issue</span>
                  )}
                </td>
                <td className={cn(td, 'font-mono')}>{doc.rowType === 'so' ? doc.soDocNo : (doc.codeLine || doc.soDocNo)}</td>
                <td className={cn(td, 'font-mono')}>{doc.doNumber || '—'}</td>
                <td className={cn(td, 'font-mono')}>{doc.rowType === 'so' ? (doc.ref || '—') : '—'}</td>
                <td className={td}>
                  <span className="inline-flex items-center gap-1.5">
                    {doc.jobLabel && <span className="rounded bg-[color:var(--hz-dk-surface-2,#e6eaf4)] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-brand text-learning">{doc.jobLabel}</span>}
                    {doc.customer || '—'}
                  </span>
                </td>
                <td className={cn(td, 'max-w-[220px] truncate')}>{doc.address || '—'}</td>
                <td className={td}>{doc.slotLabel || '—'}</td>
                <td className={td}>{doc.status === 'done' ? (clockMY(doc.deliveredAt) ?? 'Done') : '—'}</td>
                <td className={cn(td, 'font-mono tabular-nums')}>{doc.rowType === 'so' ? fmtSen(doc.amountSen) : '—'}</td>
                <td className={td}>{doc.hasPod ? <Camera size={14} strokeWidth={1.75} className="text-ink-muted" /> : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
