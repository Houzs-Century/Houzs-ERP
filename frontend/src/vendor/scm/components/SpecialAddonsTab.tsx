// ----------------------------------------------------------------------------
// SpecialAddonsTab — Backend parity with the POS "Special Add-ons" tab
// (Loo 2026-06-08). Two managers behind one sub-nav, both writing the SAME
// shared tables the POS tab writes (special_addons via /special-addons,
// addons via supabase RLS), so POS and Backend stay in lockstep:
//
//   Product Add-ons → per-Model surcharge options (special_addons). Replaces
//                     the legacy Maintenance > Specials editor.
//   Order Add-ons   → whole-order one-time fees (addons): Dispose, Lift.
//
// Ported verbatim from apps/pos/src/pages/Products.tsx (SpecialAddonsManager +
// OrderAddonsManager). Two apps can't import each other (CLAUDE.md §file
// scoping), so the UI is copied; the data layer is the one shared API.
//
// ── THE EDIT GATE (2026-07-19) ───────────────────────────────────────────────
//
// This file used to carry `const canEdit = true` at module scope, justified as
// "RLS is the real write gate; the editor renders for everyone (server
// rejects)". That justification was wrong twice over.
//
//   1. It was not RLS. Both managers write through the Houzs Worker, not a
//      supabase client, so no RLS policy is in the path at all. /special-addons
//      gates every write on canWriteScmConfig (special-addons.ts requireWrite).
//      The UI meanwhile advertised Edit / Delete / +New / inline price inputs to
//      EVERY user who reached the tab, and each control 403'd on click — the
//      write surface was completely ungated on this side of the wire.
//   2. "The server rejects" is not a gate, it is an apology. A control that
//      renders and then fails teaches the operator that the app is broken, not
//      that they lack a permission — and it costs a round-trip to say so.
//
// Both managers now read ONE server-decided answer, `scm.config.write`, which
// IS canWriteScmConfig (backend/src/services/capabilities.ts composes the same
// two terms; backend/tests/capabilities.test.ts pins them equal over every live
// position). The frontend computes nothing.
//
// ── WHY ONE KEY FOR TWO ROUTES ───────────────────────────────────────────────
//
// The two managers do NOT share a backend gate:
//   Product Add-ons → /special-addons: scmAreaGuard(scm.procurement.products,
//                     openRead) AND THEN requireWrite → canWriteScmConfig.
//   Order Add-ons   → /addons:         scmAreaGuard(scm.procurement.products)
//                     alone. No route-level write check.
//
// So `scm.config.write` is an EXACT match for the Product half and a NARROWER
// one for the Order half. Narrower is the safe direction, and here it is also
// the CORRECT one rather than an accident: this tab is only reachable inside SO
// Maintenance, which is gated on `scm.maintenance.open` = canWriteScmConfig ∪
// director. The only members of that cohort who lack canWriteScmConfig are
// Sales Director and Finance Manager — precisely the READ-ONLY director tier the
// owner named on 2026-07-15. Withholding the editor from them is that ruling,
// not a new one. Nobody else can open the page to be narrowed.
//
// What is NOT done here, deliberately: giving /addons its own capability. That
// would mean naming scmAreaGuard's write decision as a capability, which means
// extracting the guard's body into a pure predicate that both the middleware and
// the registry call. That is the right shape and it is a bigger, shared-hot-path
// change than this one — see the PR body.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { Button } from '@2990s/design-system';
import {
  useSpecialAddons, useCreateSpecialAddon, useUpdateSpecialAddon, useDeleteSpecialAddon,
  useAllAddons, useUpdateAddon, useCreateAddon, useDeleteAddon, useCreateMfgProduct,
  type SpecialAddonRow, type SpecialAddonGroup, type SpecialAddonInput, type AdminAddonRow,
} from '../lib/mfg-products-queries';
import { DataGrid, type DataGridColumn } from './DataGrid';
import { useConfirm } from './ConfirmDialog';
import { sortByText } from '../lib/sort-options';
/* The host app's capability reader — the same import ScanOrderModal already
   makes into `../../../auth`. NOT the vendor lib/auth.ts role bridge: that shim
   collapses every caller to super_admin-or-sales off `can('*')`, which is a
   THIRD answer to this question and is exactly the kind of second copy the
   capability registry exists to abolish. */
import { useCapability } from '../../../auth/capabilities';

/* Stop-propagation wrapper for interactive cells inside the DataGrid —
   keeps clicks on inputs / buttons from also firing the row click. */
const stopProps = {
  onClick: (e: React.MouseEvent) => e.stopPropagation(),
  onDoubleClick: (e: React.MouseEvent) => e.stopPropagation(),
};

const SA_CATEGORIES = ['BEDFRAME', 'MATTRESS', 'SOFA'] as const;
const senToRm = (sen: number): number => Math.round(sen) / 100;
const rmToSen = (rm: number): number => Math.round(rm * 100);

const emptySpecialAddon = (): SpecialAddonInput => ({
  code: '', label: '', soDescription: '', categories: [],
  sellingPriceSen: 0, costPriceSen: 0, optionGroups: [], active: true, sortOrder: 0,
});

