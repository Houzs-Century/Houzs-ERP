// ----------------------------------------------------------------------------
// SpecialOrders — ONE shared special-order editor for every document.
//
// Owner 2026-07-20: the special order (fixed checkbox add-ons + per-option
// choices + a free-text "Custom / other") must look + behave IDENTICALLY, and
// carry through, across Sales Order, Delivery Order, Purchase Order, Goods
// Received, Purchase Invoice, Purchase Return and Stock Adjustment. Before this
// there were THREE divergent implementations (SoLineCard's rich accordion, the
// PO's checkbox-only `SpecialsCheckboxes`, and the receiving family's single-
// select `special`), so a custom/other note captured on the SO was invisible on
// the PO and had to be typed again — the "entered twice" the owner reported.
//
// This component is the single source of that UI. It reads + writes the
// UNCHANGED variant keys (no schema change):
//   - variants.specials        string[]  (add-on CODES; the array is canonical)
//   - variants.specialChoices  { code: [chosen option-group labels] }
//   - variants.specialLabels   string[]  (display snapshot of the picked labels)
//   - variants.extraAddonNote  string    (Custom / other free text)
//   - variants.extraAddonAmountRM number (Custom / other selling surcharge, RM)
// Legacy singular `variants.special` is READ as a fallback so pre-existing
// receiving-family lines still display; the FIRST edit normalises it to the
// `specials` array (a one-shot backfill migrates the rest at rest).
//
// Write model: the component owns all the derive/patch logic and emits ONE
// `onPatch(patch)` per action. The caller merges the patch into its line's
// variant bag — so every document produces a byte-identical payload shape and
// the API carries it through SO -> PO -> GRN and SO -> DO without loss.
// ----------------------------------------------------------------------------

import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { fmtMoneyCenti } from '@2990s/shared';
import type { SpecialAddonRow } from '../lib/mfg-products-queries';
import styles from './SpecialOrders.module.css';

const SM_ICON = { size: 14, strokeWidth: 1.75 } as const;
const fmtRm = (centi: number, currency = 'MYR'): string => fmtMoneyCenti(centi, currency);

/** variants.specials (string[] | legacy singular string) -> trimmed code list. */
const specialsList = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.map(String).filter(Boolean);
  if (typeof v === 'string' && v) return [v];
  return [];
};

export type SpecialOrdersProps = {
  /** Active special_addons rows for THIS line's category, already intersected
   *  with the Model's allowed_options.specials pool by the caller (SO restricts;
   *  the cost docs pass the plain category list). */
  options: SpecialAddonRow[];
  /** The line's variant bag — reads specials / specialChoices / extraAddonNote /
   *  extraAddonAmountRM (+ legacy singular `special`). */
  variants: Record<string, unknown>;
  /** Merge a patch into the line's variants. The component owns the
   *  specials / specialChoices / specialLabels / extra* shapes; the caller only
   *  splices `{ ...line.variants, ...patch }` back onto its draft. */
  onPatch: (patch: Record<string, unknown>) => void;
  /** Show the SELLING surcharge on each add-on + the Custom / other extra-charge
   *  field. The SO passes isAdminLevel (a non-admin only DESCRIBES); the cost
   *  documents (PO / GRN / PI / PR / adjustment) pass false — the selling
   *  surcharge is not theirs to show or set. */
  showPrices: boolean;
  /** Hard lock — whole document locked, or a read-only View. */
  disabled?: boolean;
  /** Optional external accordion control. SoLineCard shares one open-state
   *  across its bedframe/sofa/mattress panels; other callers omit it and the
   *  block manages its own (defaulting open when the line already carries data
   *  so a carried special order is visible without a click). */
  open?: boolean;
  onToggle?: () => void;
  /** Source-linked documents (PO from SO, GRN from PO, ...). When set, the block
   *  defaults to READ-ONLY carrying the parent's values, with an explicit
   *  Override so the special order is never silently re-entered. A manual line
   *  (no parent) passes false and is immediately editable. */
  sourceLinked?: boolean;
  /** Parent-doc name for the linked banner, e.g. "Sales Order". */
  sourceLabel?: string;
};

