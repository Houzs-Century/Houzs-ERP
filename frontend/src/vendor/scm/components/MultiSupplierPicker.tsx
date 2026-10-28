// ----------------------------------------------------------------------------
// MultiSupplierPicker — chip-row + checkbox dropdown for selecting MULTIPLE
// suppliers in the Modular Assign-to-Supplier dialog (ProductModels.tsx).
//
// Commander 2026-05-27:
//   > supplier 为什么不可以 multiselect 然后让我填写他们分别的 code
//
// Picked suppliers render inline as removable chips; a [+ Add supplier]
// button reveals a dropdown of remaining ACTIVE suppliers with checkboxes.
// Pure presentational — caller owns the selected-ids state, the supplier
// list, and the loading flag. No I/O.
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus, X } from 'lucide-react';
import type { SupplierRow } from '../lib/suppliers-queries';
import { useAnchoredPanel, anchoredPanelStyle } from '../../../lib/anchoredPanel';

/* How tall this checkbox list wants to be when there is room for it. Shorter
   whenever there is not — lib/anchoredPanel clamps it to the space on
   whichever side of the trigger has more, and flips it above the chip row
   rather than letting the last suppliers fall off the bottom of the window. */
const SUPPLIER_MENU_MAX_H = 280;

/* Perf cap — bound the rendered checkbox rows so a large ACTIVE-supplier list
   can't freeze the dropdown open. A search input above the list keeps every
   supplier reachable within the cap. Render-only; no selection/data change. */
const SUPPLIER_RENDER_CAP = 60;

export function MultiSupplierPicker({
  suppliers,
  selectedIds,
  onChange,
  loading,
  disabled,
}: {
  suppliers:   SupplierRow[];
  selectedIds: string[];
  onChange:    (next: string[]) => void;
  loading?:    boolean;
  disabled?:   boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const wrapRef = useRef<HTMLDivElement | null>(null);
  // The dropdown is portaled to body (so an overflow:hidden ancestor can't clip
  // it); menuRef tracks the portaled node so click-outside doesn't close on an
  // in-dropdown click, and menuPos pins it under the trigger.
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuPos = useAnchoredPanel(wrapRef, open, SUPPLIER_MENU_MAX_H);

  // Click-outside closes the dropdown — must treat BOTH the wrapper and the
  // portaled menu as "inside".
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (wrapRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const selectedSet = new Set(selectedIds);
  const selected    = suppliers.filter((s) => selectedSet.has(s.id));
  const remaining   = suppliers.filter((s) => !selectedSet.has(s.id));

  // Client-side narrow so the render cap can never hide a supplier the operator
  // is looking for — typing surfaces any match within SUPPLIER_RENDER_CAP.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return suppliers;
    return suppliers.filter(
      (s) => (s.code ?? '').toLowerCase().includes(q) || (s.name ?? '').toLowerCase().includes(q),
    );
  }, [suppliers, query]);

  const toggle = (id: string) => {
    if (selectedSet.has(id)) onChange(selectedIds.filter((x) => x !== id));
    else onChange([...selectedIds, id]);
  };

  const removeOne = (id: string) =>
    onChange(selectedIds.filter((x) => x !== id));

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{
        fontFamily: 'var(--font-sans)',
        fontSize: 'var(--fs-12)',
        color: 'var(--fg-muted)',
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
      }}>
        Suppliers *
      </span>
      <div style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 6,
        alignItems: 'center',
        padding: '6px 8px',
        background: 'var(--c-cream)',
        border: '1px solid var(--line)',
        borderRadius: 'var(--radius-sm)',
        minHeight: 36,
      }}>
        {selected.length === 0 && (
          <span style={{ color: 'var(--fg-muted)', fontSize: 'var(--fs-13)' }}>
            {loading ? 'Loading suppliers…' : 'No suppliers selected yet.'}
          </span>
        )}
        {selected.map((s) => (
          <span
            key={s.id}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '3px 6px 3px 8px',
              background: 'var(--c-paper)',
              border: '1px solid var(--line)',
              borderRadius: 999,
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--fs-12)',
            }}
          >
            <strong style={{ fontWeight: 600 }}>{s.code}</strong>
            <span style={{ color: 'var(--fg-muted)' }}>·</span>
            <span>{s.name}</span>
            <button
              type="button"
              onClick={() => removeOne(s.id)}
              disabled={disabled}
              aria-label={`Remove ${s.name}`}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--fg-muted)',
                cursor: disabled ? 'default' : 'pointer',
                padding: 0,
                marginLeft: 2,
                lineHeight: 0,
              }}
            >
              <X size={12} strokeWidth={1.75} />
            </button>
          </span>
        ))}
        <button
          type="button"
          onClick={() => setOpen((v) => { const next = !v; if (!next) setQuery(''); return next; })}
          disabled={disabled || loading || remaining.length === 0}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: '3px 8px',
            background: 'transparent',
            border: '1px dashed var(--line)',
            borderRadius: 999,
            cursor: (disabled || loading || remaining.length === 0) ? 'default' : 'pointer',
            color: 'var(--fg-muted)',
            fontFamily: 'var(--font-sans)',
            fontSize: 'var(--fs-12)',
          }}
          title={remaining.length === 0 ? 'All ACTIVE suppliers selected' : 'Add supplier'}
        >
          <Plus size={12} strokeWidth={1.75} />
          {selected.length === 0 ? 'Pick supplier' : 'Add supplier'}
        </button>
      </div>

      {menuPos && createPortal(
        <div ref={menuRef} style={{
          ...anchoredPanelStyle(menuPos),
          overflowY: 'auto',
          background: 'var(--c-paper)',
          border: '1px solid var(--line)',
          borderRadius: 'var(--radius-sm)',
          boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
          display: 'flex',
          flexDirection: 'column',
        }}>
          {suppliers.length > SUPPLIER_RENDER_CAP && (
            <input
              type="search"
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search suppliers…"
              style={{
                margin: 8,
                padding: '6px 8px',
                fontSize: 'var(--fs-13)',
                background: 'var(--c-cream)',
                border: '1px solid var(--line)',
                borderRadius: 'var(--radius-sm)',
                outline: 'none',
              }}
            />
          )}
          {/* minHeight 0 so this list gives way when the shared positioner
              shortens the whole panel — otherwise a cramped window pushes the
              search box off the top instead of scrolling the rows. */}
          <div style={{ overflowY: 'auto', minHeight: 0 }}>
          {suppliers.length === 0 ? (
            <div style={{ padding: '12px', color: 'var(--fg-muted)', fontSize: 'var(--fs-13)' }}>
              No ACTIVE suppliers.
            </div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: '12px', color: 'var(--fg-muted)', fontSize: 'var(--fs-13)' }}>
              No suppliers match “{query}”.
            </div>
          ) : filtered.slice(0, SUPPLIER_RENDER_CAP).map((s) => {
            const checked = selectedSet.has(s.id);
            return (
              <label
                key={s.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 12px',
                  cursor: 'pointer',
                  fontSize: 'var(--fs-13)',
                  borderBottom: '1px solid var(--line)',
                }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(s.id)}
                />
                <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{s.code}</span>
                <span style={{ color: 'var(--fg-muted)' }}>·</span>
                <span>{s.name}</span>
              </label>
            );
          })}
          {filtered.length > SUPPLIER_RENDER_CAP && (
            <div style={{ padding: '8px 12px', color: 'var(--fg-muted)', fontSize: 'var(--fs-12)' }}>
              Showing first {SUPPLIER_RENDER_CAP} of {filtered.length} — search to narrow.
            </div>
          )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
