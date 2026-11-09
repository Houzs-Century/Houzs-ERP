/* A delivery return's money side (backlog A1): where its credit note stands,
   the notes raised from it, and — while one is awaited — the way to raise it,
   filled from the return at the invoiced price. */

import { Link, useNavigate } from 'react-router-dom';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { RETURN_CREDIT_TONE, returnCreditLabel, type ReturnCreditState } from '../../vendor/scm/lib/return-credit-state';

export type ReturnCreditNote = { state: ReturnCreditState; notes: Array<{ id: string; number: string; status: string }> };

export const createCreditNoteHref = (returnId: string): string =>
  `/scm/credit-notes?form=new&fromReturn=${encodeURIComponent(returnId)}`;

export function ReturnCreditNoteCard({ returnId, credit, cancelled, canCreate }: {
  returnId: string;
  credit: ReturnCreditNote | null | undefined;
  cancelled: boolean;
  /** scm.payment_voucher.create / .write — the server's own keys for raising a note. */
  canCreate: boolean;
}) {
  const navigate = useNavigate();
  if (!credit || cancelled) return null;
  return (
    <div className="mb-4 rounded-lg border border-border bg-surface px-4 py-3" aria-label="Credit note">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">Credit note</span>
          <Badge tone={RETURN_CREDIT_TONE[credit.state]} size="sm">{returnCreditLabel(credit.state)}</Badge>
          {credit.notes.map((n) => (
            <Link key={n.id} to={`/scm/credit-notes/${encodeURIComponent(n.id)}`} className="font-mono text-[12.5px] font-semibold text-primary-ink hover:underline">
              {n.number} <span className="text-ink-muted">({n.status.toLowerCase()})</span>
            </Link>
          ))}
        </div>
        {credit.state === 'AWAITING' && canCreate && (
          <Button variant="primary" onClick={() => navigate(createCreditNoteHref(returnId))}>Create credit note</Button>
        )}
      </div>
      {credit.state === 'AWAITING' && !canCreate && (
        <div className="mt-1 text-[12px] text-ink-muted">Finance raises it from here — you do not have the credit note permission.</div>
      )}
    </div>
  );
}
