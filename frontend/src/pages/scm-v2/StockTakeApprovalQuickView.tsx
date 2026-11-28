// ----------------------------------------------------------------------------
// StockTakeApprovalQuickView — the side drawer a SINGLE click on a Stock Take
// Approvals row opens (owner 2026-11-24: 「像 payment backdate request」, the way
// a backdate request row opens BackdateRequestQuickView). Double-click opens the
// full stock take.
//
// Everything a supervisor needs to sign off an over-limit count is here: who
// submitted it and when, the warehouse and scope, the variance summary, and the
// variance lines themselves (SKU, system, counted, +/-, RM). The footer carries
// the same Approve & post / Return the row's Actions column does — both go
// through useApprove/RejectStockTake, so the drawer can never decide differently
// from the row. A decision closes the drawer; the row leaves the Pending list.
// ----------------------------------------------------------------------------

import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { ExternalLink, X as XIcon } from 'lucide-react';
import { fmtDate, fmtDateTime, fmtMoneySen, fmtQty } from '../../../../shared/src/vendor/shared/format';
import { ResizableDetailDrawer } from '../../components/ResizableDetailDrawer';
import { StatusPill } from '../../vendor/scm/components/StatusPill';
import { warehouseLabel } from '../../vendor/scm/lib/warehouse-label';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { useStaffLookup } from '../../hooks/useStaffLookup';
import {
  useStockTakeDetail, useApproveStockTake, useRejectStockTake,
  type StockTakeRow, type StockTakeLine,
} from '../../vendor/scm/lib/stock-queries';

export const stockTakePath = (r: Pick<StockTakeRow, 'id'>): string => `/scm/stock-takes/${r.id}`;

const scopeLabel = (scopeType: string, scopeValue: string | null): string => {
  if (scopeType === 'CATEGORY') return `Category · ${scopeValue ?? ''}`;
  if (scopeType === 'CODE_PREFIX') return `Code starts with · ${scopeValue ?? ''}`;
  if (scopeType === 'NONZERO') return 'Only SKUs with stock';
  return 'All SKUs';
};

const lineValueSen = (l: StockTakeLine): number | null =>
  l.variance == null || l.est_unit_cost_sen == null ? null : l.variance * l.est_unit_cost_sen;

const signedRM = (sen: number): string => `${sen > 0 ? '+' : sen < 0 ? '−' : ''}${fmtMoneySen(Math.abs(sen))}`;

export function StockTakeApprovalQuickView({ row, onClose }: { row: StockTakeRow | null; onClose: () => void }) {
  return (
    <ResizableDetailDrawer
      open={row != null}
      onClose={onClose}
      ariaLabel={row ? `Stock take approval ${row.take_no}` : 'Stock take approval details'}
    >
      {row && <Body key={row.id} row={row} onClose={onClose} />}
    </ResizableDetailDrawer>
  );
}

