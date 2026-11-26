import { memo, useMemo, useState } from 'react';
import { Truck } from 'lucide-react';
import { fmtSen } from '@2990s/shared';
import { mfgCategoryLabel, type MfgProductRow, type SeatHeightPrice, type SofaPriceTier } from '../../../vendor/scm/lib/mfg-products-queries';
import styles from '../Products.module.css';
import { modelLabelOf } from './modelLabel';

type Tier = SofaPriceTier;

export const fmtRm = (sen: number | null): string => fmtSen(sen);

export const fmtUnit = (milli: number): string =>
  (milli / 1000).toFixed(3);

export const priceForHeightTier = (
  arr: SeatHeightPrice[] | null | undefined,
  height: string,
  tier: Tier,
): number | null => {
  if (!Array.isArray(arr)) return null;
  const hit = arr.find((p) => p.height === height && (p.tier ?? 'PRICE_2') === tier);
  return hit ? hit.priceSen : null;
};

export const upsertHeightTier = (
  arr: SeatHeightPrice[] | null | undefined,
  height: string,
  tier: Tier,
  priceSen: number | null,
): SeatHeightPrice[] => {
  const next = Array.isArray(arr) ? [...arr] : [];
  const idx = next.findIndex(
    (p) => p.height === height && (p.tier ?? 'PRICE_2') === tier,
  );
  if (priceSen == null || priceSen === 0) {
    if (idx >= 0) next.splice(idx, 1);
    return next;
  }
  const entry: SeatHeightPrice = { height, priceSen, tier };
  if (idx >= 0) next[idx] = entry;
  else next.push(entry);
  return next;
};

/* Staged inline-edit patch for one SKU row (Edit Prices mode). Mirrors the
   fields useUpdateMfgProductPrices accepts (minus id). Nothing is sent to the
   server until Save (Commander 2026-06-15 — no 裸奔). */
export type ProductEditPatch = {
  code?: string;
  name?: string;
  branding?: string | null;
  seatHeightPrices?: SeatHeightPrice[];
  basePriceSen?: number | null;
  price1Sen?: number | null;
};

const seatKey = (arr: SeatHeightPrice[] | null | undefined): string =>
  JSON.stringify((arr ?? [])
    .map((p) => [String(p.height), p.tier ?? 'PRICE_2', p.priceSen] as const)
    .sort((a, b) => `${a[0]}|${a[1]}`.localeCompare(`${b[0]}|${b[1]}`)));

export function stageRowEdit(
  prev: Record<string, ProductEditPatch>,
  row: MfgProductRow | null,
  id: string,
  change: ProductEditPatch,
): Record<string, ProductEditPatch> {
  const next: ProductEditPatch = { ...prev[id], ...change };
  if (row) {
    if (next.code !== undefined && next.code === row.code) delete next.code;
    if (next.name !== undefined && next.name === row.name) delete next.name;
    if ('branding' in next && (next.branding ?? null) === (row.branding ?? null)) delete next.branding;
    if ('basePriceSen' in next && (next.basePriceSen ?? null) === row.base_price_sen) delete next.basePriceSen;
    if ('price1Sen' in next && (next.price1Sen ?? null) === row.price1_sen) delete next.price1Sen;
    if (next.seatHeightPrices && seatKey(next.seatHeightPrices) === seatKey(row.seat_height_prices)) delete next.seatHeightPrices;
  }
  const out = { ...prev };
  if (Object.keys(next).length === 0) delete out[id];
  else out[id] = next;
  return out;
}

export async function saveStagedEdits(
  pending: Record<string, ProductEditPatch>,
  save: (id: string, patch: ProductEditPatch) => Promise<unknown>,
): Promise<{ savedIds: string[]; failures: Array<{ id: string; message: string }> }> {
  const savedIds: string[] = [];
  const failures: Array<{ id: string; message: string }> = [];
  for (const [id, patch] of Object.entries(pending)) {
    try {
      await save(id, patch);
      savedIds.push(id);
    } catch (e) {
      failures.push({ id, message: e instanceof Error ? e.message : 'Something went wrong.' });
    }
  }
  return { savedIds, failures };
}

/* The rows the grid is SHOWING — its funnels and sort applied — as the latest
   copies from `rows`. The edit table renders these, so pressing Edit Prices
   never moves or drops a row the operator was looking at (owner 2026-09-15).
   `null` = the grid has not reported yet: fall back to the loaded order. */
