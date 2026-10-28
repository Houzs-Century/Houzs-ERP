// RelationshipMapButton — drop-in trigger for the document Relationship Map.
// Bundles the button + modal + open state so a detail page only needs:
//   <RelationshipMapButton type="so" id={docNo} />

import { useState } from 'react';
import { DocumentFlowModal } from './DocumentFlowModal';
import type { FlowNodeType } from '../lib/flow-queries';

type Props = { type: FlowNodeType; id: string | null | undefined; style?: React.CSSProperties };

export function RelationshipMapButton({ type, id, style }: Props) {
  const [open, setOpen] = useState(false);
  if (!id) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6, height: 36, padding: '0 14px',
          borderRadius: 999, border: '1px solid var(--c-line)', background: 'white',
          color: 'var(--c-ink)', font: 'inherit', cursor: 'pointer', ...style,
        }}
      >
        Relationship Map
      </button>
      <DocumentFlowModal type={type} id={id} open={open} onClose={() => setOpen(false)} />
    </>
  );
}
