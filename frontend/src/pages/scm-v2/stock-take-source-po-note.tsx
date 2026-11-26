import { useState, type ReactElement } from 'react';
import { fmtQty } from '@2990s/shared';

export interface SourcePo {
  po: string;
  qty: number;
}

export interface SourcePoNoteProps {
  sourcePos: SourcePo[];
  systemQty: number | null;
  inGroup: boolean;
}

export const SOURCE_PO_PREVIEW = 3;

/* HC-0158: the PO(s) behind the bucket's open lots, so sofa / bedframe stock
   can be traced; the rest of a positive system qty came in without one. That
   remainder is only named beside a PO or on a variant model's line: on a plain
   SKU it is AC opening stock on every row and says nothing. */
export function SourcePoNote({ sourcePos, systemQty, inGroup }: SourcePoNoteProps): ReactElement | null {
  const [showAll, setShowAll] = useState(false);
  const traced = sourcePos.reduce((s, p) => s + p.qty, 0);
  const untraced = (inGroup || traced > 0) && systemQty != null && systemQty > traced
    ? systemQty - traced : 0;
  if (sourcePos.length === 0 && untraced === 0) return null;
  const hidden = sourcePos.length - SOURCE_PO_PREVIEW;
  const shown = showAll || hidden <= 0 ? sourcePos : sourcePos.slice(0, SOURCE_PO_PREVIEW);
  return (
    <div data-testid="source-po-note" style={{ marginTop: 2, fontSize: 'var(--fs-11)', color: 'var(--fg-muted)', display: 'flex', flexWrap: 'wrap', columnGap: 8 }}>
      {shown.map((p) => (
        <span key={p.po} style={{ whiteSpace: 'nowrap' }}>
          <span style={{ fontFamily: 'var(--font-mono)' }}>{p.po}</span> × {fmtQty(p.qty)}
        </span>
      ))}
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          aria-expanded={showAll}
          style={{
            border: 'none', background: 'transparent', padding: 0, cursor: 'pointer',
            font: 'inherit', color: 'var(--c-burnt, #a6471e)', textDecoration: 'underline', whiteSpace: 'nowrap',
          }}
        >
          {showAll ? 'Show less' : `+ ${hidden} more`}
        </button>
      )}
      {untraced > 0 && <span style={{ whiteSpace: 'nowrap' }}>{fmtQty(untraced)} without PO</span>}
    </div>
  );
}