export function rowsInGridOrder<R extends { id: string }>(rows: R[], gridRows: R[] | null): R[] {
  if (!gridRows) return rows;
  const byId = new Map(rows.map((r) => [r.id, r]));
  return gridRows.flatMap((g) => byId.get(g.id) ?? []);
}

export function useSkuGridOrder(rows: MfgProductRow[]) {
  const [gridRows, setGridRows] = useState<MfgProductRow[] | null>(null);
  const [gridEpoch, setGridEpoch] = useState(0);
  const shownRows = useMemo(() => rowsInGridOrder(rows, gridRows), [rows, gridRows]);
  return { setGridRows, gridEpoch, bumpGridEpoch: () => setGridEpoch((n) => n + 1), shownRows };
}

export const ProductRow = memo(({
  row, editMode, isSofaView, isMattressView, sofaSizes, tier, onOpenSuppliers,
  selected, onToggleSelected, patch, onStage, brandingPool,
}: {
  row: MfgProductRow;
  editMode: boolean;
  isSofaView: boolean;
  isMattressView: boolean;
  sofaSizes: string[];
  tier: Tier;
  onOpenSuppliers?: (row: MfgProductRow) => void;
  /** Canonical branding pool (Project Maintenance -> Brands). Drives the
      Mattress-row Branding <select>. Owner 2026-07-23 rule: no free-text. */
  brandingPool: string[];
  selected:         boolean;
  onToggleSelected: (id: string) => void;
  patch?: ProductEditPatch;
  onStage: (id: string, patch: ProductEditPatch) => void;
}) => {
  const seatArr = patch?.seatHeightPrices ?? row.seat_height_prices ?? [];
  const baseSen = patch && 'basePriceSen' in patch ? patch.basePriceSen ?? null : row.base_price_sen;
  const p1Sen = patch && 'price1Sen' in patch ? patch.price1Sen ?? null : row.price1_sen;
  const brandingVal = patch && 'branding' in patch ? patch.branding ?? '' : row.branding ?? '';
  /* The code and description cells show the STAGED text once a change is
     staged. They showed the stored text, so a typed description snapped back to
     the old one the moment the cell was left, while Save still sent the new one
     (owner 2026-09-15, 810 BOLSTER). */
  const codeVal = patch?.code ?? row.code;
  const nameVal = patch?.name ?? row.name;

  const updateSofaCell = (size: string, newPriceSen: number | null) => {
    onStage(row.id, { seatHeightPrices: upsertHeightTier(seatArr, size, tier, newPriceSen) });
  };

  return (
    <tr
      data-vrow=""
      className={styles.rowCompact}
      onDoubleClick={() => !editMode && onOpenSuppliers?.(row)}
      title={editMode
        ? 'Click the truck icon to see suppliers (double-click is disabled in Edit Prices mode)'
        : 'Double-click row — or click the truck icon — to see suppliers for this product'}
      style={{ cursor: editMode ? 'default' : 'pointer' }}
    >
      <td style={{ width: 32 }} onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          aria-label={`Select ${row.code}`}
          checked={selected}
          onChange={() => onToggleSelected(row.id)}
          style={{ cursor: 'pointer' }}
        />
      </td>
      {/* PR #89 — click code chip to edit.
          PR #95 — Commander 2026-05-26: "容易不小心点到 Edit，你应该点 Edit
          Price 那边就可以进来修改了". Gate click-to-edit behind editMode so
          the chip is read-only until commander explicitly hits "Edit Prices".
          When editMode is off the cell stops bubble propagation but stays
          a plain text/chip, so accidental clicks during row drilldown can't
          drop into the input.
          PR — Commander 2026-05-28 ("双击点不进去，看得到里面的 supplier
          是谁"): add an explicit Truck icon next to the code chip that ALWAYS
          opens the Suppliers drawer (including during edit-mode where the
          row-level double-click is intentionally disabled). */}
      <td onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <button
            type="button"
            aria-label={`View suppliers for ${row.code}`}
            title="View suppliers carrying this SKU"
            onClick={() => onOpenSuppliers?.(row)}
            style={{
              background: 'transparent',
              border: 'none',
              padding: 0,
              margin: 0,
              cursor: 'pointer',
              color: 'var(--hz-c-ink-muted)',
              display: 'inline-flex',
              alignItems: 'center',
            }}
          >
            <Truck size={13} strokeWidth={1.75} />
          </button>
          <EditableTextCell
            value={codeVal}
            chipClassName={styles.codeChip}
            ariaLabel="Edit product code"
            editable={editMode}
            onSave={(val) => onStage(row.id, { code: val })}
          />
        </span>
      </td>
      <td onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
          <EditableTextCell
            value={nameVal}
            chipClassName={styles.nameCompact}
            inline
            ariaLabel="Edit description"
            editable={editMode}
            onSave={(val) => onStage(row.id, { name: val })}
          />
          {row.one_shot && (
            <span
              className={styles.catPill}
              title={row.source_doc_no ? `One-shot from ${row.source_doc_no}` : 'One-shot SKU'}
              style={{ fontSize: 'var(--fs-11)' }}
            >
              one-shot
            </span>
          )}
        </span>
        {row.description && <div className={styles.nameSubCompact}>{row.description}</div>}
      </td>
      {isSofaView ? (
        <>
          <td className={styles.numCellMuted} style={{ textAlign: 'left' }}>
            {modelLabelOf(row) || '—'}
          </td>
          {sofaSizes.map((s) => {
            const sen = priceForHeightTier(seatArr, s, tier);
            const baselineSen = tier !== 'PRICE_2'
              ? priceForHeightTier(seatArr, s, 'PRICE_2')
              : null;
            return (
              <td key={s} className={sen ? styles.price : styles.priceEmpty}>
                {editMode ? (
                  <PriceInput
                    key={tier}
                    valueSen={sen}
                    baselineSen={baselineSen}
                    onCommit={(v) => updateSofaCell(s, v)}
                  />
                ) : (
                  fmtRm(sen)
                )}
              </td>
            );
          })}
        </>
      ) : isMattressView ? (
        <>
          <td>
            {editMode ? (
              <BrandingInput
                value={brandingVal}
                pool={brandingPool}
                onCommit={(v) => onStage(row.id, { branding: v })}
              />
            ) : (
              row.branding
                ? <span className={styles.catPill}>{row.branding}</span>
                : <span className={styles.priceEmpty}>—</span>
            )}
          </td>
          <td>{row.size_label ?? '—'}</td>
          <td className={baseSen ? styles.price : styles.priceEmpty}>
            {editMode ? (
              <PriceInput
                valueSen={baseSen}
                onCommit={(v) => onStage(row.id, { basePriceSen: v })}
              />
            ) : (
              fmtRm(row.base_price_sen)
            )}
          </td>
        </>
      ) : (
        <>
          <td><span className={styles.catPill}>{mfgCategoryLabel(row.category)}</span></td>
          <td>{row.size_label ?? '—'}</td>
          <td className={baseSen ? styles.price : styles.priceEmpty}>
            {editMode ? (
              <PriceInput
                valueSen={baseSen}
                onCommit={(v) => onStage(row.id, { basePriceSen: v })}
              />
            ) : (
              fmtRm(row.base_price_sen)
            )}
          </td>
          <td className={p1Sen ? styles.price : styles.priceEmpty}>
            {editMode ? (
              <PriceInput
                valueSen={p1Sen}
                onCommit={(v) => onStage(row.id, { price1Sen: v })}
              />
            ) : (
              fmtRm(row.price1_sen)
            )}
          </td>
        </>
      )}
      <td className={styles.numCell}>{fmtUnit(row.unit_m3_milli)}</td>
    </tr>
  );
});
ProductRow.displayName = 'ProductRow';

