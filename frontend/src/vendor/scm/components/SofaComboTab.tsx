// ----------------------------------------------------------------------------
// SofaComboTab — Sofa Combo Pricing UI.
//
// Commander 2026-05-28 ("去查看 hookka 的 combo module 把整个 copy 过来").
// Ported from HOOKKA's combo module spec — built fresh from the UI screenshot
// + commander's pricing-role + height-tier decisions.
//
// 2026-05-28 update — commander dropped customer scoping for 2990's B2C model
// ("2990 是不需要的。因为是 B2C 直接 apply 给全顾客的"). Removed:
//   · Copy-to-customer button + modal + API endpoint
//   · Customer filter dropdown
//   · Customer picker in New Combo modal (always null = applies to all)
//   · Customer chip on combo cards
// The DB column `customer_id` stays for future optionality but the UI never
// writes to it; every combo persists with customer_id = null.
//
// Layout:
//   header   — "Sofa Combo Pricing" + subtitle + "+ New Combo"
//   filters  — Base model dropdown + "N rules"
//   list     — grouped by base model; each combo card has the module
//              composition + tier + per-seat-height prices + Effective date
//              + Edit/History/Delete actions.
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Plus, Pencil, Trash2, History, X, CheckSquare, Square } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { DateField } from './DateField';
import { buildComboLabel, fmtSen, fmtDate, maintValues, normalizeCompartmentCode, SOFA_MODULES, type SofaPriceTier } from '@2990s/shared';
import {
  useSofaCombos,
  useCreateSofaCombo,
  useUpdateSofaCombo,
  useDeleteSofaCombo,
  useSofaComboHistory,
  useSofaComboAnchors,
  useSetSofaComboAnchor,
  type SofaComboRule,
  type NewSofaCombo,
} from '../lib/sofa-combos-queries';
import { useMfgProducts, useMaintenanceConfig } from '../lib/mfg-products-queries';
import { useSupplierDetail, useSuppliers, type SupplierRow } from '../lib/suppliers-queries';
import { useNotify } from './NotifyDialog';
import { useConfirm } from './ConfirmDialog';
import { EffectiveDatedHistory } from './EffectiveDatedHistory';
import { sortByText, sortByNumeric } from '../lib/sort-options';
import { todayMyt } from '../lib/dates';

// Seat-height columns mirror the live Maintenance pool (Products → Maintenance
// → Sofa → Sizes; config key `sofaSizes`). This fallback only shows if that
// config fails to load — same default the rest of the app uses.
const HEIGHTS_FALLBACK = ['24', '26', '28', '30', '32', '35'];
const TIERS: SofaPriceTier[] = ['PRICE_1', 'PRICE_2', 'PRICE_3'];

const ICON_PROPS = { size: 14, strokeWidth: 1.75 } as const;

const fmtRm = (centi: number | null | undefined): string => fmtSen(centi);


// Malaysia calendar date — the UTC version returned YESTERDAY before 08:00 MYT.
const todayIso = (): string => todayMyt();

const ALL_MODULE_CODES = SOFA_MODULES.map((m) => m.id).sort();

type ComboTabProps = {
  /**
   * Supplier scope. When set, the tab reads + writes combos scoped to this
   * supplier's purchasing side (customer_id stays null). When unset, it keeps
   * the original sales-side / master behaviour the Products page uses.
   */
  supplierId?: string;
};

