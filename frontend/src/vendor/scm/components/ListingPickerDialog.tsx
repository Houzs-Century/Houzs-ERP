// ----------------------------------------------------------------------------
// ListingPickerDialog — Task #120, AutoCount-style "Listing" picker.
//
// Replaces / augments the single "Print Listing" button on the Sales Order
// family L1 pages (Sales Orders, Delivery Orders, Sales Invoices,
// Delivery Returns). Opens a small modal with four radio-button choices:
//
//   1. Listing                     — stay on the current L1 page (refresh)
//   2. Detail Listing              — navigate to the module's L2 page
//   3. Outstanding Listing         — apply ?outstanding=1 to the current L1
//   4. Outstanding Detail Listing  — L2 with ?outstanding=1
//
// L2 routes for modules that don't have one yet are flagged as disabled with
// a "coming soon" hint.
// ----------------------------------------------------------------------------

import { useEffect, useState } from 'react';
import { ListChecks, ChevronDown, X } from 'lucide-react';
import { Button } from '@2990s/design-system';
import styles from './ListingPickerDialog.module.css';

export type ListingChoice =
  | 'listing'
  | 'detail-listing'
  | 'outstanding-listing'
  | 'outstanding-detail-listing';

export type ListingPickerOption = {
  value: ListingChoice;
  label: string;
  hint?: string;
  disabled?: boolean;
};

/** Default 4-option set used by every SO-family list. Pages override by
 *  passing { detailRoute, outstanding } — `disabled` is computed from
 *  whether detailRoute is null (module doesn't have an L2 page yet). */
export function defaultOptions(opts: {
  detailListingAvailable: boolean;
}): ListingPickerOption[] {
  return [
    {
      value: 'listing',
      label: 'Listing',
      hint: 'One row per document — the current view.',
    },
    {
      value: 'detail-listing',
      label: 'Detail Listing',
      hint: opts.detailListingAvailable
        ? 'One row per line item across all documents.'
        : 'Line-item drill-down — coming soon.',
      disabled: !opts.detailListingAvailable,
    },
    {
      value: 'outstanding-listing',
      label: 'Outstanding Listing',
      hint: 'Same as Listing, filtered to outstanding balance > 0.',
    },
    {
      value: 'outstanding-detail-listing',
      label: 'Outstanding Detail Listing',
      hint: opts.detailListingAvailable
        ? 'Detail Listing filtered to outstanding balance > 0.'
        : 'Line-item drill-down — coming soon.',
      disabled: !opts.detailListingAvailable,
    },
  ];
}

export interface ListingPickerDialogProps {
  open: boolean;
  onClose: () => void;
  /** Fired when commander clicks OK after picking a non-disabled option. */
  onChoose: (choice: ListingChoice) => void;
  /** Whether the module has a Detail Listing (L2) page wired up. */
  detailListingAvailable: boolean;
  title?: string;
  /** Initially-selected option. Defaults to "listing". */
  initial?: ListingChoice;
}

export const ListingPickerDialog = ({
  open,
  onClose,
  onChoose,
  detailListingAvailable,
  title = 'Listing',
  initial = 'listing',
}: ListingPickerDialogProps) => {
  const [picked, setPicked] = useState<ListingChoice>(initial);
  const options = defaultOptions({ detailListingAvailable });

  // Reset picked when reopened.
  useEffect(() => { if (open) setPicked(initial); }, [open, initial]);

  // Escape to close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const submit = () => {
    const opt = options.find((o) => o.value === picked);
    if (!opt || opt.disabled) return;
    onChoose(picked);
    onClose();
  };

  return (
    <div
      className={styles.backdrop}
      role="dialog"
      aria-modal="true"
      aria-labelledby="listing-picker-title"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className={styles.modal}>
        <header className={styles.header}>
          <h2 id="listing-picker-title" className={styles.title}>{title}</h2>
          <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="Close">
            <X size={16} strokeWidth={1.75} />
          </button>
        </header>

        <div className={styles.body}>
          {options.map((opt) => {
            const checked = picked === opt.value;
            return (
              <label
                key={opt.value}
                className={[
                  styles.option,
                  checked ? styles.optionSelected : '',
                  opt.disabled ? styles.optionDisabled : '',
                ].filter(Boolean).join(' ')}
              >
                <input
                  type="radio"
                  name="listing-picker"
                  value={opt.value}
                  checked={checked}
                  disabled={opt.disabled}
                  onChange={() => setPicked(opt.value)}
                  className={styles.radio}
                />
                <div className={styles.optionText}>
                  <span className={styles.optionLabel}>{opt.label}</span>
                  {opt.hint && <span className={styles.optionHint}>{opt.hint}</span>}
                </div>
              </label>
            );
          })}
        </div>

        <footer className={styles.footer}>
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            size="sm"
            onClick={submit}
            disabled={options.find((o) => o.value === picked)?.disabled}
          >
            OK
          </Button>
        </footer>
      </div>
    </div>
  );
};

/** Toolbar button that opens the picker. Looks like the other toolbar
 *  entries with a chevron-down suffix to signal "menu". */
export const ListingPickerTrigger = ({
  onClick,
  label = 'Listing',
}: { onClick: () => void; label?: string }) => (
  <button type="button" className={styles.triggerBtn} onClick={onClick} title={`${label} — pick L1 / L2 / outstanding`}>
    <ListChecks size={14} strokeWidth={1.75} />
    <span>{label}</span>
    <ChevronDown size={14} strokeWidth={1.75} />
  </button>
);
