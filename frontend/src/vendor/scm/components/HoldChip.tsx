/* ----------------------------------------------------------------------------
   HoldChip — the ONE way a paused document is shown, on all five documents.

   THE OWNER, 2026-08-22: 「我们的hold是给我们知道一个 order hold这的」 — the hold
   is there so people KNOW an order is paused.

   IT SITS BESIDE THE STATUS PILL AND NEVER REPLACES IT, which is the whole
   change. Before mig 0324 the hold WAS the status: an order in production that
   went on hold stopped saying "In Production" anywhere on any screen, and the
   only record that it had ever been in production was gone from the database
   too. Now the row says both — In Production · Hold — and the reader gets the
   two facts he actually needs: where the order is, and that nobody is moving it.

   ONE COMPONENT, NOT SIXTEEN. `docs/modules/document-status-vocabulary.md`
   records that sixteen list and detail pages each declare their own status map,
   and calls the root fix OPEN. This does not fix that — but it refuses to add a
   seventeenth copy of anything: the chip's words and colour are decided here,
   once, so a Hold cannot come to mean two different things on two screens.

   THE TONE IS `pending`, NOT `danger`. A hold is reversible and deliberate. Red
   is what this system uses for cancelled and for money that went wrong, and
   colouring a hold the same way would make a routine pause read as a failure.
   ---------------------------------------------------------------------------- */

import { Badge } from '../../../components/Badge';
import { STATUS_TONES } from '../lib/status-pill';
import styles from './StatusPill.module.css';

export type HoldChipProps = {
  /** `mfg_sales_orders.on_hold` and its four siblings (mig 0324). */
  onHold: boolean | null | undefined;
  /** `hold_reason` — shown as the hover title when the operator gave one. */
  reason?: string | null;
  className?: string;
};

/**
 * Renders nothing at all unless the document is held.
 *
 * Returning `null` rather than an empty span matters on the list grids: a
 * zero-width element still consumes a flex gap, and every row on every one of
 * the five lists would have gained one.
 */
export function HoldChip({ onHold, reason, className }: HoldChipProps) {
  if (onHold !== true) return null;
  const { bg, fg } = STATUS_TONES.pending;
  const label = 'Hold';
  return (
    <span
      className={`${styles.pill} ${className ?? ''}`}
      style={{ background: bg, color: fg }}
      title={reason ? `On hold: ${reason}` : 'On hold'}
    >
      {label}
    </span>
  );
}

/** The shape every list row and detail record carries since mig 0324. Exported
 *  so a page can spread it into its own row type instead of re-typing four
 *  fields per screen and getting one of them wrong. */
export type HoldFields = {
  on_hold?: boolean | null;
  hold_reason?: string | null;
  held_at?: string | null;
  held_by?: string | null;
};

/** Is this row held? The FLAG, or the retired `ON_HOLD` status a legacy row may
 *  still carry — the browser half of backend `isDocumentHeld`. Postgres cannot
 *  drop an enum label, so the second arm is permanent even though production
 *  carried zero such rows when the flag shipped (workflow run 32573160010). */
export function rowIsHeld(row: HoldFields & { status?: string | null } | null | undefined): boolean {
  if (!row) return false;
  if (row.on_hold === true) return true;
  return String(row.status ?? '').toUpperCase() === 'ON_HOLD';
}

/* ── StatusWithHold ─────────────────────────────────────────────────────────
   The status pill AND the hold marker, as one element, because on every list
   and every drawer they are read as one thing: *where is this document, and is
   anybody allowed to move it.*

   IT EXISTS SO THE PAIRING CANNOT BE SPLIT. A page that renders the pill alone
   is a page where a held document looks free to act on, and that is precisely
   the failure mig 0324 removed from the database. One component means the two
   arrive together or not at all. It also keeps five list screens under their
   size ceilings, which is what forced the question. */
export function StatusWithHold({ tone, label, row, size = "xs" }: {
  tone: "success" | "warning" | "error" | "neutral";
  label: string;
  row: HoldFields;
  size?: "xs" | "sm";
}) {
  return (
    <span className="inline-flex items-center gap-1">
      <Badge tone={tone} size={size}>{label}</Badge>
      <HoldChip onHold={row.on_hold} reason={row.hold_reason} />
    </span>
  );
}