export const SofaComboTab = ({ supplierId }: ComboTabProps) => {
  const [baseModelFilter, setBaseModelFilter] = useState<string>('');
  const [composer, setComposer] = useState<{ open: boolean; editing?: SofaComboRule }>({ open: false });
  const [historyFor, setHistoryFor] = useState<SofaComboRule | null>(null);

  // Batch price edit (#39) — multi-select combos then POST one fresher-effective
  // row per selected combo with adjusted prices. Append-only: never PUT/overwrite.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchOpen, setBatchOpen] = useState(false);
  const toggleSelected = (id: string) => {
    setSelectedIds((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  // Reset selection whenever the scope changes (base-model filter or supplier),
  // so a checkbox can't carry over to a different set of combos.
  useEffect(() => {
    setSelectedIds(new Set());
    setBatchOpen(false);
  }, [baseModelFilter, supplierId]);

  // Default scope: customer_id = null (applies to all). 2990 is B2C, so we
  // never let the UI write a customer_id. When a supplierId is supplied the
  // reads + writes are scoped to that supplier's purchasing side instead of
  // the sales-side / master combos.
  const combosQ = useSofaCombos({
    baseModel: baseModelFilter || undefined,
    customerId: null,
    supplierId,
  });
  const productsQ = useMfgProducts({ category: 'SOFA' });
  // Seat-height columns = the live Maintenance Sizes pool (single source of
  // truth, master scope), so a size added in Maintenance shows up here
  // automatically — even on the supplier-scoped purchasing view.
  const heightsCfgQ = useMaintenanceConfig('master');
  // ALL values (not just active) — existing combos may be priced on a
  // deactivated height and those columns must keep rendering.
  const heights = heightsCfgQ.data?.data?.sofaSizes
    ? maintValues(heightsCfgQ.data.data.sofaSizes)
    : HEIGHTS_FALLBACK;

  const baseModels = useMemo(() => {
    const set = new Set<string>();
    for (const p of productsQ.data ?? []) {
      const bm = (p as unknown as { base_model?: string | null }).base_model;
      if (bm) set.add(bm);
    }
    for (const r of combosQ.data ?? []) set.add(r.baseModel);
    return [...set].sort();
  }, [productsQ.data, combosQ.data]);

  // Per-base-model module codes sourced from the real sofa SKUs — mirrors
  // HOOKKA's `sizesByBaseModel` (src/pages/maintenance/sofa-combos.tsx:336)
  // which maps each baseModel → the distinct sizeCodes its SKUs carry. 2990's
  // sofa SKU encodes the compartment in its code suffix (commander's
  // sofaCodeFormat = '{model_code}-{compartment}'), so we slice the part after
  // the first '-'. The suffix, the chips, the stored combo `modules` and
  // SOFA_MODULES ids all share the ONE canonical parens vocabulary
  // ('1A(LHF)', 2026-06-04) — normalizeCompartmentCode only spell-checks a
  // stray legacy dash entry. The New Combo dialog's slot picker offers exactly
  // the compartments the chosen base model actually has in SKU master — no
  // more, no less — instead of the global ALL_MODULE_CODES list.
  const modulesByBaseModel = useMemo(() => {
    const m: Record<string, string[]> = {};
    for (const p of productsQ.data ?? []) {
      const row = p as unknown as { base_model?: string | null; code?: string | null };
      const bm = row.base_model;
      const code = row.code ?? '';
      if (!bm || !code) continue;
      const dashAt = code.indexOf('-');
      if (dashAt <= 0) continue; // orphan SKU with no compartment suffix
      const compartment = normalizeCompartmentCode(code.slice(dashAt + 1));
      if (!compartment) continue;
      const arr = (m[bm] ??= []);
      if (!arr.includes(compartment)) arr.push(compartment);
    }
    for (const arr of Object.values(m)) arr.sort();
    return m;
  }, [productsQ.data]);

  // Supplier-scoped only: derive base_model → the supplier's OWN model code so
  // each combo card can show "Booqit · 5539" — the code Hookka recognises on
  // their side. Source = this supplier's bindings (supplier_material_bindings).
  // A binding's material_code equals the product code (see PurchaseOrderDetail
  // pickProduct: materialCode = p.code), so we resolve base_model via products,
  // then take the supplier_sku's leading code ("5539-2A(LHF)" → "5539"; bare
  // "5539" stays "5539"). When a base_model carries several supplier codes we
  // pick the most common one. Empty/unmapped → card just shows base_model.
  const supplierDetailQ = useSupplierDetail(supplierId ?? null);

  const supplierCodeByBaseModel = useMemo(() => {
    if (!supplierId) return {} as Record<string, string>;
    // code (SKU) → base_model, from the SOFA products already in hand.
    const baseModelByCode = new Map<string, string>();
    for (const p of productsQ.data ?? []) {
      const row = p as unknown as { base_model?: string | null; code?: string | null };
      if (row.code && row.base_model) baseModelByCode.set(row.code, row.base_model);
    }
    // base_model → { supplierCode → count } so we can pick the most common.
    const tally: Record<string, Record<string, number>> = {};
    for (const b of supplierDetailQ.data?.bindings ?? []) {
      const bm = baseModelByCode.get(b.material_code);
      if (!bm) continue;
      const sku = (b.supplier_sku ?? '').trim();
      if (!sku) continue;
      const code = sku.split('-')[0]?.trim();
      if (!code) continue;
      const counts = (tally[bm] ??= {});
      counts[code] = (counts[code] ?? 0) + 1;
    }
    const out: Record<string, string> = {};
    for (const [bm, counts] of Object.entries(tally)) {
      let best = '';
      let bestN = -1;
      for (const [code, n] of Object.entries(counts)) {
        if (n > bestN) { best = code; bestN = n; }
      }
      if (best) out[bm] = best;
    }
    return out;
  }, [supplierId, productsQ.data, supplierDetailQ.data]);

  const grouped = useMemo(() => {
    const map = new Map<string, SofaComboRule[]>();
    for (const r of combosQ.data ?? []) {
      const arr = map.get(r.baseModel) ?? [];
      arr.push(r);
      map.set(r.baseModel, arr);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [combosQ.data]);

  const total = combosQ.data?.length ?? 0;

  const deleteM = useDeleteSofaCombo();
  const askConfirm = useConfirm();

  // Bulk soft-delete the selected combos (commander 2026-06-20: "不能
  // multiselect 删掉的吗?"). Same selection that feeds Batch price edit; each id
  // is soft-deleted (History still shows it) so it's reversible.
  const bulkDelete = async () => {
    if (selectedIds.size === 0) return;
    const n = selectedIds.size;
    if (!(await askConfirm({
      title: `Soft-delete ${n} combo${n === 1 ? '' : 's'}?`,
      body: '(History will still show them — this is reversible.)',
      confirmLabel: `Soft-delete ${n}`,
      danger: true,
    }))) return;
    const ids = [...selectedIds];
    await Promise.all(ids.map((id) => deleteM.mutateAsync(id).catch(() => null)));
    setSelectedIds(new Set());
  };

  // R8 — anchor a base_model to ONE supplier (sales-side view only). When
  // anchored, combo create + price edits mirror between this master combo and
  // the anchored supplier's scope (handled server-side). The control reads the
  // current anchor + the supplier master; changing it sets/clears the anchor.
  const isSalesSide = !supplierId;
  const anchorsQ = useSofaComboAnchors();
  const suppliersQ = useSuppliers({ status: 'ACTIVE' });
  const setAnchorM = useSetSofaComboAnchor();
  const anchorByModel = useMemo(() => {
    const m: Record<string, string> = {};
    for (const a of anchorsQ.data ?? []) m[a.base_model] = a.supplier_id;
    return m;
  }, [anchorsQ.data]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '8px 0' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <h2 style={{
            fontFamily: 'var(--font-display)',
            fontSize: 'var(--fs-22)',
            color: 'var(--c-ink)',
            margin: 0,
          }}>
            Sofa Combo Pricing
          </h2>
          <p style={{
            fontFamily: 'var(--font-sans)',
            fontSize: 'var(--fs-13)',
            color: 'var(--fg-soft)',
            margin: '4px 0 0',
            maxWidth: 720,
          }}>
            Module-set combo deals with optional same-fabric-tier discount.
            Append-only history; edits = a new row with a fresher effective date.
            {supplierId
              ? ' These combos are scoped to this supplier and used for purchasing (PO auto-pricing).'
              : ' All combos apply to every customer (2990 B2C model).'}
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          {selectedIds.size > 0 && (
            <Button variant="ghost" onClick={() => setBatchOpen(true)}>
              <Pencil {...ICON_PROPS} style={{ marginRight: 6 }} /> Batch price edit ({selectedIds.size})
            </Button>
          )}
          {selectedIds.size > 0 && (
            <Button
              variant="ghost"
              onClick={() => { void bulkDelete(); }}
              disabled={deleteM.isPending}
              style={{ color: 'var(--c-festive-b, #B8331F)' }}
            >
              <Trash2 {...ICON_PROPS} style={{ marginRight: 6 }} /> Delete ({selectedIds.size})
            </Button>
          )}
          <Button variant="primary" onClick={() => setComposer({ open: true })}>
            <Plus {...ICON_PROPS} style={{ marginRight: 6 }} /> New Combo
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px',
        background: 'var(--c-paper)', borderRadius: 'var(--radius-md)',
        border: '1px solid var(--line)',
      }}>
        <select
          value={baseModelFilter}
          onChange={(e) => setBaseModelFilter(e.target.value)}
          style={selectStyle}
        >
          <option value="">All base models</option>
          {sortByText(baseModels).map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <div style={{ flex: 1 }} />
        <span style={{
          fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-13)', color: 'var(--fg-soft)',
        }}>
          {total} {total === 1 ? 'rule' : 'rules'}
        </span>
      </div>

      {/* List */}
      {combosQ.isLoading ? (
        <p style={{ color: 'var(--fg-muted)' }}>Loading…</p>
      ) : grouped.length === 0 ? (
        <div style={{
          padding: 24, textAlign: 'center',
          background: 'var(--c-paper)', borderRadius: 'var(--radius-md)',
          border: '1px dashed var(--line)',
          color: 'var(--fg-muted)',
        }}>
          No combo rules yet. Click <strong>+ New Combo</strong> to create one.
        </div>
      ) : (
        grouped.map(([model, rules]) => (
          <section key={model} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '4px 0', flexWrap: 'wrap' }}>
              <h3 style={{
                fontFamily: 'var(--font-sans)',
                fontSize: 'var(--fs-15)',
                fontWeight: 600,
                color: 'var(--c-ink)',
                margin: 0,
              }}>
                {model} <span style={{ color: 'var(--fg-muted)', fontWeight: 400 }}>({rules.length} combo{rules.length !== 1 ? 's' : ''})</span>
              </h3>
              {isSalesSide && (
                <AnchorControl
                  anchoredSupplierId={anchorByModel[model] ?? null}
                  suppliers={suppliersQ.data ?? []}
                  busy={setAnchorM.isPending}
                  onChange={(supplierId) => setAnchorM.mutate({ baseModel: model, supplierId })}
                />
              )}
            </div>
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))',
              gap: 12,
            }}>
              {rules.map((r) => (
                <ComboCard
                  key={r.id}
                  rule={r}
                  heights={heights}
                  supplierCode={supplierCodeByBaseModel[r.baseModel]}
                  selected={selectedIds.has(r.id)}
                  onToggleSelect={() => toggleSelected(r.id)}
                  onEdit={() => setComposer({ open: true, editing: r })}
                  onHistory={() => setHistoryFor(r)}
                  onDelete={async () => {
                    if (await askConfirm({
                      title: 'Soft-delete this combo?',
                      body: '(History will still show it.)',
                      confirmLabel: 'Soft-delete',
                      danger: true,
                    })) {
                      deleteM.mutate(r.id);
                    }
                  }}
                />
              ))}
            </div>
          </section>
        ))
      )}

      {composer.open && (
        <ComposerModal
          editing={composer.editing}
          modulesByBaseModel={modulesByBaseModel}
          supplierCodeByBaseModel={supplierCodeByBaseModel}
          supplierId={supplierId}
          heights={heights}
          onClose={() => setComposer({ open: false })}
        />
      )}

      {historyFor && (
        <HistoryModal rule={historyFor} supplierId={supplierId} heights={heights} onClose={() => setHistoryFor(null)} />
      )}

      {batchOpen && (
        <BatchEditModal
          rules={(combosQ.data ?? []).filter((r) => selectedIds.has(r.id))}
          supplierId={supplierId}
          heights={heights}
          onClose={() => setBatchOpen(false)}
          onDone={() => {
            setSelectedIds(new Set());
            setBatchOpen(false);
          }}
          // Per-row "Edit composition…" jump from inside the batch grid
          // (commander 2026-06-20: "Compartment edit 不到的"). Closes the batch
          // modal and opens the single-combo Composer for that row — the ONLY
          // place modules/compartments may change (append-only identity stays
          // intact; selection is preserved so batch can be re-opened after).
          onEditComposition={(r) => {
            setBatchOpen(false);
            setComposer({ open: true, editing: r });
          }}
        />
      )}
    </div>
  );
};

