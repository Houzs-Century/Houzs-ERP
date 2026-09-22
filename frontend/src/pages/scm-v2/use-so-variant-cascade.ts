// ----------------------------------------------------------------------------
// useSoVariantCascade — the live master-follower variant cascade for the SO
// EDIT view (SalesOrderDetail).
//
// SalesOrderNew and MobileNewSO already run this cascade over their `lines`
// array (owner 2026-08-21 / 2026-09-09 / 2026-09-22 rulings, rule in
// vendor/scm/lib/so-variant-cascade). The EDIT view did not: it seeds every
// line into `editingDrafts` and renders a SoLineCard each, but nothing kept a
// sofa SET's compartment lines in step once the order already existed. So an
// operator who opened an existing modular sofa, set the fabric / seat / leg /
// special on the first compartment and saw the siblings NOT follow was looking
// at the create-only cascade's blind spot.
//
// This hook is that same cascade, driven off editingDrafts + addingDrafts in
// RENDER order (persisted lines in `orderedIds` order, then the staged adds).
// It lives in its own file — not inline in the 4,200-line page — because that
// page is at its size ceiling and because the wiring is worth stating once.
//
// FROZEN lines are never rewritten: a shipped / invoiced compartment's variants
// are locked, so it can be a cascade MASTER (a read-only source) but never a
// follower the cascade overwrites. Mirrors the frozen skip the header
// Delivery-Date cascade already applies.
// ----------------------------------------------------------------------------

import { useCallback, useEffect, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import {
  cascadeMasterVariants,
  CASCADE_CATEGORIES,
  type MasterVariantSnapshot,
} from '../../vendor/scm/lib/so-variant-cascade';
import type { SoLineDraft } from '../../vendor/scm/components/SoLineCard';
import { cascadeStagedDeliveryDate, type StagedAddLine } from './so-add-lines';

export function useSoVariantCascade(args: {
  isEditing: boolean;
  /** Persisted line ids in RENDER order (the `items` array's order). */
  orderedIds: readonly string[];
  editingDrafts: Record<string, SoLineDraft>;
  addingDrafts: StagedAddLine[];
  frozenIds: ReadonlySet<string>;
  setEditingDrafts: Dispatch<SetStateAction<Record<string, SoLineDraft>>>;
  setAddingDrafts: Dispatch<SetStateAction<StagedAddLine[]>>;
}): void {
  const {
    isEditing, orderedIds, editingDrafts, addingDrafts, frozenIds,
    setEditingDrafts, setAddingDrafts,
  } = args;

  // Holds the master variants as of the previous run, so "the master's latest
  // change wins" means something (a key the master JUST moved is forced onto the
  // followers; a key it did not is only used to fill a blank). Reset when the
  // edit session ends so a re-open starts clean.
  const masterSnapshotRef = useRef<MasterVariantSnapshot>({});

  useEffect(() => {
    if (!isEditing) { masterSnapshotRef.current = {}; return; }

    // The cascade sees ONE ordered list: persisted lines first (render order),
    // then the staged adds. The first line of a category is its master.
    const editIds = orderedIds.filter((id) => id in editingDrafts);
    const lines = [
      ...editIds.map((id) => ({
        category: editingDrafts[id]!.itemGroup ?? '',
        variants: (editingDrafts[id]!.variants ?? {}) as Record<string, unknown>,
      })),
      ...addingDrafts.map((row) => ({
        category: row.draft.itemGroup ?? '',
        variants: (row.draft.variants ?? {}) as Record<string, unknown>,
      })),
    ];
    if (lines.length === 0) return;

    const { variants, masters } = cascadeMasterVariants(
      lines, masterSnapshotRef.current, CASCADE_CATEGORIES,
    );
    masterSnapshotRef.current = masters;

    // Write the persisted-line results back, skipping frozen lines (locked) and
    // any line whose variants object is unchanged (=== the input ref).
    setEditingDrafts((prev) => {
      let changed = false;
      const next: Record<string, SoLineDraft> = { ...prev };
      editIds.forEach((id, i) => {
        const v = variants[i]!;
        if (v === lines[i]!.variants || frozenIds.has(id) || !prev[id]) return;
        next[id] = { ...prev[id]!, variants: v };
        changed = true;
      });
      return changed ? next : prev;
    });

    // Then the staged adds (never frozen — they are not yet persisted).
    setAddingDrafts((prev) => {
      let changed = false;
      const next = prev.map((row, j) => {
        const v = variants[editIds.length + j]!;
        if (v === row.draft.variants) return row;
        changed = true;
        return { ...row, draft: { ...row.draft, variants: v } };
      });
      return changed ? next : prev;
    });
    // editingDrafts / addingDrafts identity change is what re-runs this; frozenIds
    // and the setters are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing, orderedIds, editingDrafts, addingDrafts]);
}

/**
 * The live header -> line Delivery Date cascade for the EDIT view. Returns the
 * imperative callback the header's date input calls: it pushes the new header
 * date onto every line draft that has not been manually overridden (persisted
 * AND staged), skipping frozen lines. Behaviour-identical to the inline version
 * it replaced in SalesOrderDetail; co-located here with the variant cascade so
 * the two "live edit-view cascades" live in one place and the page stays under
 * its size ceiling.
 */
export function useSoLineDeliveryDateCascade(
  setEditingDrafts: Dispatch<SetStateAction<Record<string, SoLineDraft>>>,
  setAddingDrafts: Dispatch<SetStateAction<StagedAddLine[]>>,
  frozenIdsRef: MutableRefObject<ReadonlySet<string>>,
): (date: string) => void {
  return useCallback((date: string) => {
    const next = date || null;
    setEditingDrafts((prev) => {
      let changed = false;
      const out: Record<string, SoLineDraft> = {};
      for (const [id, d] of Object.entries(prev)) {
        if (!d.lineDeliveryDateOverridden && d.lineDeliveryDate !== next && !frozenIdsRef.current.has(id)) {
          out[id] = { ...d, lineDeliveryDate: next };
          changed = true;
        } else {
          out[id] = d;
        }
      }
      return changed ? out : prev;
    });
    setAddingDrafts((prev) => cascadeStagedDeliveryDate(prev, next));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
