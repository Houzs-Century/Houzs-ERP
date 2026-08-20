// PcVariantEditor — the single, shared line-item variant editor for the whole
// Purchase Consignment family (Order / Receive / Return). Built to match the
// Purchase Order editor exactly: Fabrics + Gaps/Divan/Leg dropdowns for
// bedframes, Fabrics + Seat Size/Leg for sofas, plus the Special Orders block.
// Keeping all three forms on this one component is the whole point — they must
// never drift apart again.
//
// Owner 2026-07-20 unification: the Special Orders block is now the ONE shared
// SpecialOrders editor (checkbox add-ons + per-option choices + Custom / other
// free text), the SAME component the SO / PO / DO / GRN adopted in #896. It
// reads + writes the canonical variants.specials ARRAY (+ specialChoices /
// specialLabels / extraAddonNote), shows the human LABEL (not the raw code),
// and — on a doc that inherits from a parent — renders read-only with an
// explicit Override. This replaced the old checkbox-only `SpecialsCheckboxes`
// that wrote the same array but showed codes and had no choices / custom text.
//
// HOUZS VENDOR: only the SalesOrderDetail.module.css import path changed (the
// CSS is colocated in pages/scm/); the lib + @2990s/shared imports are
// verbatim (those modules are vendored under vendor/scm/lib + vendor/shared).
import { useMemo } from 'react';
import { activeOptions, maintPickerValues, restrictPricedToPool, restrictStringsToPool } from '@2990s/shared';
import { useSpecialAddons, useModelAllowedOptionsByCode, type MaintenanceConfig, type SpecialAddonRow } from '../lib/mfg-products-queries';
import { fabricOptionLabel, type FabricLite } from '../lib/fabric-queries';
import { sortByNumeric, byText } from '../lib/sort-options';
import { SpecialOrders } from './SpecialOrders';
import styles from '../../../pages/scm-v2/SalesOrderDetail.module.css';

/* ACTIVE fabrics only (owner spec 2026-06-12, fabric_trackings.is_active) —
 * a line whose saved fabric was later deactivated still shows it. */
const pickableFabrics = (fabrics: FabricLite[], current: string): FabricLite[] =>
  fabrics.filter((f) => f.is_active !== false || f.fabric_code === current);