/* Dropdown-only branding picker for Mattress rows. Commits on change.
   Owner 2026-07-23: "根据我们维护那边 dropdown 去做选择的那一个" — no more
   free-text entry. New brand names have to be added centrally in Project
   Maintenance -> Brands (which then flows into `useBrandingPool()` and
   surfaces here on the next fetch). A stored value that isn't in the current
   pool (legacy) still renders as a selectable option so the row remains
   editable while the operator picks a proper canonical brand. */
const BrandingInput = ({
  value,
  pool,
  onCommit,
}: {
  value: string;
  pool: string[];
  onCommit: (v: string | null) => void;
}) => {
  const current = value.trim();
  const inPool = current && pool.some((b) => b.toUpperCase() === current.toUpperCase());
  const options = useMemo(() => {
    const sorted = [...pool].sort((a, b) => a.localeCompare(b));
    return current && !inPool ? [current, ...sorted] : sorted;
  }, [pool, current, inPool]);
  return (
    <select
      value={current}
      onChange={(e) => {
        const v = e.target.value.trim();
        if (v === current) return;
        onCommit(v.length ? v : null);
      }}
      title={inPool || !current
        ? undefined
        : `"${current}" is not in the current branding pool. Add it in Project Maintenance -> Brands.`}
      style={{
        width: 160,
        fontFamily: 'var(--font-sans)',
        fontSize: 'var(--fs-13)',
        background: inPool || !current ? 'var(--hz-c-surface-2)' : '#fef3c7',
        border: `1px solid ${inPool || !current ? '#16695f' : '#b45309'}`,
        borderRadius: 'var(--radius-sm)',
        padding: '3px 8px',
        outline: 'none',
      }}
    >
      <option value="">—</option>
      {options.map((b) => (
        <option key={b} value={b}>
          {b}{current && !inPool && b === current ? ' (legacy)' : ''}
        </option>
      ))}
    </select>
  );
};