// ─── Anchor control (R8) ──────────────────────────────────────────────
// Per-base_model「⇄ Anchor」picker shown on the SALES-side combo view only.
// Anchoring a model to a supplier makes the server mirror every combo
// create + price edit between this master combo and that supplier's scope, so
// the Product-Maintenance cost stays in lock-step with the supplier's cost.
// Picking a supplier sets the anchor; the ✕ clears it (un-anchor).

function AnchorControl({
  anchoredSupplierId, suppliers, busy, onChange,
}: {
  anchoredSupplierId: string | null;
  suppliers: SupplierRow[];
  busy: boolean;
  onChange: (supplierId: string | null) => void;
}) {
  const anchored = anchoredSupplierId
    ? suppliers.find((s) => s.id === anchoredSupplierId)
    : null;
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span style={{
        fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-11)',
        fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5,
        color: 'var(--fg-muted)',
      }}>
        ⇄ Anchor
      </span>
      <select
        value={anchoredSupplierId ?? ''}
        disabled={busy}
        onChange={(e) => onChange(e.target.value || null)}
        title="Anchor this model's combos to one supplier — combo create + price edits mirror both ways."
        style={{ ...selectStyle, fontSize: 'var(--fs-12)', padding: '4px 8px' }}
      >
        <option value="">— none —</option>
        {/* Keep a stale/non-ACTIVE anchored supplier selectable so the value
            never renders blank if it dropped out of the ACTIVE list. */}
        {anchored == null && anchoredSupplierId && (
          <option value={anchoredSupplierId}>{anchoredSupplierId}</option>
        )}
        {sortByText(suppliers).map((s) => (
          <option key={s.id} value={s.id}>{s.name}</option>
        ))}
      </select>
      {anchoredSupplierId && (
        <span style={anchorChipStyle} title="Anchored supplier">
          {anchored?.name ?? anchoredSupplierId}
          <button
            type="button"
            onClick={() => onChange(null)}
            disabled={busy}
            title="Un-anchor"
            style={{
              ...iconBtnStyle, padding: 0, marginLeft: 4,
              color: 'var(--c-orange, #c47b2f)',
            }}
          >
            <X size={12} strokeWidth={2} />
          </button>
        </span>
      )}
    </div>
  );
}

// ─── Combo card ────────────────────────────────────────────────────────