export const SpecialOrders = ({
  options,
  variants,
  onPatch,
  showPrices,
  disabled = false,
  open,
  onToggle,
  sourceLinked = false,
  sourceLabel,
}: SpecialOrdersProps) => {
  const picked = specialsList(variants.specials ?? variants.special);
  const choicesMap: Record<string, string[]> =
    variants.specialChoices && typeof variants.specialChoices === 'object'
      ? (variants.specialChoices as Record<string, string[]>)
      : {};
  const extraNote = String(variants.extraAddonNote ?? '');
  const extraAmountRM = Number(variants.extraAddonAmountRM ?? 0);
  const hasCustom = Boolean(extraNote.trim()) || extraAmountRM > 0;

  const [openInternal, setOpenInternal] = useState(picked.length > 0 || hasCustom);
  const isOpen = open ?? openInternal;
  const toggleOpen = onToggle ?? (() => setOpenInternal((o) => !o));

  const [customOpen, setCustomOpen] = useState(hasCustom);

  // Read-mostly override for source-linked docs; a manual line is always live.
  const [overridden, setOverridden] = useState(false);
  const locked = disabled || (sourceLinked && !overridden);

  const labelFor = (code: string) => options.find((o) => o.code === code)?.label ?? code;

  /* Tick/untick writes specials (codes) + specialChoices (required option groups
     default to their first choice, like the POS picker) + specialLabels (display
     snapshot) in one patch — the SAME shape SoLineCard.toggleSpecial produced. */
  const toggleCode = (code: string) => {
    const has = picked.includes(code);
    const nextPicked = has ? picked.filter((c) => c !== code) : [...picked, code];
    const nextChoices: Record<string, string[]> = { ...choicesMap };
    if (has) {
      delete nextChoices[code];
    } else {
      const def = options.find((d) => d.code === code);
      if (def && def.optionGroups.length > 0) {
        nextChoices[code] = def.optionGroups.map((g) => (g.required && g.choices[0] ? g.choices[0].label : ''));
      }
    }
    onPatch({
      specials: nextPicked,
      specialChoices: nextChoices,
      specialLabels: nextPicked.map(labelFor),
    });
  };

  const changeChoice = (code: string, groupIdx: number, label: string) => {
    const def = options.find((d) => d.code === code);
    const entry = [...(choicesMap[code] ?? (def?.optionGroups ?? []).map(() => ''))];
    entry[groupIdx] = label;
    onPatch({ specialChoices: { ...choicesMap, [code]: entry } });
  };

  /* Effective selling surcharge for one add-on = base + Σ chosen extras. */
  const effectiveSen = (o: SpecialAddonRow): number => {
    let sen = o.sellingPriceSen;
    (choicesMap[o.code] ?? []).forEach((label, i) => {
      const hit = label ? o.optionGroups[i]?.choices.find((c) => c.label === label) : undefined;
      if (hit) sen += hit.extraSen;
    });
    return sen;
  };

  /* Codes retired/renamed in Special Add-ons (or pre-takeover legacy strings)
     still show as removable rows — invisible-but-stuck picks were how the old
     editor leaked RM 0 specials onto orders. */
  const retired = picked.filter((c) => !options.some((o) => o.code === c));
  const selectedCount = picked.length + (hasCustom ? 1 : 0);

  return (
    <div className={styles.specials}>
      <div
        className={styles.specialsHead}
        onClick={toggleOpen}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggleOpen(); }}
      >
        {isOpen ? <ChevronDown {...SM_ICON} /> : <ChevronRight {...SM_ICON} />}
        <span>Special Orders</span>
        <span className={styles.specialsCount}>({selectedCount} selected)</span>
      </div>
      {isOpen && (
        <div className={styles.specialsBody}>
          {sourceLinked && (
            <div className={styles.sourceBanner}>
              <span>
                {locked
                  ? `Linked from ${sourceLabel ?? 'source'} — carried through automatically.`
                  : `Overriding ${sourceLabel ?? 'source'} for this document.`}
              </span>
              {!disabled && (
                <button
                  type="button"
                  className={styles.overrideBtn}
                  onClick={() => setOverridden((o) => !o)}
                >
                  {locked ? 'Override' : 'Done'}
                </button>
              )}
            </div>
          )}
          {options.map((o) => {
            const on = picked.includes(o.code);
            const sen = on ? effectiveSen(o) : o.sellingPriceSen;
            return (
              <label key={o.code} className={styles.specialsItem}>
                <input
                  type="checkbox"
                  className={styles.specialsCheckbox}
                  checked={on}
                  disabled={locked}
                  onChange={() => { if (!locked) toggleCode(o.code); }}
                />
                <div>
                  <div className={styles.specialsLabel}>{o.label}</div>
                  {showPrices && (
                    <div className={styles.specialsSurcharge}>
                      {sen > 0 ? `+${fmtRm(sen)}` : sen < 0 ? `−${fmtRm(Math.abs(sen))}` : 'RM 0'}
                    </div>
                  )}
                </div>
              </label>
            );
          })}
          {retired.map((code) => (
            <label key={`retired-${code}`} className={styles.specialsItem}>
              <input
                type="checkbox"
                className={styles.specialsCheckbox}
                checked
                disabled={locked}
                onChange={() => { if (!locked) toggleCode(code); }}
              />
              <div>
                <div className={styles.specialsLabel}>{labelFor(code)}</div>
                <div className={styles.specialsSurcharge} style={{ color: 'var(--c-festive-b, #B8331F)' }}>
                  {showPrices ? 'retired — prices RM 0, untick to remove' : 'retired — untick to remove'}
                </div>
              </div>
            </label>
          ))}
          {/* Follow-up choice pickers for ticked add-ons with option groups. */}
          {options.filter((o) => picked.includes(o.code) && o.optionGroups.length > 0).map((o) =>
            o.optionGroups.map((g, gi) => (
              <label key={`${o.code}-${gi}`} className={styles.variantField} style={{ gridColumn: '1 / -1' }}>
                <span className={styles.variantLabel}>
                  {o.label} · {g.label}{g.required ? ' *' : ''}
                </span>
                <select
                  className={styles.select}
                  value={(choicesMap[o.code] ?? [])[gi] ?? ''}
                  disabled={locked}
                  onChange={(e) => changeChoice(o.code, gi, e.target.value)}
                >
                  {!g.required && <option value="">None</option>}
                  {g.required && <option value="" disabled>Select…</option>}
                  {g.choices.map((c) => (
                    <option key={c.label} value={c.label}>
                      {c.label}{showPrices && c.extraSen !== 0 ? ` (${c.extraSen > 0 ? '+' : '−'}${fmtRm(Math.abs(c.extraSen))})` : ''}
                    </option>
                  ))}
                </select>
              </label>
            )),
          )}

          {/* ── Custom / other (unified free-text special order) ───────────── */}
          <div className={styles.customSpecial}>
            <div
              className={styles.customHead}
              role="button"
              tabIndex={0}
              onClick={() => { if (!locked) setCustomOpen((o) => !o); }}
              onKeyDown={(e) => { if (!locked && (e.key === 'Enter' || e.key === ' ')) setCustomOpen((o) => !o); }}
            >
              {(customOpen || hasCustom) ? <ChevronDown {...SM_ICON} /> : <ChevronRight {...SM_ICON} />}
              <span className={styles.specialsLabel} style={{ fontWeight: 600 }}>Custom / other</span>
              {hasCustom && <span className={styles.specialsCount}>1 added</span>}
            </div>
            {(customOpen || hasCustom) && (
              <div className={styles.customFields}>
                <label className={styles.variantField}>
                  <span className={styles.variantLabel}>Description</span>
                  <input
                    className={styles.select}
                    placeholder="Describe the special order…"
                    value={extraNote}
                    disabled={locked}
                    onChange={(e) => onPatch({ extraAddonNote: e.target.value })}
                  />
                </label>
                {showPrices && (
                  <label className={styles.variantField} style={{ maxWidth: 140 }}>
                    <span className={styles.variantLabel}>Extra charge (RM)</span>
                    <input
                      type="number"
                      min={0}
                      step={1}
                      className={styles.select}
                      style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}
                      placeholder="0"
                      value={extraAmountRM ? String(extraAmountRM) : ''}
                      disabled={locked}
                      onChange={(e) => {
                        const raw = e.target.value;
                        const n = raw === '' ? 0 : Math.max(0, Math.round(Number(raw)) || 0);
                        onPatch({ extraAddonAmountRM: n });
                      }}
                    />
                  </label>
                )}
                {/* Clear hidden from non-admin sales when a price they can't see
                    is set — they must not silently wipe an admin-priced order. */}
                {hasCustom && !locked && (showPrices || extraAmountRM <= 0) && (
                  <button
                    type="button"
                    className={styles.customClear}
                    onClick={() => onPatch({ extraAddonNote: '', extraAddonAmountRM: 0 })}
                  >
                    Clear
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
