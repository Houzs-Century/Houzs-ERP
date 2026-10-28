// Vendored EXTRACT of the SkuPreviewStrip export from
// apps/backend/src/pages/SupplierDetail.tsx (the bulk-map preview chip-row the
// ProductModels modular-assign dialog renders). It is a pure presentational
// component — inline styles + brand CSS vars only, zero I/O — so it is lifted
// here verbatim rather than dragging in the 3900-line SupplierDetail page.

export function SkuPreviewStrip({
  toMap, alreadyBound, previewMap,
}: {
  toMap:         string[];
  alreadyBound:  string[];
  previewMap?:   Record<string, string>;
}) {
  return (
    <div style={{
      display: 'flex',
      flexWrap: 'wrap',
      gap: 6,
      alignItems: 'center',
    }}>
      <span style={{
        fontSize: 'var(--fs-11)',
        color: 'var(--fg-muted)',
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        marginRight: 8,
      }}>
        Will bulk-map →
      </span>
      {toMap.length === 0 ? (
        <span style={{ color: 'var(--fg-muted)', fontSize: 'var(--fs-12)' }}>
          All SKUs already mapped.
        </span>
      ) : toMap.map((c) => {
        const resolved = previewMap?.[c];
        return (
          <code
            key={c}
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--fs-12)',
              background: 'var(--c-paper)',
              border: '1px solid var(--line)',
              borderRadius: 'var(--radius-sm)',
              padding: '2px 8px',
            }}
          >
            {c}
            {resolved && (
              <span style={{ color: 'var(--fg-muted)' }}>
                {' → '}
                <span style={{ color: 'var(--c-burnt)', fontWeight: 600 }}>{resolved}</span>
              </span>
            )}
          </code>
        );
      })}
      {alreadyBound.length > 0 && (
        <>
          <span style={{
            fontSize: 'var(--fs-11)',
            color: 'var(--fg-muted)',
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            margin: '0 8px',
          }}>
            · skip (already bound):
          </span>
          {alreadyBound.map((c) => (
            <code
              key={c}
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--fs-12)',
                background: 'var(--c-cream)',
                border: '1px dashed var(--line)',
                borderRadius: 'var(--radius-sm)',
                padding: '2px 8px',
                color: 'var(--fg-muted)',
                textDecoration: 'line-through',
              }}
            >
              {c}
            </code>
          ))}
        </>
      )}
    </div>
  );
}