function ComboCard({
  rule, heights, supplierCode, selected, onToggleSelect, onEdit, onHistory, onDelete,
}: {
  rule: SofaComboRule;
  heights: string[];
  /** Supplier's own model code for this base model (e.g. "5539"), shown next
      to our internal name on the supplier-scoped page. Undefined elsewhere. */
  supplierCode?: string;
  /** Batch-edit selection state for this card. */
  selected: boolean;
  onToggleSelect: () => void;
  onEdit: () => void;
  onHistory: () => void;
  onDelete: () => void;
}) {
  const label = rule.label || buildComboLabel(rule.modules);
  const isActive = rule.effectiveFrom <= todayIso();
  // Whole card is the select target (job-card behaviour, commander T8). The
  // inner action buttons stopPropagation so Edit / History / Delete don't also
  // toggle selection. The CheckSquare/Square icon stays as an affordance.
  return (
    <div
      onClick={onToggleSelect}
      title={selected ? 'Click to deselect for batch edit' : 'Click to select for batch edit'}
      style={{
        background: selected ? 'var(--c-cream)' : 'var(--c-paper)',
        border: selected
          ? '2px solid var(--c-orange, #c47b2f)'
          : '1px solid var(--line)',
        // Keep the box the same size selected vs not — compensate the extra 1px
        // of border with 1px less padding so cards don't jump in the grid.
        borderRadius: 'var(--radius-md)',
        padding: selected ? 11 : 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        cursor: 'pointer',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <span
          aria-hidden
          title={selected ? 'Selected for batch edit' : 'Not selected'}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 4,
            color: selected ? 'var(--c-orange, #c47b2f)' : 'var(--fg-muted)',
          }}
        >
          {selected ? <CheckSquare size={16} strokeWidth={1.75} /> : <Square size={16} strokeWidth={1.75} />}
        </span>
        <span style={chipStyleStrong}>{rule.baseModel}</span>
        {supplierCode && (
          <span style={chipStyleSupplierCode} title="Supplier's own model code">
            {supplierCode}
          </span>
        )}
        <span style={{
          flex: 1,
          fontFamily: 'var(--font-sans)',
          fontSize: 'var(--fs-13)',
          fontWeight: 500,
          color: 'var(--c-ink)',
        }}>
          {label}
        </span>
        {/* Friendly tier label — the raw enum ("PRICE_1") read as a bug to the
            owner. Same vocabulary, human face. */}
        {rule.tier && (
          <span style={chipStyleSoft}>
            {rule.tier.replace(/^PRICE_(\d+)$/, 'Fabric Tier $1')}
          </span>
        )}
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          title="Soft-delete"
          style={iconBtnStyle}
        >
          <Trash2 size={14} strokeWidth={1.75} />
        </button>
      </div>

      {/* Height tiers — wrap into roomy cells instead of cramming every size
          into one tight row (Commander 2026-06-15: "字那么小怎么看"). Cells now
          auto-fill at a comfortable min-width and the size + price font is bumped. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(68px, 1fr))', gap: 6 }}>
        {sortByNumeric(heights).map((h) => {
          /* Owner 2026-07-24 ("爆掉了"): the master card used to read ONLY the
             COST map (prices_by_height), which the backend explicitly allows
             to be all-null — so combos whose prices live in the SELLING map
             rendered an all-dash grid. Master view now shows selling first,
             cost as fallback; a supplier-scoped row (supplierId set) is the
             purchasing/PO-benchmark card and keeps showing cost. */
          const v = rule.supplierId
            ? rule.pricesByHeight?.[h]
            : (rule.sellingPricesByHeight?.[h] ?? rule.pricesByHeight?.[h]);
          return (
            <div key={h} style={{
              padding: '6px 8px',
              background: 'var(--c-cream)',
              borderRadius: 'var(--radius-sm)',
              textAlign: 'center',
            }}>
              <div style={{ fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
                {h}
              </div>
              <div style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--fs-14)',
                fontWeight: 600,
                color: v == null ? 'var(--fg-muted)' : 'var(--c-ink)',
              }}>
                {fmtRm(v ?? null)}
              </div>
            </div>
          );
        })}
      </div>

      {/* Footer */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-12)', color: 'var(--fg-soft)' }}>
          Effective {fmtDate(rule.effectiveFrom)}
        </span>
        <span style={isActive ? statusPillActive : statusPillPending}>
          {isActive ? 'Active' : 'Pending'}
        </span>
        <div style={{ flex: 1 }} />
        {/* Composition editing is Composer-only (never batch) — this opens the
            single-combo Composer where modules/slots can change. */}
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onEdit(); }}
          title="Edit composition + price (opens the Composer)"
          style={ghostBtnStyle}
        >
          <Pencil size={12} strokeWidth={1.75} /> Edit composition…
        </button>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onHistory(); }}
          style={ghostBtnStyle}
        >
          <History size={12} strokeWidth={1.75} /> History
        </button>
      </div>
    </div>
  );
}

// ─── Composer modal (New / Edit) ──────────────────────────────────────

