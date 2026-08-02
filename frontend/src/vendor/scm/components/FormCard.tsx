// ---------------------------------------------------------------------------
// FormCard — the Sales Order form's card + field grid, extracted so other
// masters can wear the same clothes.
//
// WHY. Owner, 2026-08-02: "我们 Create 3PL 的这个东西，它的 UI 应该要优化一下，
// 应该要像我们 Sales Order 那样子的 UI".
//
// The 3PL screen was a wrap-flex of raw inputs with hand-set pixel widths, so
// the fields queued up in whatever order they happened to fit and nothing was
// grouped. Sales Order has had a proper answer since it was built: titled cards
// with an accent rule, a four-column grid that collapses at 1100px and 640px,
// and labels that read LOUDER when the field is required.
//
// EXTRACTED, NOT COPIED. Re-typing those rules into a second page is how the two
// drift — one gets a spacing fix and the other does not. SalesOrderNew keeps its
// own module for everything specific to it (line items, totals); this is the
// shared chrome only, and it reads the SAME stylesheet, so a change to the card
// lands on every page wearing it.
// ---------------------------------------------------------------------------

import type * as React from 'react';
import type { ReactNode } from 'react';
import styles from '../../../pages/scm-v2/SalesOrderNew.module.css';

export const FormCard = ({ title, actions, children }: {
  title: string;
  /** Right-hand side of the header — a button, a count, a status chip. */
  actions?: ReactNode;
  children: ReactNode;
}) => (
  <section className={styles.card}>
    <header className={styles.cardHeader}>
      <h2 className={styles.cardTitle}>{title}</h2>
      {actions}
    </header>
    <div className={styles.cardBody}>{children}</div>
  </section>
);

/** Four columns at desktop, two at 1100px, one at 640px. */
export const FormGrid = ({ children }: { children: ReactNode }) => (
  <div className={styles.formGrid4}>{children}</div>
);

export const FormField = ({ label, required, hint, span, children }: {
  label: string;
  required?: boolean;
  /** Shown under the control — the place for a format, not a placeholder. */
  hint?: string;
  /** Widen past one column when the value is long (an address). */
  span?: number;
  children: ReactNode;
}) => (
  <label className={styles.field} style={span && span > 1 ? { gridColumn: `span ${span}` } : undefined}>
    <span className={`${styles.fieldLabel}${required ? ` ${styles.fieldLabelReq}` : ''}`}>
      {label}{required && <span className={styles.req}> *</span>}
    </span>
    {children}
    {hint && (
      <span style={{ marginTop: 4, fontSize: '10.5px', color: 'var(--fg-muted)', lineHeight: 1.3 }}>{hint}</span>
    )}
  </label>
);

/** The Sales Order text input. Exported so a page wearing this card never has
 *  to reach into another page's stylesheet for it — which is what the first
 *  draft of the 3PL rebuild did, referencing a `styles` binding that did not
 *  exist in that file at all. */
export const FormInput = (props: React.InputHTMLAttributes<HTMLInputElement>) => (
  <input {...props} className={`${styles.fieldInput}${props.className ? ` ${props.className}` : ''}`} />
);

export default FormCard;