export const PcVariantEditor = ({
  category, variants, onChange, fabrics, maint, itemCode,
  disabled = false, sourceLinked = false, sourceLabel,
}: {
  category: string;
  variants: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
  fabrics: FabricLite[];
  maint: MaintenanceConfig;
  /* SKU code for this line — resolves the Model's allowed_options so the
     variant dropdowns offer ONLY what the Model permits (owner 2026-07-15,
     parity with SoLineCard). Optional: absent/unknown ⇒ no restriction. */
  itemCode?: string;
  /* Hard lock — the whole document is locked / read-only. Freezes both the
     variant dropdowns and the Special Orders block. */
  disabled?: boolean;
  /* This line inherits from a parent doc (e.g. a receive / return sourced from
     a Purchase Consignment Order). The dropdowns stay frozen and the Special
     Orders block renders read-only with an explicit Override, so the parent's
     special order is carried through, not silently re-entered. A manual line
     passes false and is directly editable. */
  sourceLinked?: boolean;
  /* Parent-doc name for the source-linked banner, e.g. "Purchase Consignment
     Order". */
  sourceLabel?: string;
}) => {
  const allowOpts = useModelAllowedOptionsByCode(itemCode || undefined).data ?? null;

  // Specials pool now comes from special_addons (Backend↔POS parity, Loo
  // 2026-06-08), filtered by this line's category — replacing the legacy
  // maint.specials / maint.sofaSpecials string pools. The FULL rows feed the
  // shared SpecialOrders block (owner 2026-07-20) so the label + per-option
  // choices render; `code` shares the old value namespace so saved picks match.
  const specialAddonsQ = useSpecialAddons();
  const specialsPool = useMemo<SpecialAddonRow[]>(() => {
    const cat = category === 'bedframe' ? 'BEDFRAME' : category === 'sofa' ? 'SOFA' : null;
    if (!cat) return [];
    return (specialAddonsQ.data ?? [])
      .filter((r) => r.active && r.categories.includes(cat))
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder || (a.code ?? '').localeCompare(b.code ?? ''));
  }, [specialAddonsQ.data, category]);

  // SpecialOrders owns the specials / specialChoices / specialLabels / extra*
  // derive logic and emits ONE patch per action; fan it out onto the line's
  // variant bag through the existing per-key setter (each parent's setVariant is
  // a functional setState updater, so sequential writes accumulate safely).
  const applySpecialsPatch = (patch: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(patch)) onChange(k, v);
  };

  // Sourced/locked lines freeze the variant dropdowns (the Special Orders block
  // manages its own read-only + Override below).
  const locked = disabled || sourceLinked;

  const specialsBlock = (
    <SpecialOrders
      options={specialsPool}
      variants={variants}
      onPatch={applySpecialsPatch}
      /* Consignment is a procurement / cost document (like PO / GRN) — the
         selling surcharge is not shown or set here. */
      showPrices={false}
      disabled={disabled}
      sourceLinked={sourceLinked}
      sourceLabel={sourceLabel}
    />
  );

  if (category === 'bedframe') {
    return (
      <>
        <div className={styles.formGrid4}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Fabrics</span>
            <select
              className={styles.fieldSelect}
              value={String(variants.fabricCode ?? '')}
              disabled={locked}
              onChange={(e) => onChange('fabricCode', e.target.value)}
            >
              <option value="" disabled>Select…</option>
              {[...pickableFabrics(fabrics, String(variants.fabricCode ?? ''))].sort((a, b) => byText(fabricOptionLabel(a), fabricOptionLabel(b))).map((f) => (
                <option key={f.id} value={f.fabric_code}>
                  {fabricOptionLabel(f)}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Gaps</span>
            <select
              className={styles.fieldSelect}
              value={String(variants.gap ?? '')}
              disabled={locked}
              onChange={(e) => onChange('gap', e.target.value)}
            >
              <option value="" disabled>Select…</option>
              {sortByNumeric(restrictStringsToPool(maintPickerValues(maint.gaps, String(variants.gap ?? '')), allowOpts?.gaps, String(variants.gap ?? ''))).map((g) => (<option key={g} value={g}>{g}</option>))}
            </select>
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Divan Heights</span>
            <select
              className={styles.fieldSelect}
              value={String(variants.divanHeight ?? '')}
              disabled={locked}
              onChange={(e) => onChange('divanHeight', e.target.value)}
            >
              <option value="" disabled>Select…</option>
              {sortByNumeric(restrictPricedToPool(activeOptions(maint.divanHeights, String(variants.divanHeight ?? '')), allowOpts?.divan_heights, String(variants.divanHeight ?? ''))).map((o) => (<option key={o.value} value={o.value}>{o.value}</option>))}
            </select>
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Leg Heights</span>
            <select
              className={styles.fieldSelect}
              value={String(variants.legHeight ?? '')}
              disabled={locked}
              onChange={(e) => onChange('legHeight', e.target.value)}
            >
              <option value="" disabled>Select…</option>
              {sortByNumeric(restrictPricedToPool(activeOptions(maint.legHeights, String(variants.legHeight ?? '')), allowOpts?.leg_heights, String(variants.legHeight ?? ''))).map((o) => (<option key={o.value} value={o.value}>{o.value}</option>))}
            </select>
          </label>
        </div>
        {specialsBlock}
      </>
    );
  }

  if (category === 'sofa') {
    return (
      <>
        <div className={styles.formGrid4}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Fabrics</span>
            <select
              className={styles.fieldSelect}
              value={String(variants.fabricCode ?? '')}
              disabled={locked}
              onChange={(e) => onChange('fabricCode', e.target.value)}
            >
              <option value="" disabled>Select…</option>
              {[...pickableFabrics(fabrics, String(variants.fabricCode ?? ''))].sort((a, b) => byText(fabricOptionLabel(a), fabricOptionLabel(b))).map((f) => (
                <option key={f.id} value={f.fabric_code}>
                  {fabricOptionLabel(f)}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Seat Size</span>
            <select
              className={styles.fieldSelect}
              value={String(variants.seatHeight ?? '')}
              disabled={locked}
              onChange={(e) => onChange('seatHeight', e.target.value)}
            >
              <option value="" disabled>Select…</option>
              {sortByNumeric(restrictStringsToPool(maintPickerValues(maint.sofaSizes, String(variants.seatHeight ?? '')), allowOpts?.sizes, String(variants.seatHeight ?? ''))).map((s) => (<option key={s} value={s}>{s}</option>))}
            </select>
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Leg Heights</span>
            <select
              className={styles.fieldSelect}
              value={String(variants.legHeight ?? '')}
              disabled={locked}
              onChange={(e) => onChange('legHeight', e.target.value)}
            >
              <option value="" disabled>Select…</option>
              {sortByNumeric(restrictPricedToPool(activeOptions(maint.sofaLegHeights, String(variants.legHeight ?? '')), allowOpts?.leg_heights, String(variants.legHeight ?? ''))).map((o) => (<option key={o.value} value={o.value}>{o.value}</option>))}
            </select>
          </label>
          <span />
        </div>
        {specialsBlock}
      </>
    );
  }

  return null;
};