/* ONE price (owner 2026-06-22), and it is the COST — corrected 2026-09-13.
   The number here feeds SO COSTING, which reads special_addons.cost_price_sen
   (buildSpecialsPoolFromAddons → def.costPriceSen → lookupCost). That half was
   always right.

   WHAT WAS WRONG: it was also written to `selling_price_sen`, "so the two
   columns never diverge". They are not two spellings of one number. The
   SELLING side reads `sellingPriceSen` and ADDS it to what the customer pays
   (shared/mfg-pricing.ts:223-234 lookupSelling → :532 of
   lib/mfg-pricing-recompute.ts), and that file's own comment states the design:
   "variant priceSen is COST, NOT selling ... surcharges contribute 0 to selling
   until a director sets a value". Syncing the columns made "a director set a
   value" accidentally TRUE for every option somebody priced — eleven of this
   company's thirty-five, each with selling exactly equal to cost, which is the
   signature of a copied column.

   Owner 2026-09-13: 「我放的都是 costing 啊 为什么会 show 在 SO 和影响 SO 呢？
   完全都不需要有这个功能啊」. So this writes the COST only. `selling_price_sen`
   stays in the schema and the API — a Sales Director can still author a real
   selling surcharge deliberately, and company 2 carries the value to the 2990s
   POS, which sets its own price — but this screen no longer sets it by accident.
   docs/bugs/0852. */
const withSyncedPrice = (priceSen: number): { costPriceSen: number } =>
  ({ costPriceSen: priceSen });

// ════════════════════════════════════════════════════════════════════════
// Sub-nav wrapper (mirrors the POS Product Add-ons / Order Add-ons left rail)
// ════════════════════════════════════════════════════════════════════════

type SaSection = 'product' | 'order';

export const SpecialAddonsTab = ({ orderOnly = false }: { orderOnly?: boolean } = {}) => {
  const [section, setSection] = useState<SaSection>(orderOnly ? 'order' : 'product');
  const tab = (key: SaSection, label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={section === key}
      onClick={() => setSection(key)}
      style={{
        textAlign: 'left', padding: '8px 12px', borderRadius: 'var(--radius-md)',
        border: '1px solid ' + (section === key ? 'var(--line-strong)' : 'transparent'),
        background: section === key ? 'var(--c-cream)' : 'transparent',
        fontSize: 'var(--fs-14)', fontWeight: section === key ? 600 : 400, cursor: 'pointer', width: '100%',
      }}
    >
      {label}
    </button>
  );
  // Specials (Product Add-ons) now live in Maintenance > BEDFRAME/SOFA
  // (Commander 2026-06-16). When embedded order-only, this renders just the
  // whole-order fee manager (Dispose / Lift) — no Product Add-ons sub-nav.
  if (orderOnly) {
    return (
      <div style={{ padding: 'var(--space-4)' }}>
        <OrderAddonsManager />
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', gap: 'var(--space-4)', padding: 'var(--space-4)' }}>
      <nav style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 180 }} role="tablist" aria-label="Special add-ons">
        <span style={{ fontSize: 'var(--fs-12)', fontWeight: 600, color: 'var(--fg-muted)', letterSpacing: '.04em', padding: '0 4px 4px' }}>PRODUCT ADD-ONS</span>
        {tab('product', 'Product Add-ons')}
        <span style={{ fontSize: 'var(--fs-12)', fontWeight: 600, color: 'var(--fg-muted)', letterSpacing: '.04em', padding: 'var(--space-3) 4px 4px' }}>ORDER ADD-ONS</span>
        {tab('order', 'Order Add-ons')}
      </nav>
      <div style={{ flex: 1, minWidth: 0, border: '1px solid var(--line)', borderRadius: 'var(--radius-lg)', background: 'var(--c-paper, #fff)' }}>
        {section === 'product' ? <SpecialAddonsManager /> : <OrderAddonsManager />}
      </div>
    </div>
  );
};

// ════════════════════════════════════════════════════════════════════════
// Product Add-ons (special_addons) — per-Model surcharge options
// ════════════════════════════════════════════════════════════════════════

/* categoryFilter (Commander 2026-06-16) — when set (e.g. 'BEDFRAME' / 'SOFA'),
   the manager is embedded inside Maintenance under that category: it lists only
   that category's add-ons, defaults a new add-on to it, hides the Categories
   column + the global intro. Omit → the original all-categories manager. Same
   `special_addons` data either way (shared with POS), so nothing forks. */