function Body({ row, onClose }: { row: StockTakeRow; onClose: () => void }) {
  const navigate = useNavigate();
  const notify = useNotify();
  const { actorNameOf } = useStaffLookup();
  const detail = useStockTakeDetail(row.id);
  const approve = useApproveStockTake();
  const reject = useRejectStockTake();

  const take = detail.data?.take ?? row;
  const lines = detail.data?.lines ?? [];
  const viewer = detail.data?.viewer;
  const open = take.status === 'PENDING_APPROVAL';
  const canDecide = open && (viewer?.canSupervise ?? false);
  const busy = approve.isPending || reject.isPending;

  const varianceLines = lines.filter((l) => (l.variance ?? 0) !== 0);
  const netQty = varianceLines.reduce((s, l) => s + (l.variance ?? 0), 0);
  const netSen = varianceLines.reduce((s, l) => s + (lineValueSen(l) ?? 0), 0);
  const uncosted = varianceLines.filter((l) => l.variance != null && l.variance > 0 && l.est_unit_cost_sen == null).length;

  const onApprove = () => {
    approve.mutate(row.id, {
      onSuccess: () => { onClose(); void notify({ title: `${take.take_no} approved`, body: 'The count is posted and stock updated.' }); },
      onError: (err) => { void notify({ title: "Couldn't approve", body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' }); },
    });
  };
  const onReject = () => {
    reject.mutate(row.id, {
      onSuccess: () => { onClose(); void notify({ title: `${take.take_no} returned`, body: 'Sent back to Open for a recount.' }); },
      onError: (err) => { void notify({ title: "Couldn't return", body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' }); },
    });
  };

  return (
    <>
      <div className="flex h-[60px] shrink-0 items-center gap-3 bg-sidebar px-5 text-sidebar-ink">
        <button type="button" onClick={onClose} className="text-sidebar-ink-muted hover:text-sidebar-ink" aria-label="Close details">
          <XIcon size={18} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-[14px] font-bold tracking-wide">{take.take_no}</div>
          <div className="mt-0.5 text-[11px] text-sidebar-ink-muted">Stock take approval</div>
        </div>
        <button
          type="button"
          onClick={() => navigate(stockTakePath(row))}
          className="inline-flex items-center gap-1.5 rounded-md border border-accent-bright/40 px-2.5 py-1.5 text-[11.5px] font-semibold text-accent-bright hover:bg-accent-bright/10"
        >
          Open stock take <ExternalLink size={12} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-5">
        <div className="flex flex-wrap items-center gap-2.5">
          <StatusPill docType="stockTake" status={take.status} />
          <span className="text-[12.5px] text-ink-muted">{warehouseLabel(take.warehouse) ?? take.warehouse_id}</span>
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg border border-border bg-surface-2 px-4 py-4">
          <MetaItem k="Scope" v={scopeLabel(take.scope_type, take.scope_value)} />
          <MetaItem k="Take date" v={fmtDate(take.take_date)} />
          <MetaItem k="Submitted by" v={take.submitted_by ? actorNameOf(take.submitted_by) : '—'} />
          <MetaItem k="Submitted" v={take.submitted_at ? fmtDateTime(take.submitted_at) : '—'} />
        </dl>

        <div className="mt-4 grid grid-cols-3 gap-3">
          <Stat k="Variance lines" v={String(varianceLines.length)} />
          <Stat k="Net qty" v={`${netQty > 0 ? '+' : ''}${fmtQty(netQty)}`} />
          <Stat k="Net value" v={netSen === 0 ? '—' : signedRM(netSen)} tone={netSen > 0 ? 'ok' : netSen < 0 ? 'err' : undefined} />
        </div>
        {uncosted > 0 && (
          <div className="mt-3 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-[12px] text-ink">
            {uncosted} found line{uncosted === 1 ? '' : 's'} with no cost on record — those must carry a cost before this can post.
          </div>
        )}

        <SectionHeading>Variance lines</SectionHeading>
        {varianceLines.length === 0 ? (
          <div className="text-[12px] text-ink-muted">No variance — counted equals the system on every line.</div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full border-collapse text-[12px]">
              <thead>
                <tr className="bg-surface-2 text-ink-muted">
                  <th className="px-3 py-2 text-left font-semibold">SKU</th>
                  <th className="px-2 py-2 text-right font-semibold">System</th>
                  <th className="px-2 py-2 text-right font-semibold">Counted</th>
                  <th className="px-2 py-2 text-right font-semibold">+/−</th>
                  <th className="px-3 py-2 text-right font-semibold">RM</th>
                </tr>
              </thead>
              <tbody>
                {varianceLines.map((l) => {
                  const v = l.variance ?? 0;
                  const val = lineValueSen(l);
                  return (
                    <tr key={l.id} className="border-t border-border">
                      <td className="px-3 py-1.5">
                        <div className="font-mono text-ink">{l.item_code}</div>
                        {l.variant_label && <div className="text-[10.5px] text-ink-muted">{l.variant_label}</div>}
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono tabular-nums">{l.system_qty == null ? '—' : fmtQty(l.system_qty)}</td>
                      <td className="px-2 py-1.5 text-right font-mono tabular-nums">{l.counted_qty == null ? '—' : fmtQty(l.counted_qty)}</td>
                      <td className={`px-2 py-1.5 text-right font-mono tabular-nums font-semibold ${v > 0 ? 'text-ok' : 'text-err'}`}>{v > 0 ? '+' : ''}{fmtQty(v)}</td>
                      <td className="px-3 py-1.5 text-right font-mono tabular-nums">{val == null ? '—' : signedRM(val)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {open && (
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border bg-surface px-5 py-3">
          {canDecide ? (
            <>
              <div className="text-[12px] text-ink-muted">Approve posts the count and updates stock.</div>
              <div className="flex shrink-0 gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={onReject}
                  className="rounded-md border border-err/50 px-3 py-1.5 text-[12px] font-semibold text-err hover:bg-err/10 disabled:opacity-50"
                >
                  {reject.isPending ? 'Returning…' : 'Return to Open'}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={onApprove}
                  className="rounded-md bg-primary px-3 py-1.5 text-[12px] font-semibold text-primary-ink hover:opacity-90 disabled:opacity-50"
                >
                  {approve.isPending ? 'Approving…' : 'Approve & post'}
                </button>
              </div>
            </>
          ) : (
            <div className="text-[12px] text-ink-muted">Only a stock-take supervisor can decide this count.</div>
          )}
        </div>
      )}
    </>
  );
}

function MetaItem({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">{k}</dt>
      <dd className="mt-0.5 truncate text-[13px] font-semibold text-ink">{v}</dd>
    </div>
  );
}

function Stat({ k, v, tone }: { k: string; v: string; tone?: 'ok' | 'err' }) {
  return (
    <div className="rounded-lg border border-border bg-surface-2 px-3 py-2.5">
      <div className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">{k}</div>
      <div className={`mt-1 font-mono text-[15px] font-bold tabular-nums ${tone === 'ok' ? 'text-ok' : tone === 'err' ? 'text-err' : 'text-ink'}`}>{v}</div>
    </div>
  );
}

function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <div className="mb-2.5 mt-6 font-mono text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
      {children}
    </div>
  );
}