function ComposerModal({
  editing, modulesByBaseModel, supplierCodeByBaseModel, supplierId, heights, onClose,
}: {
  editing?: SofaComboRule;
  heights: string[];
  modulesByBaseModel: Record<string, string[]>;
  /** base_model → supplier's own model code (supplier-scoped page only). */
  supplierCodeByBaseModel: Record<string, string>;
  supplierId?: string;
  onClose: () => void;
}) {
  const notify = useNotify();
  const create = useCreateSofaCombo();
  const update = useUpdateSofaCombo();

  const [baseModel, setBaseModel] = useState(editing?.baseModel ?? '');

  // Slot picker chips follow the SELECTED base model's actual SKU
  // compartments (HOOKKA parity — combo options = that model's own size codes,
  // not a global list). Falls back to the global ALL_MODULE_CODES only when
  // the base model is unknown / has no SKUs, so the dialog never renders an
  // empty chip set. Recomputes whenever the operator changes BASE MODEL.
  const slotCodes = useMemo(() => {
    const own = modulesByBaseModel[baseModel];
    return own && own.length > 0 ? own : ALL_MODULE_CODES;
  }, [modulesByBaseModel, baseModel]);
  // Base-model options (New AND Edit). Sourced from the SAME map that drives
  // the Module-slot chip filter (`modulesByBaseModel`) so every selectable
  // model reliably re-renders chips on pick — and a chosen value can never be
  // a free-typed string the chip filter wouldn't recognise (the old
  // <input list> footgun the commander hit: "选了 model 就不能 drop 掉了吗").
  // The leading blank option lets the operator clear / re-pick. When editing a
  // combo whose base model no longer has SKUs in master, keep it selectable so
  // the prefilled value doesn't render as a phantom blank.
  const baseModelOptions = useMemo(() => {
    const set = new Set(Object.keys(modulesByBaseModel));
    if (editing?.baseModel) set.add(editing.baseModel);
    return [...set].sort();
  }, [modulesByBaseModel, editing?.baseModel]);
  // OR-set per slot (PR combo-or-per-slot): ordered slots, each a SET of
  // alternative codes joined by OR. e.g. [['2A(LHF)','2A(RHF)'],['L(LHF)','L(RHF)']].
  // Deep-copied when editing so chip toggles never mutate the cached rule.
  const [modules, setModules] = useState<string[][]>(
    () => (editing?.modules ?? []).map((slot) => [...slot]),
  );
  const [tier, setTier] = useState<SofaPriceTier | ''>(editing?.tier ?? 'PRICE_2');
  const [label, setLabel] = useState(editing?.label ?? '');
  const [effectiveFrom, setEffectiveFrom] = useState(editing?.effectiveFrom ?? todayIso());
  const [prices, setPrices] = useState<Record<string, string>>(() => {
    const seed: Record<string, string> = {};
    for (const h of heights) {
      const v = editing?.pricesByHeight?.[h];
      seed[h] = v == null ? '' : (v / 100).toFixed(2);
    }
    return seed;
  });
  const [notes, setNotes] = useState(editing?.notes ?? '');

  // Composition identity — order-independent canonical key (matching is
  // order-independent; codes within a slot are an OR-set). Used only to tell
  // the operator when an edit re-points to a DIFFERENT logical combo: same
  // key → PUT (new effective row on the same rule, PWP carried forward);
  // different key / base model → POST (a brand-new rule; old one stays in
  // history untouched).
  const compositionChanged = useMemo(() => {
    if (!editing) return false;
    const key = (slots: string[][]): string =>
      JSON.stringify(
        slots
          .map((slot) => [...new Set(slot.map((c) => c.trim()).filter(Boolean))].sort())
          .filter((slot) => slot.length > 0)
          .sort((a, b) => a.join('|').localeCompare(b.join('|'))),
      );
    return baseModel !== editing.baseModel || key(modules) !== key(editing.modules);
  }, [editing, baseModel, modules]);

  // Ordered positional slots (Hookka-style), each an OR-set of codes. A slot
  // toggles codes on/off — the built sofa matches if each module fills a
  // DISTINCT slot whose set contains it (set-cover, exact count). The same
  // code may appear in multiple slots (a combo can have 2× the same piece).
  // Order = position = array index; matching is order-independent. Empty slots
  // are filtered out on save.
  const toggleSlotCode = (idx: number, code: string) => {
    setModules((cur) =>
      cur.map((slot, i) =>
        i === idx
          ? (slot.includes(code) ? slot.filter((c) => c !== code) : [...slot, code])
          : slot,
      ),
    );
  };
  const addSlot = () => setModules((cur) => [...cur, []]);
  const removeSlot = (idx: number) => {
    setModules((cur) => cur.filter((_, i) => i !== idx));
  };

  const submit = async () => {
    if (!baseModel) { notify({ title: 'Base model is required.', tone: 'error' }); return; }
    // Drop empty slots + de-dupe codes within each slot.
    const orderedModules = modules
      .map((slot) => [...new Set(slot.map((c) => c.trim()).filter(Boolean))])
      .filter((slot) => slot.length > 0);
    if (orderedModules.length === 0) { notify({ title: 'Add at least one module slot.', tone: 'error' }); return; }

    const pricesByHeight: Record<string, number | null> = {};
    for (const h of heights) {
      const raw = (prices[h] ?? '').trim();
      if (!raw) pricesByHeight[h] = null;
      else {
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0) { notify({ title: `Bad price at ${h}".`, tone: 'error' }); return; }
        pricesByHeight[h] = Math.round(n * 100);
      }
    }

    // Label auto-derives from modules when blank. If the field still holds the
    // OLD composition's auto label and the modules changed, drop it so the new
    // row re-derives — a label the user actually typed is kept as-is.
    const trimmedLabel = label.trim();
    const finalLabel =
      !trimmedLabel
      || (editing && compositionChanged && trimmedLabel === buildComboLabel(editing.modules))
        ? null
        : trimmedLabel;

    try {
      if (editing && !compositionChanged) {
        // Same composition → PUT keeps the original tuple (and carries the
        // POS-side PWP prices forward on the new effective row).
        await update.mutateAsync({
          id: editing.id,
          pricesByHeight,
          label: finalLabel,
          effectiveFrom,
          notes: notes || null,
        });
      } else if (editing) {
        // Composition changed → append a brand-new rule for the edited
        // module set / base model. The old rule's rows stay in history.
        await create.mutateAsync({
          baseModel,
          modules: orderedModules,
          tier: editing.tier,           // tier is locked in edit mode
          customerId: editing.customerId,
          supplierId: supplierId ?? editing.supplierId ?? null,
          pricesByHeight,
          label: finalLabel,
          effectiveFrom,
          notes: notes || null,
        });
      } else {
        await create.mutateAsync({
          baseModel,
          modules: orderedModules,
          tier: tier || null,
          customerId: null,  // B2C: always null = applies to all customers
          supplierId: supplierId ?? null,  // supplier scope when set, else sales-side
          pricesByHeight,
          label: finalLabel,
          effectiveFrom,
          notes: notes || null,
        });
      }
      onClose();
    } catch (e) {
      /* String(e) printed "Error: <msg>" — the only surface in the tree that
         kept the constructor-name prefix. authedFetch already humanized the
         message itself. */
      notify({ title: "Couldn't save this combo", body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
    }
  };

  return (
    <ModalShell title={editing ? 'Edit combo' : 'New combo'} onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Field label="Base model">
          {/* Editable in BOTH modes (commander 2026-06-12: edit must allow
              changing the composition). Picking a different model reloads the
              compartment chip pool via `slotCodes`. */}
          <select
            value={baseModel}
            onChange={(e) => setBaseModel(e.target.value)}
            style={selectStyle}
          >
            <option value="">— Select base model —</option>
            {sortByText(baseModelOptions).map((m) => (
              <option key={m} value={m}>
                {supplierCodeByBaseModel[m] ? `${m} · ${supplierCodeByBaseModel[m]}` : m}
              </option>
            ))}
          </select>
        </Field>

        <Field label={`Modules (${modules.filter((s) => s.some((c) => c.trim())).length} slot${modules.length === 1 ? '' : 's'})`}>
          {/* SAME slot picker for New and Edit (commander 2026-06-12). Edit
              prefills from the combo's stored slots; add/remove/re-tick away. */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{
              fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-11)',
              color: 'var(--fg-muted)', padding: '2px 0',
            }}>
              Each slot is an OR-set — tick every module that may fill it
              (e.g. <strong>1A(LHF)</strong> OR <strong>1A(RHF)</strong>). A built
              sofa matches when each piece fills a distinct slot and the piece
              count equals the slot count.
            </div>
            {modules.length === 0 ? (
              <div style={{
                fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-12)',
                color: 'var(--fg-muted)', padding: '2px 0',
              }}>
                No slots yet — add the first one.
              </div>
            ) : (
              modules.map((slot, idx) => (
                <div key={idx} style={{
                  display: 'flex', flexDirection: 'column', gap: 4,
                  padding: 8, border: '1px solid var(--line)',
                  borderRadius: 'var(--radius-sm)', background: 'var(--c-cream)',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={slotNumberStyle}>Module {idx + 1}</span>
                    <span style={{
                      flex: 1, fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-12)',
                      color: slot.length ? 'var(--c-ink)' : 'var(--fg-muted)',
                    }}>
                      {slot.length ? slot.join(' / ') : 'pick one or more (OR)'}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeSlot(idx)}
                      title={`Remove Module ${idx + 1}`}
                      style={iconBtnStyle}
                    >
                      <X size={14} strokeWidth={1.75} />
                    </button>
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {slotCodes.map((c) => {
                      const on = slot.includes(c);
                      return (
                        <button
                          type="button"
                          key={c}
                          onClick={() => toggleSlotCode(idx, c)}
                          style={on ? moduleChipOn : moduleChipOff}
                        >
                          {c}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))
            )}
            <div>
              <Button variant="ghost" onClick={addSlot}>
                <Plus {...ICON_PROPS} style={{ marginRight: 6 }} /> Add Module
              </Button>
            </div>
            {compositionChanged && (
              <div style={{
                fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-12)',
                color: 'var(--c-red, #c0392b)', padding: '2px 0',
              }}>
                Modules no longer match the original combo — saving creates a new
                rule for this module set; the old rule stays in history.
              </div>
            )}
          </div>
        </Field>

        <Field label="Tier">
          <select
            value={tier}
            onChange={(e) => setTier(e.target.value as SofaPriceTier | '')}
            style={selectStyle}
            disabled={!!editing}
          >
            <option value="">— Any —</option>
            {TIERS.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </Field>

        <Field label="Cost by seat height (RM) — selling price is set by Master Admin on POS">
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${heights.length}, 1fr)`, gap: 8 }}>
            {sortByNumeric(heights).map((h) => (
              <div key={h}>
                <div style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-muted)', textAlign: 'center' }}>{h}{/^\d/.test(h) ? '"' : ''}</div>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={prices[h] ?? ''}
                  onChange={(e) => setPrices((cur) => ({ ...cur, [h]: e.target.value }))}
                  placeholder="—"
                  style={{ ...inputStyle, textAlign: 'right', fontFamily: 'var(--font-mono)' }}
                />
              </div>
            ))}
          </div>
        </Field>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 12 }}>
          <Field label="Effective from">
            <DateField value={effectiveFrom} onChange={(iso) => setEffectiveFrom(iso)} style={inputStyle}/>
          </Field>
          <Field label="Label (optional)">
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="(auto: from modules)"
              style={inputStyle}
            />
          </Field>
        </div>

        <Field label="Notes (optional)">
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            style={{ ...inputStyle, resize: 'vertical' }}
          />
        </Field>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={create.isPending || update.isPending}>
            {(create.isPending || update.isPending) ? 'Saving…' : (editing ? 'Save new effective row' : 'Create combo')}
          </Button>
        </div>
      </div>
    </ModalShell>
  );
}

// ─── Batch price edit modal (#39) ─────────────────────────────────────
// Multi-select combos → POST one fresher-effective row per selected combo with
// adjusted prices. APPEND-ONLY: each combo's scope (baseModel/modules/tier/
// customerId/supplierId) + label + notes are preserved; only the height prices
// change. Composition is NEVER touched here (changing modules = a different
// logical combo → that's the Composer's job, not batch). Never PUT/overwrite.
//   · percent: round(old * (1 + pct/100)) for each non-null height
//   · set:     setSen for each EXISTING (key present) height; null stays null
//   · grid:    per-combo × per-height inputs — each combo's map is rebuilt from
//              its own grid row (job-card style edit, commander T8).
// Mirrors HOOKKA's batch price tool.

type BatchMode = 'percent' | 'set' | 'grid';

/** Compute the adjusted pricesByHeight for one combo. Keys are unchanged; only
 *  non-null values are touched. Returns integer-centi values. */
function adjustPrices(
  pricesByHeight: Record<string, number | null>,
  mode: BatchMode,
  pct: number,
  setSen: number,
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const [h, v] of Object.entries(pricesByHeight)) {
    if (v == null) { out[h] = null; continue; }
    out[h] = mode === 'percent'
      ? Math.round(v * (1 + pct / 100))
      : setSen;
  }
  return out;
}

function BatchEditModal({
  rules, supplierId, heights, onClose, onDone, onEditComposition,
}: {
  rules: SofaComboRule[];
  supplierId?: string;
  heights: string[];
  onClose: () => void;
  onDone: () => void;
  /** Jump to the single-combo Composer for one row (composition editing is
      never done in batch — append-only identity). Closes batch + opens it. */
  onEditComposition: (rule: SofaComboRule) => void;
}) {
  const notify = useNotify();
  const create = useCreateSofaCombo();

  const [effectiveFrom, setEffectiveFrom] = useState(todayIso());
  const [mode, setMode] = useState<BatchMode>('percent');
  const [pctStr, setPctStr] = useState('0');
  const [setRmStr, setSetRmStr] = useState('');
  const [applying, setApplying] = useState(false);

  // Per-combo × per-height grid (mode === 'grid'). Seeded from each combo's
  // current pricesByHeight as RM strings ('' = leave that height null). Keyed
  // by combo id then height. Empty inputs persist as null — same convention as
  // the single-combo Composer.
  const [grid, setGrid] = useState<Record<string, Record<string, string>>>(() => {
    const seed: Record<string, Record<string, string>> = {};
    for (const r of rules) {
      const row: Record<string, string> = {};
      for (const h of heights) {
        const v = r.pricesByHeight?.[h];
        row[h] = v == null ? '' : (v / 100).toFixed(2);
      }
      seed[r.id] = row;
    }
    return seed;
  });
  const setGridCell = (id: string, h: string, value: string) => {
    setGrid((cur) => ({ ...cur, [id]: { ...(cur[id] ?? {}), [h]: value } }));
  };

  const pct = Number(pctStr);
  const setRm = Number(setRmStr);
  const setSen = Math.round((Number.isFinite(setRm) ? setRm : 0) * 100);
  // Build one combo's pricesByHeight from its grid row: parse each cell to
  // centi, blank → null. Returns null when any cell is a non-empty bad number
  // so apply can reject before POSTing.
  const gridMapFor = (r: SofaComboRule): Record<string, number | null> | null => {
    const row = grid[r.id] ?? {};
    const out: Record<string, number | null> = {};
    // Carry any legacy height keys the heights list doesn't cover, untouched.
    for (const [h, v] of Object.entries(r.pricesByHeight ?? {})) {
      if (!heights.includes(h)) out[h] = v;
    }
    for (const h of heights) {
      const raw = (row[h] ?? '').trim();
      if (!raw) { out[h] = null; continue; }
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) return null;
      out[h] = Math.round(n * 100);
    }
    return out;
  };
  const gridValid =
    mode !== 'grid' || rules.every((r) => gridMapFor(r) !== null);
  const inputsValid =
    mode === 'percent'
      ? Number.isFinite(pct)
      : mode === 'set'
        ? Number.isFinite(setRm) && setRm >= 0 && setRmStr.trim() !== ''
        : gridValid;

  // The first representative non-null height for a combo (preview anchor).
  const firstPricedHeight = (r: SofaComboRule): string | null => {
    for (const h of heights) {
      if (r.pricesByHeight?.[h] != null) return h;
    }
    // Fall back to any key (heights list may not cover legacy keys).
    for (const [h, v] of Object.entries(r.pricesByHeight ?? {})) {
      if (v != null) return h;
    }
    return null;
  };

  const apply = async () => {
    if (!inputsValid || applying) return;
    setApplying(true);
    let ok = 0;
    let fail = 0;
    for (const r of rules) {
      // Build this combo's new price map. APPEND-ONLY: identity (baseModel /
      // modules / tier / customerId / supplierId) is carried forward verbatim;
      // ONLY pricesByHeight + effectiveFrom change. Composition is never
      // mutated in batch.
      const pricesByHeight =
        mode === 'grid'
          ? gridMapFor(r)
          : adjustPrices(r.pricesByHeight ?? {}, mode, pct, setSen);
      if (pricesByHeight == null) { fail += 1; continue; } // bad grid cell
      const newCombo: NewSofaCombo = {
        baseModel: r.baseModel,
        modules: r.modules,
        tier: r.tier,
        customerId: r.customerId,
        supplierId: supplierId ?? r.supplierId ?? null,
        label: r.label,
        notes: r.notes,
        effectiveFrom,
        pricesByHeight,
      };
      try {
        await create.mutateAsync(newCombo);
        ok += 1;
      } catch {
        fail += 1;
      }
    }
    setApplying(false);
    await notify({ title: `Updated ${ok} combo${ok === 1 ? '' : 's'} (${fail} failed)` });
    onDone();
  };

  return (
    <ModalShell title={`Batch price edit (${rules.length})`} onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <p style={{
          fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-12)',
          color: 'var(--fg-soft)', margin: 0,
        }}>
          Appends a new effective-dated row for each selected combo with the new
          prices. Existing rows stay in history; composition, scope, label, and
          notes are preserved — only the seat-height prices change. To change a
          combo's modules, use <strong>Edit composition…</strong> on the card.
        </p>

        <Field label="Effective from">
          <DateField value={effectiveFrom} onChange={setEffectiveFrom} fullWidth />
        </Field>

        <Field label="Adjustment">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="radio"
                name="batch-mode"
                checked={mode === 'percent'}
                onChange={() => setMode('percent')}
              />
              <span style={{ fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-13)', color: 'var(--c-ink)' }}>
                Adjust by %
              </span>
              <input
                type="number"
                step="0.1"
                value={pctStr}
                onChange={(e) => setPctStr(e.target.value)}
                disabled={mode !== 'percent'}
                style={{ ...inputStyle, width: 100, textAlign: 'right', fontFamily: 'var(--font-mono)' }}
              />
              <span style={{ fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-13)', color: 'var(--fg-soft)' }}>%</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="radio"
                name="batch-mode"
                checked={mode === 'set'}
                onChange={() => setMode('set')}
              />
              <span style={{ fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-13)', color: 'var(--c-ink)' }}>
                Set all heights to RM
              </span>
              <input
                type="number"
                step="0.01"
                min="0"
                value={setRmStr}
                onChange={(e) => setSetRmStr(e.target.value)}
                disabled={mode !== 'set'}
                placeholder="0.00"
                style={{ ...inputStyle, width: 120, textAlign: 'right', fontFamily: 'var(--font-mono)' }}
              />
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="radio"
                name="batch-mode"
                checked={mode === 'grid'}
                onChange={() => setMode('grid')}
              />
              <span style={{ fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-13)', color: 'var(--c-ink)' }}>
                Edit each height individually (grid)
              </span>
            </label>
          </div>
        </Field>

        {mode === 'grid' ? (
          <Field label="Per-combo prices by seat height (RM) — blank leaves that height empty">
            {/* Per-combo × per-height grid (job-card edit). Reuses the
                Composer's height-input markup; each combo's map is rebuilt from
                its own row on apply. Composition is shown read-only — it is NOT
                editable here (append-only identity stays intact). */}
            <div style={{ overflowX: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 360 }}>
                <thead>
                  <tr>
                    <th style={gridHeadCellStickyStyle}>Combo</th>
                    {sortByNumeric(heights).map((h) => (
                      <th key={h} style={gridHeadCellStyle}>
                        {h}{/^\d/.test(h) ? '"' : ''}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rules.map((r) => (
                    <tr key={r.id}>
                      <td style={gridLabelCellStyle}>
                        <div style={{ fontWeight: 600, color: 'var(--c-ink)' }}>{r.baseModel}</div>
                        {/* Full composition — wraps instead of truncating so the
                            compartment makeup is always readable (commander
                            2026-06-20: "被遮着了"). */}
                        <div style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-soft)', lineHeight: 1.35 }}>
                          {r.label || buildComboLabel(r.modules)}
                          {r.tier ? ` · ${r.tier}` : ''}
                        </div>
                        {/* Compartment editing lives in the Composer (append-only
                            identity). This jumps straight there for THIS combo. */}
                        <button
                          type="button"
                          onClick={() => onEditComposition(r)}
                          title="Change this combo's compartments (opens the Composer)"
                          style={{
                            ...ghostBtnStyle, marginTop: 4, padding: '2px 6px',
                            fontSize: 'var(--fs-11)',
                          }}
                        >
                          <Pencil size={11} strokeWidth={1.75} /> Edit composition…
                        </button>
                      </td>
                      {sortByNumeric(heights).map((h) => (
                        <td key={h} style={gridInputCellStyle}>
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            value={grid[r.id]?.[h] ?? ''}
                            onChange={(e) => setGridCell(r.id, h, e.target.value)}
                            placeholder="—"
                            style={{ ...inputStyle, textAlign: 'right', fontFamily: 'var(--font-mono)', padding: '4px 6px' }}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Field>
        ) : (
        <Field label="Preview">
          <div style={{
            display: 'flex', flexDirection: 'column', gap: 6,
            padding: 8, background: 'var(--c-cream)',
            borderRadius: 'var(--radius-sm)', border: '1px solid var(--line)',
          }}>
            {rules.slice(0, 3).map((r) => {
              const h = firstPricedHeight(r);
              const oldV = h ? (r.pricesByHeight?.[h] ?? null) : null;
              const newV = h
                ? adjustPrices(r.pricesByHeight ?? {}, mode, pct, setSen)[h] ?? null
                : null;
              return (
                <div key={r.id} style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-12)', color: 'var(--c-ink)',
                }}>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.label || r.baseModel}{h ? ` · ${h}` : ''}
                  </span>
                  <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg-soft)' }}>{fmtRm(oldV)}</span>
                  <span style={{ color: 'var(--fg-muted)' }}>→</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{fmtRm(newV)}</span>
                </div>
              );
            })}
            {rules.length > 3 && (
              <div style={{ fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>
                …and {rules.length - 3} more
              </div>
            )}
          </div>
        </Field>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={apply} disabled={!inputsValid || applying}>
            {applying ? 'Applying…' : `Apply (${rules.length})`}
          </Button>
        </div>
      </div>
    </ModalShell>
  );
}

// ─── History modal ────────────────────────────────────────────────────

function HistoryModal({ rule, supplierId, heights, onClose }: { rule: SofaComboRule; supplierId?: string; heights: string[]; onClose: () => void }) {
  const historyQ = useSofaComboHistory({
    baseModel: rule.baseModel,
    modules: rule.modules,
    tier: rule.tier,
    customerId: rule.customerId,
    supplierId: supplierId ?? rule.supplierId,
  });

  return (
    <ModalShell title="Combo history" onClose={onClose}>
      {/* Reusable effective-dated history (A4): newest-first rows each tagged
          Active / Pending·Nd / Past + the append-only reassurance banner. The
          per-row body (prices + notes) is supplied below; the component owns the
          timeline math, badges, banner and empty/loading states. Soft-deleted
          rows still appear, tagged Deleted (deletedAt). */}
      <EffectiveDatedHistory<SofaComboRule>
        rows={historyQ.data ?? []}
        loading={historyQ.isLoading}
        rowKey={(r) => r.id}
        effectiveFrom={(r) => r.effectiveFrom}
        isDeleted={(r) => !!r.deletedAt}
        emptyLabel="No history rows."
        header={
          <>
            {rule.baseModel} · {buildComboLabel(rule.modules)}{rule.tier ? ` · ${rule.tier}` : ''}
          </>
        }
        renderRow={(r) => (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: `repeat(${heights.length}, 1fr)`, gap: 4, marginTop: 6 }}>
              {sortByNumeric(heights).map((h) => (
                <div key={h} style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>{h}</div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-12)' }}>
                    {fmtRm(r.pricesByHeight?.[h] ?? null)}
                  </div>
                </div>
              ))}
            </div>
            {r.notes && (
              <div style={{ marginTop: 6, fontSize: 'var(--fs-12)', color: 'var(--fg-soft)' }}>
                {r.notes}
              </div>
            )}
          </>
        )}
      />
    </ModalShell>
  );
}

// ─── Small primitives ─────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{
        fontFamily: 'var(--font-sans)',
        fontSize: 'var(--fs-11)',
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: 1,
        color: 'var(--fg-soft)',
      }}>
        {label}
      </span>
      {children}
    </label>
  );
}

function ModalShell({
  title, onClose, children,
}: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
      padding: '5vh 16px', zIndex: 1000, overflowY: 'auto',
    }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: 'var(--c-paper)', borderRadius: 'var(--radius-md)',
        padding: 20, width: '100%', maxWidth: 720,
        display: 'flex', flexDirection: 'column', gap: 16,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: 'var(--fs-18)' }}>
            {title}
          </h3>
          <button type="button" onClick={onClose} style={iconBtnStyle}>
            <X size={16} strokeWidth={1.75} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

const selectStyle: CSSProperties = {
  fontFamily: 'var(--font-sans)',
  fontSize: 'var(--fs-13)',
  background: 'var(--c-cream)',
  border: '1px solid var(--line-strong)',
  borderRadius: 'var(--radius-sm)',
  padding: '6px 10px',
  outline: 'none',
};

const inputStyle: CSSProperties = {
  fontFamily: 'var(--font-sans)',
  fontSize: 'var(--fs-13)',
  background: 'var(--c-cream)',
  border: '1px solid var(--line-strong)',
  borderRadius: 'var(--radius-sm)',
  padding: '6px 8px',
  outline: 'none',
  width: '100%',
};

const chipStyleStrong: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-12)',
  fontWeight: 600,
  background: 'var(--c-cream)',
  color: 'var(--c-ink)',
  padding: '2px 8px',
  borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--line-strong)',
};

// Supplier's own model code chip — tinted so it reads as a distinct, second
// identity next to our internal base-model chip ("Booqit · 5539").
const chipStyleSupplierCode: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-12)',
  fontWeight: 600,
  background: 'var(--c-paper)',
  color: 'var(--c-orange, #c47b2f)',
  padding: '2px 8px',
  borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--c-orange, #c47b2f)',
};

const chipStyleSoft: CSSProperties = {
  fontFamily: 'var(--font-sans)',
  fontSize: 'var(--fs-11)',
  background: 'var(--c-cream)',
  color: 'var(--fg-soft)',
  padding: '2px 6px',
  borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--line)',
};

// Anchored-supplier chip (R8) — reuses the orange supplier-identity tint so it
// reads as "this model is bound to a supplier", with an inline ✕ to clear.
const anchorChipStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  fontFamily: 'var(--font-sans)',
  fontSize: 'var(--fs-11)',
  fontWeight: 600,
  background: 'var(--c-paper)',
  color: 'var(--c-orange, #c47b2f)',
  padding: '2px 6px',
  borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--c-orange, #c47b2f)',
};

const statusPillActive: CSSProperties = {
  fontFamily: 'var(--font-sans)',
  fontSize: 'var(--fs-11)',
  fontWeight: 600,
  background: 'var(--c-mint, #d4edda)',
  color: 'var(--c-green, #1a7a3a)',
  padding: '2px 8px',
  borderRadius: 'var(--radius-pill, 999px)',
};

const statusPillPending: CSSProperties = {
  ...statusPillActive,
  background: 'var(--c-paper)',
  color: 'var(--fg-soft)',
  border: '1px solid var(--line)',
};

const iconBtnStyle: CSSProperties = {
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  color: 'var(--fg-soft)',
  padding: 4,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 'var(--radius-sm)',
};

const ghostBtnStyle: CSSProperties = {
  background: 'transparent',
  border: '1px solid var(--line)',
  borderRadius: 'var(--radius-sm)',
  padding: '4px 8px',
  fontFamily: 'var(--font-sans)',
  fontSize: 'var(--fs-12)',
  color: 'var(--fg-soft)',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
};

const slotNumberStyle: CSSProperties = {
  fontFamily: 'var(--font-sans)',
  fontSize: 'var(--fs-11)',
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  color: 'var(--fg-soft)',
  minWidth: 72,
  flexShrink: 0,
};

const moduleChipOn: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
  fontWeight: 600,
  background: 'var(--c-orange, #c47b2f)',
  color: 'var(--c-paper, #fff)',
  border: '1px solid var(--c-orange, #c47b2f)',
  borderRadius: 'var(--radius-sm)',
  padding: '2px 8px',
  cursor: 'pointer',
};

const moduleChipOff: CSSProperties = {
  ...moduleChipOn,
  background: 'var(--c-paper)',
  color: 'var(--c-ink)',
  border: '1px solid var(--line-strong)',
};

// Batch per-height grid (mode === 'grid') ─────────────────────────────
const gridHeadCellStyle: CSSProperties = {
  // Batch 3 theme skin — the SO-sample DataTable header spec (sans 10px/700,
  // tracking-brand, surface-dim fill, ink) on the combo grid's head row.
  fontFamily: 'var(--font-sans)',
  fontSize: 10,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.18em',
  color: 'var(--c-ink, #11140f)',
  background: '#e3e6e0',
  borderBottom: '2px solid #d6d9d2',
  textAlign: 'center',
  padding: '4px 6px',
  whiteSpace: 'nowrap',
};

const gridHeadCellStickyStyle: CSSProperties = {
  ...gridHeadCellStyle,
  textAlign: 'left',
  minWidth: 120,
};

const gridLabelCellStyle: CSSProperties = {
  fontFamily: 'var(--font-sans)',
  fontSize: 'var(--fs-12)',
  padding: '6px 10px 6px 0',
  verticalAlign: 'top',
  // Wrap the composition instead of clipping it (commander 2026-06-20). Cap the
  // width so the height columns still get room; the text flows onto 2–3 lines.
  whiteSpace: 'normal',
  maxWidth: 200,
  minWidth: 140,
};

const gridInputCellStyle: CSSProperties = {
  padding: '2px 3px',
  verticalAlign: 'middle',
};
