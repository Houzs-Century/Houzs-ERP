// ----------------------------------------------------------------------------
// Sofa Quick Presets — commander-editable composition shortcuts.
//
// Commander 2026-05-28: "Modular 为什么不是像 Hookka 这样 — 我们可以生产出
// 来 Quick Pick。我觉得它就是 Modular 1、2、3, 而 Quick Pick、Quick Preset
// 就是我们设定给它的那个名字来的." (Translation: a Quick Preset is just a
// name we give to a *combination* of individual sofa compartments. So the
// list of presets should be commander-editable from Maintenance, not
// hardcoded in two separate places.)
//
// Storage shape: lives on MaintenanceConfig.sofaQuickPresets (JSONB blob,
// no schema migration). Readers:
//   · apps/backend/src/components/SofaComboTab.tsx — New Combo dialog's
//     "Quick presets" chip rail (click to pre-fill modules).
//   · apps/backend/src/pages/Products.tsx + apps/pos/src/pages/Products.tsx
//     — Maintenance tab → SOFA section → Quick Presets sub-tab.
//
// Backwards-compat: the 11 default ids (1S, 2S, 3S-L, 3S-R, 2+L-L, 2+L-R,
// 3+L-L, 3+L-R, 2WC, CORNER-L, CORNER-R) match what was hardcoded in
// SofaComboTab.COMBO_PRESETS, so any saved Sofa Combo Rule that references
// `preset_id = '1S'` keeps resolving after the migration to maintenance
// config.
// ----------------------------------------------------------------------------

import type { SofaPriceTier } from './sofa-combo-pricing';

export type SofaQuickPreset = {
  /** Stable key — used as preset_id on sofa combo rules. Never rename
      after a combo rule has referenced it. Commander adds new entries
      with brand-new ids. */
  id: string;
  /** User-facing label shown on the Quick Presets chip + Quick Pick card. */
  label: string;
  /** Canonical compartment codes in left-to-right order — e.g.
      ['1A(LHF)','2A(RHF)']. Drives the New Combo composer prefill, the
      POS Configurator Customize preview, and Combo Rule pricing. */
  modules: string[];
  /** Display order; ascending. Falls back to array index when missing. */
  sortOrder?: number;
  /** Toggle to hide a preset without deleting it (keeps history clean
      when commander wants to retire a layout). Defaults to true. */
  active?: boolean;
  /** Optional default tier (PRICE_1 / PRICE_2 / PRICE_3) — applied when
      operation creates a new Sofa Combo rule using this preset. Omit
      to leave the tier picker on "— Any —". */
  defaultTier?: SofaPriceTier;
};

/** Migration-period fallback: the 11 hardcoded ids that used to live in
 *  apps/backend/src/components/SofaComboTab.tsx COMBO_PRESETS. Both the
 *  Backend Sofa Combo composer and the POS Configurator Quick Pick screen
 *  read from this list when maintenance_config.sofaQuickPresets is absent,
 *  so existing deployments keep working until commander overrides it. */
export const DEFAULT_SOFA_QUICK_PRESETS: SofaQuickPreset[] = [
  { id: '1S',       label: '1-Seater',                modules: ['1A(LHF)', '1A(RHF)'] },
  { id: '2S',       label: '2-Seater',                modules: ['2A(LHF)', '2A(RHF)'] },
  { id: '3S-L',     label: '3-Seater (1+2)',          modules: ['1A(LHF)', '2A(RHF)'] },
  { id: '3S-R',     label: '3-Seater (2+1)',          modules: ['2A(LHF)', '1A(RHF)'] },
  { id: '2+L-L',    label: '2 + L (chaise left)',     modules: ['L(LHF)', '2A(RHF)'] },
  { id: '2+L-R',    label: '2 + L (chaise right)',    modules: ['2A(LHF)', 'L(RHF)'] },
  { id: '3+L-L',    label: '3 + L (chaise left)',     modules: ['L(LHF)', '1NA', '2A(RHF)'] },
  { id: '3+L-R',    label: '3 + L (chaise right)',    modules: ['2A(LHF)', '1NA', 'L(RHF)'] },
  { id: '2WC',      label: '2-Seater + Console',      modules: ['1A(LHF)', 'Console', '1A(RHF)'] },
  { id: 'CORNER-L', label: 'Corner (LHF)',            modules: ['1A(LHF)', 'CNR', '2A(RHF)'] },
  { id: 'CORNER-R', label: 'Corner (RHF)',            modules: ['2A(LHF)', 'CNR', '1A(RHF)'] },
];

/** Resolve the effective Quick Presets list for a given maintenance
 *  config blob. Returns the override array when present (with empty
 *  / inactive entries filtered out + stable sort), otherwise falls
 *  back to DEFAULT_SOFA_QUICK_PRESETS. Use this everywhere a reader
 *  needs to consume the list — keeps the fallback rule in one place. */
export const resolveSofaQuickPresets = (
  stored: SofaQuickPreset[] | undefined,
): SofaQuickPreset[] => {
  if (!stored || stored.length === 0) return DEFAULT_SOFA_QUICK_PRESETS;
  return [...stored]
    .filter((p) => p.active !== false && p.modules.length > 0 && p.id.trim())
    .sort((a, b) => {
      const ao = a.sortOrder ?? 1e6;
      const bo = b.sortOrder ?? 1e6;
      return ao - bo;
    });
};
