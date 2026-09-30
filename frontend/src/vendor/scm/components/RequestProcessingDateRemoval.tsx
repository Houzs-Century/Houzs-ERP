/* Request a Processing Date removal for the Purchaser to approve (owner
   2026-09-30: 「还没锁定的也是 purchaser 可以审批」). For someone WITHOUT
   `scm.so.remove_processing_date` on an order that is not yet amendment-eligible:
   the direct clear is Super-Admin-only, so the removal goes out as an amendment
   (both dates cleared, LINES lane). One component for desktop and phone. */
import { useRef, type CSSProperties } from 'react';
import { useAmendmentSubmitDialog } from './AmendmentSubmitDialog';
import { useNotify } from './NotifyDialog';
import { useCreateAmendment } from '../lib/so-amendment-queries';
import { amendmentSubmittedNotice } from '../lib/so-amendment-submit';
import { PROCESSING_DATE_REMOVAL_CHANGES } from '../lib/so-amendment-header';
import { newIdempotencyKey } from '../../../lib/idempotency';

export function RequestProcessingDateRemoval({ docNo, disabled, className, style }: {
  docNo: string;
  disabled?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  const dialog = useAmendmentSubmitDialog();
  const notify = useNotify();
  const create = useCreateAmendment();
  const keyRef = useRef<string | null>(null);

  const run = async () => {
    const headerChanges = PROCESSING_DATE_REMOVAL_CHANGES;
    const answer = await dialog.ask({ docNo, lines: [], headerChanges });
    if (answer == null) return;
    keyRef.current ??= newIdempotencyKey();
    try {
      const res = await create.mutateAsync({ docNo, reason: answer.reason, lines: [], headerChanges, idempotencyKey: keyRef.current });
      keyRef.current = null;
      void notify(amendmentSubmittedNotice('AMENDMENT', res));
    } catch (e) {
      void notify({ title: 'Removal request not sent', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
    }
  };

  return (
    <>
      <button type="button" className={className} style={style} disabled={disabled || create.isPending} onClick={() => { void run(); }}>
        Request removal (Purchaser approves)
      </button>
      {dialog.element}
    </>
  );
}
