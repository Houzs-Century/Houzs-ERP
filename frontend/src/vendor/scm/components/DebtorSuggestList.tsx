
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
