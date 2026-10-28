// A small palette dialog for the Delivery Planning row colour mark (owner
// 2026-09-26). Opened from a row's context menu; picking a swatch paints the row
// for everyone, "Clear" removes the mark. Cosmetic — it stores a colour, nothing
// else.
import { ROW_MARK_PALETTE, useSetRowMark, useClearRowMark, type RowMarkColour } from '../../vendor/scm/lib/delivery-row-mark';

export function RowColorModal({ rowKey, title, currentColour, onClose }: {
  rowKey: string;
  title: string;
  currentColour: RowMarkColour | null;
  onClose: () => void;
}) {
  const setMark = useSetRowMark();
  const clearMark = useClearRowMark();
  const busy = setMark.isPending || clearMark.isPending;

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: 'var(--c-paper, #fff)', borderRadius: 10, padding: 18, minWidth: 264, boxShadow: '0 12px 40px rgba(0,0,0,0.2)' }}
      >
        <div style={{ fontWeight: 700 }}>Mark colour</div>
        <div style={{ fontSize: 12, color: 'var(--fg-muted, #777)', margin: '2px 0 14px' }}>{title}</div>
        <div style={{ display: 'flex', gap: 12 }}>
          {ROW_MARK_PALETTE.map((p) => (
            <button
              key={p.token}
              type="button"
              disabled={busy}
              aria-label={p.label}
              title={p.label}
              onClick={() => setMark.mutate({ rowKey, colour: p.token }, { onSuccess: onClose })}
              style={{
                width: 34, height: 34, borderRadius: '50%', background: p.swatch, cursor: 'pointer',
                border: currentColour === p.token ? '3px solid var(--c-ink, #242a1c)' : '2px solid rgba(0,0,0,0.12)',
              }}
            />
          ))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 18 }}>
          <button
            type="button"
            disabled={busy || !currentColour}
            onClick={() => clearMark.mutate(rowKey, { onSuccess: onClose })}
            style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid var(--line, #ddd)', background: 'transparent', cursor: currentColour ? 'pointer' : 'default', color: 'var(--c-ink, #242a1c)', opacity: currentColour ? 1 : 0.4 }}
          >
            Clear
          </button>
          <button
            type="button"
            onClick={onClose}
            style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid var(--line, #ddd)', background: 'transparent', cursor: 'pointer', color: 'var(--c-ink, #242a1c)' }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