export const SpecialAddonsManager = ({ categoryFilter }: { categoryFilter?: string } = {}) => {
  const list    = useSpecialAddons();
  const create  = useCreateSpecialAddon();
  const update  = useUpdateSpecialAddon();
  const del     = useDeleteSpecialAddon();
  const askConfirm = useConfirm();
  /* GATE: special-addons.ts requireWrite → houzs-perms.canWriteScmConfig.
     Fails CLOSED — no capability set, an absent key, or anything that is not
     literally `true` reads false and the editor does not render. */
  const canEdit = useCapability('scm.config.write');

  const [editing, setEditing] = useState<{ id: string | null; draft: SpecialAddonInput } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const startNew = () => {
    setError(null);
    setEditing({ id: null, draft: { ...emptySpecialAddon(), categories: categoryFilter ? [categoryFilter] : [] } });
  };
  const startEdit = (row: SpecialAddonRow) => {
    setError(null);
    setEditing({ id: row.id, draft: {
      code: row.code, label: row.label, soDescription: row.soDescription,
      categories: [...row.categories], sellingPriceSen: row.sellingPriceSen,
      costPriceSen: row.costPriceSen, optionGroups: JSON.parse(JSON.stringify(row.optionGroups)),
      active: row.active, sortOrder: row.sortOrder,
    } });
  };

  const patch = (p: Partial<SpecialAddonInput>) =>
    setEditing((e) => (e ? { ...e, draft: { ...e.draft, ...p } } : e));

  const toggleCat = (cat: string) => {
    if (!editing) return;
    const has = editing.draft.categories.includes(cat);
    patch({ categories: has ? editing.draft.categories.filter((c) => c !== cat) : [...editing.draft.categories, cat] });
  };

  // ── option_groups (追问) editing ────────────────────────────────────────
  const setGroups = (groups: SpecialAddonGroup[]) => patch({ optionGroups: groups });
  const addGroup = () => editing && setGroups([...editing.draft.optionGroups, { label: '', required: true, choices: [{ label: '', extraSen: 0 }] }]);
  const removeGroup = (gi: number) => editing && setGroups(editing.draft.optionGroups.filter((_, i) => i !== gi));
  const patchGroup = (gi: number, p: Partial<SpecialAddonGroup>) =>
    editing && setGroups(editing.draft.optionGroups.map((g, i) => (i === gi ? { ...g, ...p } : g)));
  const addChoice = (gi: number) =>
    editing && patchGroup(gi, { choices: [...editing.draft.optionGroups[gi]!.choices, { label: '', extraSen: 0 }] });
  const patchChoice = (gi: number, ci: number, p: Partial<{ label: string; extraSen: number }>) =>
    editing && patchGroup(gi, { choices: editing.draft.optionGroups[gi]!.choices.map((c, i) => (i === ci ? { ...c, ...p } : c)) });
  const removeChoice = (gi: number, ci: number) =>
    editing && patchGroup(gi, { choices: editing.draft.optionGroups[gi]!.choices.filter((_, i) => i !== ci) });

  const save = async () => {
    if (!editing) return;
    setError(null);
    const d = editing.draft;
    if (!d.code.trim() || !d.label.trim()) { setError('Code and label are required.'); return; }
    if (d.categories.length === 0) { setError('Pick at least one category.'); return; }
    for (const g of d.optionGroups) {
      if (!g.label.trim()) { setError('Every follow-up question needs a label.'); return; }
      if (g.choices.length === 0 || g.choices.some((c) => !c.label.trim())) { setError(`"${g.label || 'question'}" needs at least one named choice.`); return; }
    }
    try {
      if (editing.id) await update.mutateAsync({ id: editing.id, patch: d });
      else await create.mutateAsync(d);
      setEditing(null);
    } catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong.'); }
  };

  const remove = async (row: SpecialAddonRow) => {
    if (!(await askConfirm({
      title: `Delete "${row.label}"?`,
      body: 'This removes the add-on definition (existing orders keep their saved text).',
      confirmLabel: 'Delete',
      danger: true,
    }))) return;
    setError(null);
    try { await del.mutateAsync(row.id); if (editing?.id === row.id) setEditing(null); }
    catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong.'); }
  };

  // Plain RM amount matching the other Maintenance panels: positive shows NO
  // sign ("RM 200.00"), only negatives get a minus; always 2 decimals. The old
  // "+RM" surcharge style was inconsistent with the rest (Commander 2026-06-16).
  const rm = (sen: number) => `${sen < 0 ? '−' : ''}RM ${Math.abs(senToRm(sen)).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const inputStyle: React.CSSProperties = { width: '100%', padding: '8px 10px', fontSize: 'var(--fs-14)', border: '1px solid var(--line-strong)', borderRadius: 'var(--radius-md)', background: 'var(--c-cream)' };

  /* DataGrid columns (owner request 2026-06-12). `startEdit` / `remove` are
     re-created per render, so the memo keys on them — correctness over the
     memo bail-out (the list is a handful of rows). */
  const saColumns = useMemo<DataGridColumn<SpecialAddonRow>[]>(() => [
    {
      key: 'addon',
      label: 'Add-on',
      width: 220,
      accessor: (row) => (
        <span>
          <div style={{ fontWeight: 600, fontSize: 'var(--fs-13)' }}>{row.label}</div>
          <div style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>{row.soDescription || row.code}</div>
        </span>
      ),
      searchValue: (row) => `${row.label} ${row.soDescription} ${row.code}`,
      filterValue: (row) => row.label,
      sortFn: (a, b) => (a.label ?? '').localeCompare(b.label ?? ''),
    },
    {
      key: 'categories',
      label: 'Categories',
      width: 160,
      accessor: (row) => row.categories.join(', ') || '—',
      filterValue: (row) => row.categories.join(', ') || '—',
    },
    {
      key: 'base',
      label: 'Base',
      width: 100,
      align: 'right',
      accessor: (row) => <span style={{ fontWeight: 600 }}>{rm(row.costPriceSen)}</span>,
      searchValue: () => '',
      filterValue: (row) => rm(row.costPriceSen),
      sortFn: (a, b) => a.costPriceSen - b.costPriceSen,
    },
    {
      key: 'followup',
      label: 'Follow-up',
      width: 220,
      accessor: (row) => (
        <span style={{ color: 'var(--fg-muted)' }}>
          {row.optionGroups.length === 0 ? '—' : row.optionGroups.map((g) => `${g.label} (${g.choices.length})`).join(' · ')}
        </span>
      ),
      searchValue: (row) => row.optionGroups.map((g) => g.label).join(' '),
      filterValue: (row) => (row.optionGroups.length === 0 ? '—' : `${row.optionGroups.length} question${row.optionGroups.length === 1 ? '' : 's'}`),
      sortFn: (a, b) => a.optionGroups.length - b.optionGroups.length,
    },
    {
      key: 'actions',
      label: '',
      width: 150,
      align: 'right',
      sortable: false,
      groupable: false,
      accessor: (row) => (
        <span {...stopProps} style={{ whiteSpace: 'nowrap' }}>
          {canEdit && (
            <>
              <button type="button" onClick={() => startEdit(row)} style={{ fontSize: 'var(--fs-12)', background: 'none', border: '1px solid var(--line)', borderRadius: 'var(--radius-sm)', padding: '3px 10px', cursor: 'pointer', marginRight: 6 }}>Edit</button>
              <button type="button" onClick={() => void remove(row)} style={{ fontSize: 'var(--fs-12)', background: 'none', border: '1px solid var(--line)', borderRadius: 'var(--radius-sm)', padding: '3px 10px', cursor: 'pointer', color: 'var(--c-burnt, #A6471E)' }}>Delete</button>
            </>
          )}
          {!row.active && <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)', marginLeft: 6 }}>off</span>}
        </span>
      ),
      searchValue: () => '',
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [editing?.id]);

  return (
    <div style={{ padding: 'var(--space-5)', maxWidth: 860 }}>
      {!categoryFilter && (
        <p style={{ fontSize: 'var(--fs-13)', color: 'var(--fg-muted)', marginBottom: 'var(--space-4)' }}>
          每个 add-on = 名字 + SO 描述 + 适用 Category + 加价（可为负 = 减价）+ 0~多个追问（如 Right Drawer → 10″/8″，每个选项可各带价）。
          勾哪个 Model 用，在 <strong>Modular</strong> tab 决定。只动卖价，不开新 SKU、不动成本。
        </p>
      )}

      {canEdit && !editing && (
        <Button variant="primary" size="sm" onClick={startNew}>+ New add-on</Button>
      )}
      {error && <div style={{ color: 'var(--c-burnt, #A6471E)', fontSize: 'var(--fs-13)', margin: 'var(--space-3) 0' }} role="alert">{error}</div>}

      {/* ── Editor ── */}
      {editing && (
        <div style={{ border: '1px solid var(--line-strong)', borderRadius: 'var(--radius-lg)', padding: 'var(--space-4)', margin: 'var(--space-3) 0', background: 'var(--c-paper, #fff)' }}>
          <h3 style={{ fontSize: 'var(--fs-15)', fontWeight: 600, marginBottom: 'var(--space-3)' }}>
            {editing.id ? `Edit · ${editing.draft.label || editing.draft.code}` : 'New special add-on'}
          </h3>
          <div style={{ display: 'flex', gap: 'var(--space-4)', flexWrap: 'wrap', marginBottom: 'var(--space-3)' }}>
            <label style={{ flex: '1 1 220px' }}>
              <span style={{ display: 'block', fontSize: 'var(--fs-13)', fontWeight: 600, marginBottom: 4 }}>Code (stable key)</span>
              <input style={inputStyle} value={editing.draft.code} disabled={!!editing.id}
                onChange={(e) => patch({ code: e.target.value })} placeholder="Right Drawer" />
              {editing.id && <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>Code can't change after creation (it's the Model/order key).</span>}
            </label>
            <label style={{ flex: '1 1 220px' }}>
              <span style={{ display: 'block', fontSize: 'var(--fs-13)', fontWeight: 600, marginBottom: 4 }}>Label</span>
              <input style={inputStyle} value={editing.draft.label} onChange={(e) => patch({ label: e.target.value })} placeholder="Right Drawer" />
            </label>
          </div>
          <label style={{ display: 'block', marginBottom: 'var(--space-3)' }}>
            <span style={{ display: 'block', fontSize: 'var(--fs-13)', fontWeight: 600, marginBottom: 4 }}>SO description (prints under the product)</span>
            <input style={inputStyle} value={editing.draft.soDescription} onChange={(e) => patch({ soDescription: e.target.value })} placeholder="Right pull-out drawer" />
          </label>

          <div style={{ display: 'flex', gap: 'var(--space-5)', flexWrap: 'wrap', marginBottom: 'var(--space-3)' }}>
            <div>
              <span style={{ display: 'block', fontSize: 'var(--fs-13)', fontWeight: 600, marginBottom: 4 }}>Categories</span>
              <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
                {SA_CATEGORIES.map((cat) => (
                  <label key={cat} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 'var(--fs-13)' }}>
                    <input type="checkbox" checked={editing.draft.categories.includes(cat)} onChange={() => toggleCat(cat)} />
                    {cat}
                  </label>
                ))}
              </div>
            </div>
            <label>
              <span style={{ display: 'block', fontSize: 'var(--fs-13)', fontWeight: 600, marginBottom: 4 }}>Cost (RM, can be −)</span>
              {/* The COST that flows to SO costing. It is NOT a customer
                  surcharge and is no longer written to selling_price_sen. */}
              <input type="number" step={1} style={{ ...inputStyle, width: 140 }}
                value={senToRm(editing.draft.costPriceSen)}
                onChange={(e) => patch(withSyncedPrice(rmToSen(Number(e.target.value) || 0)))} />
            </label>
            <label style={{ display: 'flex', alignItems: 'flex-end', gap: 6, fontSize: 'var(--fs-13)' }}>
              <input type="checkbox" checked={editing.draft.active} onChange={(e) => patch({ active: e.target.checked })} />
              Active
            </label>
          </div>

          {/* option_groups */}
          <div style={{ borderTop: '1px solid var(--line)', paddingTop: 'var(--space-3)', marginBottom: 'var(--space-3)' }}>
            <span style={{ display: 'block', fontSize: 'var(--fs-13)', fontWeight: 600, marginBottom: 6 }}>Follow-up questions (optional)</span>
            {editing.draft.optionGroups.map((g, gi) => (
              <div key={gi} style={{ border: '1px solid var(--line)', borderRadius: 'var(--radius-md)', padding: 'var(--space-3)', marginBottom: 'var(--space-2)' }}>
                <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', marginBottom: 6 }}>
                  <input style={{ ...inputStyle, flex: '1 1 160px' }} placeholder="Question (e.g. Thickness)" value={g.label} onChange={(e) => patchGroup(gi, { label: e.target.value })} />
                  <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 'var(--fs-12)' }}>
                    <input type="checkbox" checked={g.required} onChange={(e) => patchGroup(gi, { required: e.target.checked })} /> required
                  </label>
                  <button type="button" onClick={() => removeGroup(gi)} style={{ fontSize: 'var(--fs-12)', color: 'var(--c-burnt, #A6471E)', background: 'none', border: 'none', cursor: 'pointer' }}>remove ✕</button>
                </div>
                {g.choices.map((c, ci) => (
                  <div key={ci} style={{ display: 'flex', gap: 'var(--space-2)', marginBottom: 4, paddingLeft: 'var(--space-3)' }}>
                    <input style={{ ...inputStyle, flex: '1 1 120px' }} placeholder={'Choice (e.g. 10")'} value={c.label} onChange={(e) => patchChoice(gi, ci, { label: e.target.value })} />
                    <input type="number" step={1} style={{ ...inputStyle, width: 120 }} title="Extra RM (can be −)" value={senToRm(c.extraSen)} onChange={(e) => patchChoice(gi, ci, { extraSen: rmToSen(Number(e.target.value) || 0) })} />
                    <button type="button" onClick={() => removeChoice(gi, ci)} style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)', background: 'none', border: 'none', cursor: 'pointer' }}>✕</button>
                  </div>
                ))}
                <button type="button" onClick={() => addChoice(gi)} style={{ fontSize: 'var(--fs-12)', marginLeft: 'var(--space-3)', background: 'none', border: '1px dashed var(--line-strong)', borderRadius: 'var(--radius-sm)', padding: '2px 8px', cursor: 'pointer' }}>+ choice</button>
              </div>
            ))}
            <button type="button" onClick={addGroup} style={{ fontSize: 'var(--fs-13)', background: 'none', border: '1px dashed var(--line-strong)', borderRadius: 'var(--radius-md)', padding: '4px 10px', cursor: 'pointer' }}>+ Add question</button>
          </div>

          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
            <Button variant="primary" size="sm" onClick={() => void save()} disabled={create.isPending || update.isPending}>
              {create.isPending || update.isPending ? 'Saving…' : 'Save'}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => { setEditing(null); setError(null); }}>Cancel</Button>
          </div>
        </div>
      )}

      {/* ── List ──
          categoryFilter (embedded in Maintenance > BEDFRAME/SOFA): render CALM
          CARD ROWS matching the other Maintenance panels (Divan Heights etc.) —
          number · name/desc · +RM · Active · ✕ — click a row to edit. No
          DataGrid chrome (Commander 2026-06-16, "这整个要做的跟它一样的 UI").
          The follow-up-question editing still uses the form above (a price row
          can't hold them). Standalone tab keeps the full DataGrid. */}
      {list.error ? (
        <div style={{ color: 'var(--c-burnt, #A6471E)', marginTop: 'var(--space-3)' }}>Failed to load: {String(list.error)}</div>
      ) : categoryFilter ? (
        <div style={{ marginTop: 'var(--space-3)', display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          {(list.data ?? []).filter((r) => r.categories.includes(categoryFilter)).map((r, i) => (
            <div
              key={r.id}
              onClick={() => startEdit(r)}
              title="Click to edit"
              style={{
                display: 'grid', gridTemplateColumns: '28px 1fr auto 64px 24px',
                alignItems: 'center', gap: 'var(--space-3)',
                padding: 'var(--space-3) var(--space-4)',
                background: 'var(--c-cream)', border: '1px solid var(--line)',
                borderRadius: 'var(--radius-md)', cursor: 'pointer',
                opacity: r.active ? 1 : 0.55,
              }}
            >
              <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-soft)' }}>{i + 1}</span>
              {/* Name only — match the other Maintenance panels (no description
                  subtitle). Commander 2026-06-16. */}
              <div style={{ minWidth: 0, fontSize: 'var(--fs-16)', fontWeight: 600, color: 'var(--c-ink)' }}>
                {r.label}
              </div>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-15)', color: 'var(--c-ink)', textAlign: 'right', whiteSpace: 'nowrap' }}>{rm(r.sellingPriceSen)}</span>
              <span style={{ fontSize: 'var(--fs-12)', fontWeight: 600, textAlign: 'right', color: r.active ? 'var(--c-green, #1a7a3a)' : 'var(--fg-muted)' }}>{r.active ? 'Active' : 'Inactive'}</span>
              <button type="button" title="Delete" onClick={(e) => { e.stopPropagation(); void remove(r); }}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--fg-muted)', fontSize: 'var(--fs-14)', lineHeight: 1 }}>✕</button>
            </div>
          ))}
          {!list.isLoading && (list.data ?? []).filter((r) => r.categories.includes(categoryFilter)).length === 0 && (
            <div style={{ color: 'var(--fg-muted)', fontSize: 'var(--fs-13)', padding: 'var(--space-3)' }}>
              No special add-ons in this category yet — click “+ New add-on”.
            </div>
          )}
        </div>
      ) : (
        <div style={{ marginTop: 'var(--space-3)' }}>
          <DataGrid
            rows={list.data ?? []}
            columns={saColumns}
            storageKey="dg-special-addons-product"
            exportName="Product Add-ons"
            rowKey={(r) => r.id}
            searchPlaceholder="Filter add-ons…"
            groupBanner={false}
            isLoading={list.isLoading}
            emptyMessage="No special add-ons yet."
            rowStyle={(r) => (r.active ? undefined : { opacity: 0.5 })}
          />
        </div>
      )}
    </div>
  );
};

// ════════════════════════════════════════════════════════════════════════
// Order Add-ons (addons table) — whole-order one-time fees
// ════════════════════════════════════════════════════════════════════════

const OA_ICONS = ['recycle', 'arrow-up-from-line', 'wrench', 'package', 'sparkles'];
const OA_KINDS: { value: 'qty' | 'flat' | 'floors_items'; label: string }[] = [
  { value: 'qty', label: 'Per piece (RM × qty)' },
  { value: 'flat', label: 'Flat fee (one-shot)' },
  { value: 'floors_items', label: 'Per floor · item (lift)' },
];
const oaSlugify = (s: string): string =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);

const OrderAddonsManager = () => {
  const list    = useAllAddons();
  const update  = useUpdateAddon();
  const create  = useCreateAddon();
  const del     = useDeleteAddon();
  const askConfirm = useConfirm();
  /* GATE: /addons is guarded by scmAreaGuard('scm.procurement.products') at the
     mount and has no route-level write check of its own. `scm.config.write` is
     therefore NARROWER than this route's API gate — deliberately, and see the
     header note for why that narrowing is the 2026-07-15 read-only-director
     ruling rather than a new rule. Fails CLOSED either way. */
  const canEdit = useCapability('scm.config.write');

  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const remove = async (row: AdminAddonRow) => {
    if (!(await askConfirm({
      title: `Delete "${row.label}"?`,
      body: "This permanently removes the add-on. If it's already on existing orders the delete is blocked — use the Off switch to retire it instead.",
      confirmLabel: 'Delete',
      danger: true,
    }))) return;
    setError(null);
    try {
      await del.mutateAsync(row.id);
    } catch (e) {
      /* authedFetch already humanised `message`; the fallback covers a
         non-Error throw so a raw object never reaches the user. */
      const msg = e instanceof Error ? e.message : 'Something went wrong.';
      setError(/foreign key|23503|still referenced/i.test(msg)
        ? `"${row.label}" is used on existing orders — can't delete. Use the Off switch to retire it.`
        : msg);
    }
  };
  const [draft, setDraft] = useState({
    label: '', id: '', description: '', icon: 'package',
    kind: 'qty' as 'qty' | 'flat' | 'floors_items', category: '',
    price: '', perFloorItem: '', unit: '', serviceSku: '', enabled: true,
  });
  const setD = (p: Partial<typeof draft>) => setDraft((d) => ({ ...d, ...p }));

  const mintSvc = useCreateMfgProduct();
  const SVC_RE = /^SVC-[A-Z0-9-]+$/;
  const SVC_FORMAT_MSG = 'SKU code must look like SVC-DISPOSE-WARDROBE (SVC- then capitals, digits, dashes).';
  const ensureSvcCatalogRow = async (code: string, label: string): Promise<void> => {
    try {
      await mintSvc.mutateAsync({ code, name: label, category: 'SERVICE' });
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      if (!msg.includes('duplicate_code')) throw e; // already in the catalog = fine
    }
  };
  const commitSku = async (row: AdminAddonRow, raw: string): Promise<void> => {
    setError(null);
    const svc = raw.trim().toUpperCase();
    if ((svc || null) === (row.serviceSku ?? null)) return;
    if (svc && !SVC_RE.test(svc)) { setError(SVC_FORMAT_MSG); return; }
    try {
      if (svc) await ensureSvcCatalogRow(svc, row.label);
      update.mutate({ id: row.id, patch: { serviceSku: svc || null } }, { onError: (e) => setError(e instanceof Error ? e.message : 'Something went wrong.') });
    } catch (e) { setError(e instanceof Error ? e.message : 'Something went wrong.'); }
  };

  const commitField = (row: AdminAddonRow, patch: { price?: number; perFloorItem?: number | null; enabled?: boolean }) => {
    setError(null);
    const synced = patch.enabled !== undefined ? { ...patch, showAtHandover: patch.enabled } : patch;
    update.mutate({ id: row.id, patch: synced }, { onError: (e) => setError(e instanceof Error ? e.message : 'Something went wrong.') });
  };

  const submitNew = async () => {
    setError(null);
    const id = (draft.id || oaSlugify(draft.label)).trim();
    if (!draft.label.trim()) { setError('Label is required.'); return; }
    if (!/^[a-z0-9-]+$/.test(id)) { setError('ID must be lowercase letters, digits, dashes.'); return; }
    if ((list.data ?? []).some((a) => a.id === id)) { setError(`ID "${id}" already exists.`); return; }
    const isFloors = draft.kind === 'floors_items';
    const rate = Math.round(Number(isFloors ? draft.perFloorItem : draft.price) || 0);
    if (rate <= 0) {
      setError(isFloors
        ? 'Per floor·item rate must be above 0 — a 0 rate books nothing on the SO.'
        : 'Price must be above 0 — a RM0 add-on books nothing on the SO.');
      return;
    }
    const svc = draft.serviceSku.trim().toUpperCase();
    if (svc && !SVC_RE.test(svc)) { setError(SVC_FORMAT_MSG); return; }
    const maxSort = (list.data ?? []).reduce((m, a) => Math.max(m, a.sortOrder), 0);
    try {
      if (svc) await ensureSvcCatalogRow(svc, draft.label.trim());
      await create.mutateAsync({
        id, label: draft.label.trim(), description: draft.description.trim() || null,
        icon: draft.icon, kind: draft.kind, category: draft.category.trim() || null,
        price: isFloors ? 0 : rate, perFloorItem: isFloors ? rate : null,
        unit: draft.kind === 'flat' ? null : (draft.unit.trim() || null),
        stock: null, enabled: draft.enabled,
        showAtHandover: draft.enabled, serviceSku: svc || null, sortOrder: maxSort + 1,
      });
      setCreating(false);
      setDraft({ label: '', id: '', description: '', icon: 'package', kind: 'qty', category: '', price: '', perFloorItem: '', unit: '', serviceSku: '', enabled: true });
    } catch (e) { setError(e instanceof Error ? e.message : 'Something went wrong.'); }
  };

  const inputStyle: React.CSSProperties = { width: '100%', padding: '8px 10px', fontSize: 'var(--fs-14)', border: '1px solid var(--line-strong)', borderRadius: 'var(--radius-md)', background: 'var(--c-cream)' };

  /* DataGrid columns — inline editors commit on blur exactly as before.
     Keyed on the commit helpers' upstream state so closures never go stale
     (tiny list; memo bail-out is not the point here). */
  const oaColumns = useMemo<DataGridColumn<AdminAddonRow>[]>(() => [
    {
      key: 'addon',
      label: 'Add-on',
      width: 200,
      accessor: (row) => (
        <span>
          <div style={{ fontWeight: 600, fontSize: 'var(--fs-13)' }}>{row.label}</div>
          <div style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>{row.description || row.id}</div>
        </span>
      ),
      searchValue: (row) => `${row.label} ${row.description ?? ''} ${row.id}`,
      filterValue: (row) => row.label,
      sortFn: (a, b) => (a.label ?? '').localeCompare(b.label ?? ''),
    },
    {
      key: 'kind',
      label: 'Kind',
      width: 100,
      accessor: (row) => (
        <span style={{ color: 'var(--fg-muted)' }}>{row.kind === 'floors_items' ? 'floor·item' : row.kind}</span>
      ),
      searchValue: (row) => row.kind,
      filterValue: (row) => (row.kind === 'floors_items' ? 'floor·item' : row.kind),
    },
    {
      key: 'sku',
      label: 'SKU code',
      width: 190,
      accessor: (row) => (
        <span {...stopProps} style={{ display: 'inline-flex' }}>
          {canEdit ? (
            <input style={{ width: 170, padding: '4px 8px', fontSize: 'var(--fs-12)', border: '1px solid var(--line-strong)', borderRadius: 'var(--radius-sm)', background: 'var(--c-cream)', textTransform: 'uppercase' }}
              defaultValue={row.serviceSku ?? ''} placeholder="SVC-ADDON"
              onBlur={(e) => { void commitSku(row, e.target.value); }} />
          ) : (
            <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>{row.serviceSku ?? 'SVC-ADDON'}</span>
          )}
        </span>
      ),
      searchValue: (row) => row.serviceSku ?? '',
      filterValue: (row) => row.serviceSku ?? 'SVC-ADDON',
      sortFn: (a, b) => (a.serviceSku ?? '').localeCompare(b.serviceSku ?? ''),
    },
    {
      key: 'price',
      label: 'Price / rate (RM)',
      width: 210,
      accessor: (row) => {
        const isFloors = row.kind === 'floors_items';
        return (
          <span {...stopProps} style={{ display: 'inline-flex', alignItems: 'center' }}>
            {canEdit ? (
              <input type="number" min={1} step={1} style={{ width: 100, padding: '4px 8px', fontSize: 'var(--fs-13)', border: '1px solid var(--line-strong)', borderRadius: 'var(--radius-sm)', background: 'var(--c-cream)' }}
                defaultValue={isFloors ? (row.perFloorItem ?? 0) : row.price}
                onBlur={(e) => {
                  const n = Math.max(0, Math.round(Number(e.target.value) || 0));
                  const current = isFloors ? (row.perFloorItem ?? 0) : row.price;
                  if (n === current) return;
                  if (n <= 0) { setError(`"${row.label}": rate must be above 0 — a 0 rate books nothing on the SO. Use the Off switch to retire it.`); return; }
                  if (isFloors) commitField(row, { perFloorItem: n });
                  else commitField(row, { price: n });
                }} />
            ) : (
              <span style={{ fontSize: 'var(--fs-13)' }}>RM {(isFloors ? row.perFloorItem ?? 0 : row.price).toLocaleString('en-MY')}</span>
            )}
            <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)', marginLeft: 6 }}>{isFloors ? `per floor·${row.unit ?? 'item'}` : row.kind === 'flat' ? 'charged once' : `per ${row.unit ?? 'piece'}`}</span>
          </span>
        );
      },
      searchValue: () => '',
      filterValue: (row) => String(row.kind === 'floors_items' ? (row.perFloorItem ?? 0) : row.price),
      sortFn: (a, b) =>
        (a.kind === 'floors_items' ? (a.perFloorItem ?? 0) : a.price)
        - (b.kind === 'floors_items' ? (b.perFloorItem ?? 0) : b.price),
    },
    {
      key: 'enabled',
      label: 'Enabled',
      width: 90,
      accessor: (row) => (
        <span {...stopProps} style={{ display: 'inline-flex' }}>
          <button type="button" role="switch" aria-checked={row.enabled} disabled={!canEdit}
            onClick={() => canEdit && commitField(row, { enabled: !row.enabled })}
            style={{ fontSize: 'var(--fs-12)', padding: '3px 10px', borderRadius: 999, border: '1px solid var(--line)', cursor: canEdit ? 'pointer' : 'default', background: row.enabled ? 'var(--c-cream)' : 'transparent', fontWeight: row.enabled ? 600 : 400 }}>
            {row.enabled ? 'On' : 'Off'}
          </button>
        </span>
      ),
      searchValue: (row) => (row.enabled ? 'On' : 'Off'),
      filterValue: (row) => (row.enabled ? 'On' : 'Off'),
      sortFn: (a, b) => Number(b.enabled) - Number(a.enabled),
    },
    {
      key: 'actions',
      label: '',
      width: 90,
      align: 'right',
      sortable: false,
      groupable: false,
      accessor: (row) => (
        <span {...stopProps} style={{ whiteSpace: 'nowrap' }}>
          {canEdit && (
            <button type="button" onClick={() => void remove(row)} disabled={del.isPending}
              style={{ fontSize: 'var(--fs-12)', background: 'none', border: '1px solid var(--line)', borderRadius: 'var(--radius-sm)', padding: '3px 10px', cursor: 'pointer', color: 'var(--c-burnt, #A6471E)' }}>
              Delete
            </button>
          )}
        </span>
      ),
      searchValue: () => '',
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [del.isPending, list.data]);

  return (
    <div style={{ padding: 'var(--space-5)', maxWidth: 820 }}>
      <p style={{ fontSize: 'var(--fs-13)', color: 'var(--fg-muted)', marginBottom: 'var(--space-4)' }}>
        整单一次性费用（处理旧床垫/床架、Lift 上楼）。结账时选，不绑 Model。这里设价钱 / 开关 / 新增。
      </p>

      {canEdit && !creating && <Button variant="primary" size="sm" onClick={() => { setError(null); setCreating(true); }}>+ New order add-on</Button>}
      {error && <div style={{ color: 'var(--c-burnt, #A6471E)', fontSize: 'var(--fs-13)', margin: 'var(--space-3) 0' }} role="alert">{error}</div>}

      {creating && (
        <div style={{ border: '1px solid var(--line-strong)', borderRadius: 'var(--radius-lg)', padding: 'var(--space-4)', margin: 'var(--space-3) 0' }}>
          <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap', marginBottom: 'var(--space-3)' }}>
            <label style={{ flex: '1 1 200px' }}><span style={{ display: 'block', fontSize: 'var(--fs-13)', fontWeight: 600, marginBottom: 4 }}>Label</span>
              <input style={inputStyle} value={draft.label} onChange={(e) => setD({ label: e.target.value, id: oaSlugify(e.target.value) })} placeholder="Dispose old wardrobe" /></label>
            <label style={{ flex: '1 1 160px' }}><span style={{ display: 'block', fontSize: 'var(--fs-13)', fontWeight: 600, marginBottom: 4 }}>ID slug</span>
              <input style={inputStyle} value={draft.id} onChange={(e) => setD({ id: e.target.value })} placeholder="auto from label" /></label>
          </div>
          <label style={{ display: 'block', marginBottom: 'var(--space-3)' }}><span style={{ display: 'block', fontSize: 'var(--fs-13)', fontWeight: 600, marginBottom: 4 }}>Description</span>
            <input style={inputStyle} value={draft.description} onChange={(e) => setD({ description: e.target.value })} placeholder="Short tagline (optional)" /></label>
          <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap', marginBottom: 'var(--space-3)' }}>
            <label><span style={{ display: 'block', fontSize: 'var(--fs-13)', fontWeight: 600, marginBottom: 4 }}>Kind</span>
              <select style={{ ...inputStyle, width: 200 }} value={draft.kind} onChange={(e) => setD({ kind: e.target.value as typeof draft.kind })}>
                {OA_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
              </select></label>
            <label><span style={{ display: 'block', fontSize: 'var(--fs-13)', fontWeight: 600, marginBottom: 4 }}>{draft.kind === 'floors_items' ? 'Per floor·item (RM)' : 'Price (RM)'}</span>
              <input type="number" min={0} step={1} style={{ ...inputStyle, width: 140 }}
                value={draft.kind === 'floors_items' ? draft.perFloorItem : draft.price}
                onChange={(e) => draft.kind === 'floors_items' ? setD({ perFloorItem: e.target.value }) : setD({ price: e.target.value })} /></label>
            {draft.kind !== 'flat' && (
              <label><span style={{ display: 'block', fontSize: 'var(--fs-13)', fontWeight: 600, marginBottom: 4 }}>Unit</span>
                <input style={{ ...inputStyle, width: 120 }} value={draft.unit} onChange={(e) => setD({ unit: e.target.value })} placeholder="piece" /></label>
            )}
            <label><span style={{ display: 'block', fontSize: 'var(--fs-13)', fontWeight: 600, marginBottom: 4 }}>SKU code</span>
              <input style={{ ...inputStyle, width: 200, textTransform: 'uppercase' }} value={draft.serviceSku}
                onChange={(e) => setD({ serviceSku: e.target.value.toUpperCase() })} placeholder="SVC-… (optional)" /></label>
            <label><span style={{ display: 'block', fontSize: 'var(--fs-13)', fontWeight: 600, marginBottom: 4 }}>Icon</span>
              <select style={{ ...inputStyle, width: 160 }} value={draft.icon} onChange={(e) => setD({ icon: e.target.value })}>
                {sortByText(OA_ICONS).map((i) => <option key={i} value={i}>{i}</option>)}
              </select></label>
          </div>
          {draft.kind === 'flat' && (
            <p style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)', margin: '0 0 var(--space-3)' }}>
              Flat fee is charged once per order — staff get no quantity field at checkout. Use “Per piece” for per-unit items.
            </p>
          )}
          <p style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)', margin: '0 0 var(--space-3)' }}>
            SKU code gives this add-on its own SVC-* line on the SO (reports aggregate per code). Leave blank to book under the generic SVC-ADDON.
          </p>
          <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
            <Button variant="primary" size="sm" onClick={() => void submitNew()} disabled={create.isPending}>{create.isPending ? 'Creating…' : 'Create'}</Button>
            <Button variant="ghost" size="sm" onClick={() => { setCreating(false); setError(null); }}>Cancel</Button>
          </div>
        </div>
      )}

      {/* DataGrid conversion (owner request 2026-06-12) — the inline SKU /
          price inputs, On-Off switch and Delete ride inside stop-propagation
          cells; commit-on-blur semantics unchanged. */}
      {list.error ? (
        <div style={{ color: 'var(--c-burnt, #A6471E)', marginTop: 'var(--space-3)' }}>Failed to load: {String(list.error)}</div>
      ) : (
        <div style={{ marginTop: 'var(--space-3)' }}>
          <DataGrid
            rows={list.data ?? []}
            columns={oaColumns}
            storageKey="dg-special-addons-order"
            exportName="Order Add-ons"
            rowKey={(r) => r.id}
            searchPlaceholder="Filter order add-ons…"
            groupBanner={false}
            isLoading={list.isLoading}
            emptyMessage="No order add-ons yet."
            rowStyle={(r) => (r.enabled ? undefined : { opacity: 0.55 })}
          />
        </div>
      )}
    </div>
  );
};
