/* The SO detail page's lock banner (moved out of SalesOrderDetail.tsx, which is
   at its size ceiling) plus the DEV-32 "Edit SO after DO" notice under it. */
import type { CSSProperties } from 'react';
import { Lock, Truck } from 'lucide-react';
import { Button } from '../../components/Button';
import { usePrompt } from '../../vendor/scm/components/PromptDialog';
import { LOCKED_STATUSES } from '../../vendor/scm/lib/so-detail-gates';
import type { AfterDoMode } from '../../vendor/scm/lib/so-after-do-client';

const ICON = { size: 16, strokeWidth: 1.75 } as const;
const INNER: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 8 };
const BOX: CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-3)', flexWrap: 'wrap',
  padding: 'var(--space-3) var(--space-4)', borderRadius: 'var(--radius-md)', fontSize: 'var(--fs-13)',
};

export function SoLockBanner({
  status, cancelled, migratedReason, overridden, onOverride, onRelock, afterDo, afterDoTargetId, onPickTarget,
}: {
  status: string;
  cancelled: boolean;
  /** Non-null = the order is carried over from AutoCount and view-only. */
  migratedReason: string | null;
  overridden: boolean;
  onOverride: () => void;
  onRelock: () => void;
  afterDo: AfterDoMode;
  afterDoTargetId: string | null;
  onPickTarget: (doId: string | null) => void;
}) {
  const askPrompt = usePrompt();
  const migrated = migratedReason != null;
  const showLock = !cancelled && (migrated || LOCKED_STATUSES.includes(status));
  const doNumbers = (list: AfterDoMode['targets']) => list.map((t) => t.do_number ?? t.id).join(', ');
  const lockedTargets = afterDo.targets.filter((t) => t.locked);
  return (
    <>
      {showLock && (
        <div style={{
          ...BOX,
          background: overridden ? 'rgba(184, 51, 31, 0.06)' : 'rgba(232, 107, 58, 0.08)',
          border: `1px solid ${overridden ? 'var(--c-festive-b, #B8331F)' : 'var(--c-orange)'}`,
        }}>
          <span style={INNER}>
            <Lock {...ICON} />
            {migrated ? <><strong>View only — carried over from AutoCount.</strong> {migratedReason}</>
              : overridden ? <strong>Edit-lock overridden — changes are tracked in the status timeline below.</strong>
              : <>This SO is <strong>{status.replace(/_/g, ' ')}</strong>. Line item edits + addresses are locked. Click <em>Override</em> if you must change something.</>}
          </span>
          <Button variant={overridden ? 'ghost' : 'primary'} disabled={migrated}
            onClick={async () => {
              if (overridden) { onRelock(); return; }
              const reason = await askPrompt({
                title: 'Reason for override?',
                body: 'This unlocks editing on a locked SO. The override is tracked in the status timeline.',
                placeholder: 'At least 10 characters',
                multiline: true,
                confirmLabel: 'Override',
                validate: (v) => (v.trim().length < 10 ? 'Override needs a reason ≥ 10 chars.' : null),
              });
              if (reason != null) onOverride();
            }}>
            {overridden ? 'Re-lock' : 'Override'}
          </Button>
        </div>
      )}
      {afterDo.on && (
        <div data-testid="so-after-do-notice" style={{ ...BOX, background: 'var(--c-surface-2, rgba(31, 92, 72, 0.06))', border: '1px solid var(--c-border, #c9d6cf)' }}>
          <span style={INNER}>
            <Truck {...ICON} />
            <span>
              <strong>Edit after DO.</strong>{' '}
              {afterDo.headerOpen
                ? <>Customer name, phone, email, address and contact, and charge lines (transport, storage, misc), are copied onto {doNumbers(afterDo.openTargets)} when you save.</>
                : <>Charge lines (transport, storage, misc) can be added or changed. Customer details stay locked: {doNumbers(lockedTargets)} already has an invoice or return.</>}
            </span>
          </span>
          {afterDo.openTargets.length > 1 && (
            <label style={INNER}>
              <span>New charge lines go on</span>
              <select aria-label="Delivery Order for new charge lines" value={afterDoTargetId ?? ''} onChange={(e) => onPickTarget(e.target.value || null)}>
                <option value="">Pick a DO</option>
                {afterDo.openTargets.map((t) => <option key={t.id} value={t.id}>{t.do_number ?? t.id}</option>)}
              </select>
            </label>
          )}
        </div>
      )}
    </>
  );
}
