// DebtorSuggestList — the customer-name typeahead that hangs under the Customer
// Name field on the SO and consignment forms.
//
// It exists as a component because the same twenty lines of JSX were copied into
// four pages, and on 2026-08-15 only ONE of the four had been portalled. The
// list is `position: fixed` in a <body> portal, measured from the input: an
// absolutely positioned sibling is clipped by `.card { overflow: hidden }`, which
// on prod's New Sales Order left 130px of room for a 260px list and sliced the
// results after three rows. See lib/anchoredPanel.ts for the geometry and
// BUG-HISTORY 2026-08-15 for the measurement.
//
// `classes` is passed rather than imported because the two host stylesheets
// (SalesOrderNew.module.css, SalesOrderDetail.module.css) style these three
// class names slightly differently, and unifying the LOOK is not this fix.

import { createPortal } from 'react-dom';
import type { RefObject } from 'react';
import { formatPhone } from '@2990s/shared/phone';
import { useAnchoredPanel, anchoredPanelStyle } from '../../../lib/anchoredPanel';

/** The fields these forms read off a debtor row. Kept structural rather than
 *  importing one page's type, so all four callers satisfy it. */
export type DebtorSuggestRow = {
  debtor_code?: string | null;
  debtor_name?: string | null;
  phone?: string | null;
};

/** Ten rows of the host cards' 26px lines — the box the operators know. */
const PANEL_MAX_H = 260;
const MAX_ROWS = 8;

export function DebtorSuggestList<T extends DebtorSuggestRow>({
  anchorRef,
  open,
  suggestions,
  onPick,
  classes,
}: {
  anchorRef: RefObject<HTMLInputElement | null>;
  open: boolean;
  suggestions: T[];
  /** Fires on mouseDown so the pick lands before the input's blur closes us. */
  onPick: (row: T) => void;
  classes: { list: string; item: string; code: string };
}) {
  const pos = useAnchoredPanel(anchorRef, open && suggestions.length > 0, PANEL_MAX_H);
  if (!open || suggestions.length === 0 || !pos) return null;

  return createPortal(
    <ul className={classes.list} style={{ ...anchoredPanelStyle(pos), right: 'auto', marginTop: 0 }}>
      {suggestions.slice(0, MAX_ROWS).map((d, i) => (
        <li
          key={`${d.debtor_code ?? ''}-${i}`}
          className={classes.item}
          onMouseDown={() => onPick(d)}
        >
          <div>{d.debtor_name}</div>
          {(d.debtor_code || d.phone) && (
            <div className={classes.code}>
              {d.debtor_code ?? ''}{d.debtor_code && d.phone ? ' · ' : ''}{formatPhone(d.phone) || ''}
            </div>
          )}
        </li>
      ))}
    </ul>,
    document.body,
  );
}