const PriceInput = ({
  valueSen,
  onCommit,
  baselineSen,
}: {
  valueSen: number | null;
  onCommit: (v: number | null) => void;
  baselineSen?: number | null;
}) => {
  const [local, setLocal] = useState<string>(
    valueSen == null ? '' : (valueSen / 100).toFixed(2),
  );

  const commit = () => {
    const trimmed = local.trim();
    if (trimmed === '') {
      onCommit(null);
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return;
    onCommit(Math.round(parsed * 100));
  };

  const placeholder = baselineSen && baselineSen > 0
    ? `P2: ${(baselineSen / 100).toFixed(2)}`
    : undefined;

  return (
    <input
      type="number"
      step="0.01"
      value={local}
      placeholder={placeholder}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      style={{
        width: 84,
        textAlign: 'right',
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--fs-13)',
        background: 'var(--hz-c-surface-2)',
        border: '1px solid var(--hz-c-primary)',
        borderRadius: 'var(--radius-sm)',
        padding: '3px 6px',
        outline: 'none',
      }}
    />
  );
};

const EditableTextCell = ({
  value, chipClassName, ariaLabel, onSave, inline = false, editable = true,
}: {
  value:          string;
  chipClassName:  string | undefined;
  ariaLabel:      string;
  onSave:         (val: string) => void;
  inline?:        boolean;
  editable?:      boolean;
}) => {
  const [editing, setEditing] = useState(false);
  const [draft,   setDraft]   = useState(value);

  const commit = () => {
    const trimmed = draft.trim();
    if (!trimmed || trimmed === value.trim()) {
      setEditing(false);
      setDraft(value);
      return;
    }
    onSave(trimmed);
    setEditing(false);
  };
  const cancel = () => { setDraft(value); setEditing(false); };

  if (!editing) {
    if (!editable) {
      return inline ? (
        <span className={chipClassName}>{value}</span>
      ) : (
        <span className={chipClassName}>{value}</span>
      );
    }
    return inline ? (
      <div
        role="button"
        tabIndex={0}
        className={chipClassName}
        title="Click to edit"
        onClick={() => { setDraft(value); setEditing(true); }}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDraft(value); setEditing(true); } }}
        style={{ cursor: 'pointer' }}
      >
        {value}
      </div>
    ) : (
      <button
        type="button"
        className={chipClassName}
        title="Click to edit"
        aria-label={ariaLabel}
        onClick={() => { setDraft(value); setEditing(true); }}
        style={{ cursor: 'pointer' }}
      >
        {value}
      </button>
    );
  }
  return (
    <input
      autoFocus
      type="text"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter')      { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
      }}
      style={{
        fontFamily: inline ? 'var(--font-sans)' : 'var(--font-mono)',
        fontSize:   'var(--fs-13)',
        fontWeight: 600,
        padding:    '4px 8px',
        border:     '1px solid var(--hz-c-primary)',
        borderRadius: 'var(--radius-sm)',
        background: 'var(--hz-c-surface-2)',
        outline:    'none',
        width:      '100%',
        maxWidth:   320,
      }}
    />
  );
};
