// ----------------------------------------------------------------------------
// FairFallback — the two controls the SO form shows when NO fair event is picked
// yet, shared by the desktop (SalesOrderNew) and mobile (MobileNewSO) forms so
// the owner's one-logic-two-surfaces rule holds and neither giant form carries
// its own copy.
//
//  1. "Earlier fair? Order date" (owner's keyer backlog — orders written up after
//     the fact). The create form stamps so_date = today, so its fair dropdown is
//     anchored to today's 4-week window and a fair that ran earlier is never
//     offered — the keyer was forced onto "Others" (a bare venue the
//     no-fair-no-save gate rejects). This date re-anchors the fair list
//     (GET /fair-options?date=) and the Fair Day cap to the order's real date, so
//     the fair running THEN is offered and can be picked and attributed. It moves
//     ONLY which fairs are offered, never the SO's own date (the server still
//     stamps today; a picked past fair links by its own period). A DateField, not
//     a native date input, so it reads YYYY/MM/DD regardless of the OS locale.
//  2. "No fair (showroom / direct sale)" — the escape hatch that satisfies the
//     compulsory-fair rule for a genuine non-fair sale (owner 2026-09-26).
//
// Renders nothing once a fair event is picked (the two are mutually exclusive) or
// when `enabled` is false (e.g. a confirmed edit on mobile).
// ----------------------------------------------------------------------------

import { DateField } from '../vendor/scm/components/DateField';
import { fairEventOf } from './fairPick';
import type { FairPickValue } from './FairPicker';

export type FairFallbackProps = {
  /** Gate for the whole control beyond "no event picked" — desktop passes true,
   *  mobile passes `!isEdit || isDraftSo` so a confirmed edit shows neither. */
  enabled: boolean;
  /** The current pick: both controls hide once this carries a fair EVENT. */
  value: FairPickValue;
  /** The date driving the fair list (null = today's window). */
  orderDate: string | null;
  onOrderDate: (d: string | null) => void;
  /** Today in MYT — the list never offers a fair in the future. */
  maxDate: string;
  noFair: boolean;
  onNoFair: (checked: boolean) => void;
  disabled?: boolean;
};

const ROW = { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, marginTop: 6 } as const;

export function FairFallback(props: FairFallbackProps) {
  if (!props.enabled || fairEventOf(props.value)) return null;
  return (
    <>
      <label style={ROW}>
        <span style={{ opacity: 0.8, whiteSpace: 'nowrap' }}>Earlier fair? Order date</span>
        <DateField
          value={props.orderDate ?? ''}
          max={props.maxDate}
          disabled={props.disabled}
          onChange={(iso) => props.onOrderDate(iso || null)}
          aria-label="Order date, for picking an earlier fair"
        />
      </label>
      <label style={{ ...ROW, cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={props.noFair}
          disabled={props.disabled}
          onChange={(e) => props.onNoFair(e.target.checked)}
        />
        <span>No fair (showroom / direct sale)</span>
      </label>
    </>
  );
}

export default FairFallback;
