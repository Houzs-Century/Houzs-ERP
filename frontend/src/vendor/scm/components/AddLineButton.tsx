// ----------------------------------------------------------------------------
// AddLineButton — the ONE add-a-line control for every line-item editor.
//
// Option A of the add-line unification (owner 2026-09-18): make the add-line
// affordance look and read the same on every document form, WITHOUT touching
// any form's row content, validation or save. This component owns only the
// chrome — the icon, the label, and the two visual shapes the forms already
// used — so a form drops its hand-rolled button for this and nothing about
// what it saves changes.
//
// The label is the single canonical name `ADD_LINE_LABEL` (add-line-handoff.ts,
// owner ruling 2026-09-13: four pages had spelled it four ways). Two variants:
//   • "block"  — full-width dashed button under a stack of line CARDS (the shape
//                SalesOrderNew / SalesInvoiceNew / Consignment*New / DO new each
//                hand-rolled inline).
//   • "ghost"  — the compact house ghost button used in a table header / the
//                bottom add-line row of the `<table>` editors (Stock Transfer,
//                Stock Adjustment, finance tables).
// ----------------------------------------------------------------------------

import { Plus } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { ADD_LINE_LABEL } from '../lib/add-line-handoff';
import styles from './AddLineButton.module.css';

export type AddLineButtonProps = {
  onClick: () => void;
  /** "block" = full-width dashed card affordance; "ghost" = compact table button. */
  variant?: 'block' | 'ghost';
  /** House Button size for the ghost variant (ignored by block). */
  size?: 'sm' | 'md';
  disabled?: boolean;
  /** Override the label only for a genuinely different action; defaults to the
   *  canonical add-line name so every editor reads identically. */
  label?: string;
};

export function AddLineButton({
  onClick,
  variant = 'block',
  size = 'sm',
  disabled = false,
  label = ADD_LINE_LABEL,
}: AddLineButtonProps) {
  if (variant === 'ghost') {
    return (
      <Button variant="ghost" size={size} onClick={onClick} disabled={disabled}>
        <Plus size={14} strokeWidth={1.75} /> {label}
      </Button>
    );
  }
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={styles.block}>
      <Plus size={16} strokeWidth={1.75} /> {label}
    </button>
  );
}
