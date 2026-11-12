// Sofa Combo Pricing, on Products (the master combos) and on a supplier's page (that
// supplier's cost). Pick a model, pick a Price, and the combos sit in one table with
// a cell per size; saving writes a new dated row, so the old price stays in history.

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button } from '@2990s/design-system';
import { fmtDate, fmtSen, maintActiveValues, normalizeCompartmentCode, SOFA_MODULES, type SofaPriceTier } from '@2990s/shared';
import { DateField } from './DateField';
import { useNotify } from './NotifyDialog';
import {
  useApplyCombos,
  useSofaComboHistory,
  useSofaCombos,
} from '../lib/sofa-combos-queries';
import { useMfgProducts, useMaintenanceConfig } from '../lib/mfg-products-queries';
import { useProductModels } from '../lib/product-models-queries';
import { useSupplierDetail } from '../lib/suppliers-queries';
import { todayMyt } from '../lib/dates';
import {
  comboBook, costAt, editKey, hasPrice, heightLabel, historyLines, itemsFromEdits, listedModels, offeredSizes, PRICE_TIERS, sizesInUse, slotLabel, sortSizes, tierLabel,
  type ComboLine,
} from './combo/comboBook';
import { errText } from './combo/comboErrors';
import styles from './combo/ComboScreen.module.css';
import { AdjustDialog, AssignDialog, CompartmentDialog, DeleteDialog, ExportDialog, fieldStyle, ImportDialog, NewComboDialog } from './combo/ComboDialogs';

// Seat-height columns follow the Maintenance Sizes pool; this shows only if that
// config fails to load.
const HEIGHTS_FALLBACK = ['24', '26', '28', '30', '32', '35'];
const ALL_MODULE_CODES = SOFA_MODULES.map((m) => m.id).sort();
const GREEN = 'var(--c-primary, #0f6b5c)';
const plain = (sen: number): string => fmtSen(sen).replace(/^RM\s*/, '');

type ComboTabProps = {
  /** Set on a supplier's page: reads and writes that supplier's combos. */
  supplierId?: string;
};

type Dialog =
  | { kind: 'new' } | { kind: 'hand' } | { kind: 'edit'; line: ComboLine }
  | { kind: 'assign' } | { kind: 'delete' } | { kind: 'adjust' } | { kind: 'export' } | { kind: 'import' };

const card: CSSProperties = { background: 'var(--c-cream)', border: '1px solid var(--line)', borderRadius: 'var(--radius-md)' };
const soft: CSSProperties = { fontSize: 'var(--fs-12)', color: 'var(--fg-soft)' };

const tag = (warn: boolean): CSSProperties => ({
  display: 'inline-block', padding: '3px 9px', borderRadius: 999, fontSize: 'var(--fs-11)', fontWeight: 600,
  background: warn ? 'var(--c-warning-bg, #f6efd9)' : '#dcebe3', color: warn ? 'var(--c-warning, #6e4d12)' : GREEN,
});

export const SofaComboTab = ({ supplierId }: ComboTabProps) => {
  const notify = useNotify();
  const apply = useApplyCombos();
  const [params, setParams] = useSearchParams();
  const today = todayMyt();

  const combosQ = useSofaCombos({ customerId: null, supplierId });
  const masterQ = useSofaCombos({ customerId: null });
  const productsQ = useMfgProducts({ category: 'SOFA' });
  const heightsCfgQ = useMaintenanceConfig('master');
  const supplierDetailQ = useSupplierDetail(supplierId ?? null);
  const supplierName = supplierId ? (supplierDetailQ.data?.supplier.name ?? '') : null;

  const productModelsQ = useProductModels({ category: 'SOFA' });
  const heights = heightsCfgQ.data?.data?.sofaSizes ? maintActiveValues(heightsCfgQ.data.data.sofaSizes) : HEIGHTS_FALLBACK;

  const book = useMemo(() => comboBook(combosQ.data ?? []), [combosQ.data]);
  const sourceBook = useMemo(() => comboBook(masterQ.data ?? []), [masterQ.data]);
  const lineByKey = useMemo(() => new Map([...book.values()].flat().map((l) => [l.key, l])), [book]);

  // Each model's module codes, from its SKUs: the part after the first dash.
  const modulesByModel = useMemo(() => {
    const m: Record<string, string[]> = {};
    for (const p of productsQ.data ?? []) {
      const row = p as unknown as { base_model?: string | null; code?: string | null };
      const code = row.code ?? '';
      const dash = code.indexOf('-');
      if (!row.base_model || dash <= 0) continue;
      const compartment = normalizeCompartmentCode(code.slice(dash + 1));
      if (!compartment) continue;
      const list = (m[row.base_model] ??= []);
      if (!list.includes(compartment)) list.push(compartment);
    }
    return m;
  }, [productsQ.data]);

  // Each model's own sizes (Products > Modular), reached from its SKUs.
  const ownSizes = useMemo(() => {
    const byId = new Map((productModelsQ.data ?? []).map((m) => [m.id, m.allowed_options.sizes ?? []]));
    const out = new Map<string, string[]>();
    for (const p of productsQ.data ?? []) {
      const row = p as unknown as { base_model?: string | null; model_id?: string | null };
      const sizes = row.model_id ? byId.get(row.model_id) : undefined;
      if (row.base_model && sizes) out.set(row.base_model, sizes);
    }
    return out;
  }, [productModelsQ.data, productsQ.data]);
  const sizesOf = (m: string): string[] => offeredSizes(ownSizes.get(m), heights, sizesInUse(book.get(m) ?? []));

  // The supplier's own model code, from their bindings: "5539-2A(LHF)" gives 5539.
  const supplierCodes = useMemo(() => {
    const out: Record<string, Record<string, number>> = {};
    if (!supplierId) return out;
    const modelByCode = new Map<string, string>();
    for (const p of productsQ.data ?? []) {
      const row = p as unknown as { base_model?: string | null; code?: string | null };
      if (row.code && row.base_model) modelByCode.set(row.code, row.base_model);
    }
    for (const b of supplierDetailQ.data?.bindings ?? []) {
      const model = modelByCode.get(b.item_code);
      // "5539-2A(LHF)" gives 5539, "DSL-8030-2A" gives DSL-8030: only the module comes off.
      const code = (b.supplier_sku ?? '').trim().replace(/-[^-]*$/, '').trim();
      if (!model || !code) continue;
      const counts = (out[model] ??= {});
      counts[code] = (counts[code] ?? 0) + 1;
    }
    return out;
  }, [supplierId, productsQ.data, supplierDetailQ.data]);

  const supplierCodeOf = (model: string): string | null => {
    const counts = Object.entries(supplierCodes[model] ?? {}).sort((a, b) => b[1] - a[1]);
    return counts[0]?.[0] ?? null;
  };

  const modelNames = useMemo(() => {
    const out = new Map<string, string>();
    for (const p of productsQ.data ?? []) {
      const row = p as unknown as { base_model?: string | null; model_name?: string | null };
      if (row.base_model && row.model_name) out.set(row.base_model, row.model_name);
    }
    return out;
  }, [productsQ.data]);

  // The models to work on: a supplier's page shows what they carry, Products every sofa.
  const models = useMemo(() => {
    const set = new Set<string>(book.keys());
    for (const m of supplierId ? Object.keys(supplierCodes) : Object.keys(modulesByModel)) set.add(m);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [book, supplierCodes, modulesByModel, supplierId]);

  const openModel = params.get('comboModel') ?? models.find((m) => book.has(m)) ?? models[0] ?? null;
  // Module code to its names for the picker's search: the build label and the SKU name.
  const moduleNames = useMemo(() => {
    const out: Record<string, string> = Object.fromEntries(SOFA_MODULES.map((m) => [m.id, m.label]));
    for (const p of productsQ.data ?? []) {
      const row = p as unknown as { base_model?: string | null; code?: string | null; name?: string | null };
      const code = row.code ?? '';
      const dash = code.indexOf('-');
      if (row.base_model !== openModel || dash <= 0 || !row.name) continue;
      const compartment = normalizeCompartmentCode(code.slice(dash + 1));
      if (compartment) out[compartment] = `${out[compartment] ?? ''} ${row.name}`;
    }
    return out;
  }, [productsQ.data, openModel]);

  const [search, setSearch] = useState('');
  const [allModels, setAllModels] = useState(false);
  const model = openModel;
  const rawTier = params.get('comboPrice');
  const tier: SofaPriceTier = PRICE_TIERS.find((t) => t === rawTier) ?? 'PRICE_2';
  const setParam = (key: string, value: string) =>
    setParams((cur) => { const next = new URLSearchParams(cur); next.set(key, value); return next; }, { replace: true });

  const lines = useMemo(() => (model ? (book.get(model) ?? []) : []), [book, model]);
  const [pickedKey, setPickedKey] = useState<string | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [effectiveFrom, setEffectiveFrom] = useState(today);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [notice, setNotice] = useState('');
  const [onlyPriced, setOnlyPriced] = useState(true);

  useEffect(() => { setTicked(new Set()); setNotice(''); setOnlyPriced(true); }, [model, supplierId]);

  const picked = lines.find((l) => l.key === pickedKey) ?? lines[0] ?? null;
  const chosen = lines.filter((l) => ticked.has(l.key));
  const ownModules = model ? (modulesByModel[model] ?? []) : [];

  const inUse = sizesInUse(lines);
  const allSizes = model ? sizesOf(model) : sortSizes(heights);
  const sizes = onlyPriced && inUse.size > 0 ? allSizes.filter((h) => inUse.has(h)) : allSizes;
  const canNarrow = inUse.size > 0 && inUse.size < allSizes.length;

  const allLines = [...book.values()].flat();
  const allSizesEver = sortSizes(new Set([...heights, ...sizesInUse(allLines)]));
  const emptying = Object.values(edits).some((v) => v.trim() === '');
  const editingAuto = Object.keys(edits).some((key) => {
    const [lineKey, t] = JSON.parse(key) as [string, SofaPriceTier];
    return lineByKey.get(lineKey)?.byTier[t]?.costSource === 'auto';
  });
  const missing = allLines.filter((l) => !hasPrice(l)).length;
  const manual = allLines.filter((l) => l.byTier[tier]?.costSource === 'manual').length;
  const monthStart = `${today.slice(0, 7)}-01`;
  const changed = allLines.filter((l) => Object.values(l.byTier).some((r) => r.effectiveFrom >= monthStart)).length;

  const editCount = Object.keys(edits).length;

  const save = async () => {
    const { items, bad } = itemsFromEdits(edits, lineByKey, supplierId ?? null, effectiveFrom);
    if (bad !== null) { void notify({ title: `${bad} is not a price.`, tone: 'error' }); return; }
    if (items.length === 0) { setEdits({}); return; }
    try {
      await apply.mutateAsync(items);
      setEdits({});
      setNotice(effectiveFrom > today
        ? `Saved. The new prices start on ${fmtDate(effectiveFrom)}; until then the table shows the current ones.`
        : 'Saved.');
    } catch (e) {
      void notify({ title: "Couldn't save these prices", body: errText(e), tone: 'error' });
    }
  };

  const closeDone = (text: string) => { setNotice(text); setTicked(new Set()); setDialog(null); };
  const toggleLine = (key: string) => setTicked((cur) => {
    const next = new Set(cur);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const kpis = [
    { label: 'All combos', value: allLines.length, warn: false },
    { label: 'Missing a price', value: missing, warn: missing > 0 },
    ...(supplierId ? [] : [{ label: `Manual cost, ${tierLabel(tier)}`, value: manual, warn: false }]),
    { label: 'Changed this month', value: changed, warn: false },
  ];

  const modelEntries = models.map((m) => ({ code: m, name: modelNames.get(m) ?? '', supplierCode: supplierCodeOf(m), combos: (book.get(m) ?? []).length }));
  // A search on Products also finds sofa models with no SKU module yet (Products > Modular).
  const everyModel = supplierId ? [] : [
    ...(productModelsQ.data ?? []).filter((m) => m.active).map((m) => m.model_code),
    ...(productsQ.data ?? []).map((p) => (p as unknown as { base_model?: string | null }).base_model ?? ''),
  ].filter((code) => code !== '').map((code) => ({
    code,
    name: modelNames.get(code) ?? (productModelsQ.data ?? []).find((m) => m.model_code === code)?.name ?? '',
    supplierCode: null,
    combos: (book.get(code) ?? []).length,
  }));
  const shownModels = listedModels(modelEntries, everyModel, search, allModels, model);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '8px 0' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 12 }}>
        <h2 style={{ flex: '1 1 260px', margin: 0, fontFamily: 'var(--font-display)', fontSize: 'var(--fs-22)', color: 'var(--c-ink)' }}>
          {supplierId ? 'Combo Pricing' : 'Sofa Combo Pricing'}
        </h2>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <Button variant="secondary" onClick={() => setDialog({ kind: 'export' })}>Export</Button>
          <Button variant="secondary" onClick={() => setDialog({ kind: 'import' })}>Import</Button>
          <Button variant="primary" onClick={() => setDialog({ kind: 'new' })} disabled={!model}>New combo</Button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
        {kpis.map((k) => (
          <div key={k.label} style={{ ...card, padding: '12px 16px' }}>
            <div style={soft}>{k.label}</div>
            <div style={{ fontSize: 'var(--fs-22)', fontWeight: 700, color: k.warn ? 'var(--c-festive-b, #8f2c1a)' : 'var(--c-ink)' }}>{k.value}</div>
          </div>
        ))}
      </div>

      {combosQ.isError && <p style={{ color: 'var(--c-festive-b, #8f2c1a)' }}>Couldn't load the combos. {errText(combosQ.error)}</p>}

      <div className={styles.room}>
      <div className={styles.columns}>
        <div className={styles.models}>
          <div style={{ padding: 10 }}>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search model" aria-label="Search model" style={fieldStyle} />
          </div>
          <div className={styles.modelList}>
            {shownModels.map((entry) => {
              const m = entry.code;
              const empty = (book.get(m) ?? []).filter((l) => !hasPrice(l)).length;
              const count = `${entry.combos} ${entry.combos === 1 ? 'combo' : 'combos'}`;
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => { setParam('comboModel', m); setPickedKey(null); }}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', minHeight: 54, padding: '6px 14px', border: 0, borderTop: '1px solid var(--line)', background: m === model ? 'var(--c-paper)' : 'transparent', color: 'var(--c-ink)', textAlign: 'left', cursor: 'pointer' }}
                >
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', fontWeight: 600 }}>{supplierId ? 'Our code ' : ''}{entry.name && entry.name !== m ? `${m} · ${entry.name}` : m}</span>
                    <span style={soft}>{supplierId ? `${entry.supplierCode ? `Supplier code ${entry.supplierCode}` : 'No supplier code'} · ${count}` : count}</span>
                  </span>
                  {empty > 0 && <span title={`${empty} with no price`} style={{ minWidth: 22, padding: '2px 6px', borderRadius: 999, textAlign: 'center', fontSize: 'var(--fs-11)', fontWeight: 600, background: 'var(--c-festive-b-bg, var(--hz-dk-err-bg, #f7e9e9))', color: 'var(--c-festive-b, #8f2c1a)' }}>{empty}</span>}
                </button>
              );
            })}
            {shownModels.length === 0 && <p style={{ ...soft, padding: 12 }}>{search ? 'No model matches.' : 'No combos yet.'}</p>}
          </div>
          {!search && models.length > modelEntries.filter((m) => m.combos > 0).length && (
            <div style={{ padding: 8, borderTop: '1px solid var(--line)' }}>
              <Button variant="ghost" onClick={() => setAllModels(!allModels)} style={{ width: '100%' }}>
                {allModels ? 'Only models with combos' : `Show all ${models.length} models`}
              </Button>
            </div>
          )}
        </div>

        <div className={styles.book}>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, padding: '14px 16px', borderBottom: '1px solid var(--line)' }}>
            <div style={{ flex: '1 1 220px', minWidth: 0 }}>
              <div style={{ fontSize: 'var(--fs-18)', fontWeight: 700 }}>{model ?? 'No model'}{model && modelNames.get(model) && modelNames.get(model) !== model ? ` · ${modelNames.get(model) ?? ''}` : ''}</div>
              <div style={soft}>
                {supplierId && model ? `Our code ${model} · ${supplierCodeOf(model) ? `Supplier code ${supplierCodeOf(model) ?? ''}` : 'No supplier code'} · ` : ''}
                {tierLabel(tier)} · {supplierId ? 'used for PO auto-pricing' : 'RM cost per set'}
              </div>
            </div>
            {canNarrow && <Button variant="secondary" onClick={() => setOnlyPriced(!onlyPriced)}>{onlyPriced ? `Show all ${allSizes.length} sizes` : 'Hide empty sizes'}</Button>}
          </div>

          {notice && <div style={{ padding: '10px 16px', background: 'var(--c-paper)', color: GREEN, fontWeight: 600 }}>{notice}</div>}

          {chosen.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: '10px 16px', background: 'var(--c-paper)' }}>
              <strong style={{ flex: '1 1 140px', fontWeight: 600 }}>{chosen.length} {chosen.length === 1 ? 'combo' : 'combos'} selected</strong>
              {!supplierId && <Button variant="primary" onClick={() => setDialog({ kind: 'assign' })}>Assign to supplier</Button>}
              <Button variant="secondary" onClick={() => setDialog({ kind: 'adjust' })}>Adjust by %</Button>
              <Button variant="secondary" onClick={() => setDialog({ kind: 'delete' })} style={{ color: 'var(--c-festive-b, #8f2c1a)' }}>Delete</Button>
              <Button variant="ghost" onClick={() => setTicked(new Set())}>Clear</Button>
            </div>
          )}

          <div role="tablist" aria-label="Price" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '12px 16px 0' }}>
            {PRICE_TIERS.map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={t === tier}
                onClick={() => setParam('comboPrice', t)}
                style={{ minHeight: 40, padding: '0 14px', borderRadius: 999, fontWeight: 600, cursor: 'pointer', border: `1px solid ${t === tier ? GREEN : 'var(--line-strong)'}`, background: t === tier ? GREEN : 'var(--c-cream)', color: t === tier ? '#fff' : 'var(--c-ink)' }}
              >
                {tierLabel(t)}
              </button>
            ))}
          </div>

          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.tick}>
                    <input
                      type="checkbox"
                      aria-label="Select all combos"
                      checked={lines.length > 0 && chosen.length === lines.length}
                      onChange={() => setTicked(chosen.length === lines.length ? new Set() : new Set(lines.map((l) => l.key)))}
                      style={{ width: 18, height: 18 }}
                    />
                  </th>
                  <th className={styles.name}>Combo</th>
                  {sizes.map((h) => <th key={h} className={styles.num}>{heightLabel(h)}</th>)}
                  <th className={styles.note}>Cost from</th>
                  <th className={styles.note}>Last change</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => {
                  const rule = line.byTier[tier];
                  const priced = !!rule && Object.values(rule.pricesByHeight).some((v) => v != null);
                  let source = priced ? (supplierId ? 'Supplier' : 'Manual') : 'No price';
                  if (rule?.costSource === 'auto') source = 'Auto';
                  return (
                    <tr key={line.key} onClick={() => setPickedKey(line.key)} className={line.key === picked?.key ? `${styles.row} ${styles.rowOn}` : styles.row}>
                      <td className={styles.tick}>
                        <input type="checkbox" aria-label={`Select ${line.name}`} checked={ticked.has(line.key)} onChange={() => toggleLine(line.key)} onClick={(e) => e.stopPropagation()} style={{ width: 18, height: 18 }} />
                      </td>
                      <td className={styles.name}>{line.name}</td>
                      {sizes.map((h) => {
                        const key = editKey(line, tier, h);
                        const sen = costAt(line, tier, h);
                        const shown = edits[key] ?? (sen === null ? '' : plain(sen));
                        const old = rule?.sellingPricesByHeight?.[h];
                        return (
                          <td key={h} className={styles.num}>
                            <input
                              aria-label={`${line.name} at ${heightLabel(h)}`}
                              value={shown}
                              inputMode="decimal"
                              placeholder={sen === null && old != null ? plain(old) : 'Add'}
                              onClick={(e) => e.stopPropagation()}
                              onChange={(e) => setEdits({ ...edits, [key]: e.target.value })}
                              style={{ ...fieldStyle, minHeight: 38, textAlign: 'right', background: edits[key] === undefined ? 'var(--c-cream)' : 'var(--c-warning-bg, var(--hz-c-warning-bg))' }}
                            />
                          </td>
                        );
                      })}
                      <td className={styles.note}>
                        <span title={rule?.derivedFromSupplierName ?? undefined} style={tag(source === 'Manual' || source === 'No price')}>{source}</span>
                      </td>
                      <td className={styles.note} style={soft}>{priced && rule ? fmtDate(rule.effectiveFrom) : 'New'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {combosQ.isLoading && <p style={{ ...soft, padding: 16 }}>Loading combos...</p>}
            {!combosQ.isLoading && lines.length === 0 && <p style={{ ...soft, padding: 16 }}>No combos on this model yet. Press New combo to copy or build one.</p>}
          </div>

          {editCount > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, padding: '10px 16px', background: 'var(--c-warning-bg, var(--hz-c-warning-bg))', color: 'var(--c-warning, var(--hz-c-warning-text))' }}>
              <strong style={{ flex: '1 1 140px', fontWeight: 600 }}>{editCount} {editCount === 1 ? 'price' : 'prices'} changed</strong>
              {emptying && <span style={{ fontSize: 'var(--fs-12)' }}>An emptied cell loses its price today, whatever the date.</span>}
              {editingAuto && <span style={{ fontSize: 'var(--fs-12)' }}>Auto cost: the next supplier price save replaces this.</span>}
              <span style={{ fontSize: 'var(--fs-12)' }}>Effective from</span>
              <DateField value={effectiveFrom} onChange={setEffectiveFrom} aria-label="Effective from" />
              <Button variant="ghost" onClick={() => setEdits({})}>Discard</Button>
              <Button variant="primary" onClick={() => { void save(); }} disabled={apply.isPending}>Save changes</Button>
            </div>
          )}
        </div>

        {picked && (
          <ComboPanel
            line={picked}
            tier={tier}
            supplierId={supplierId ?? null}
            onEdit={() => setDialog({ kind: 'edit', line: picked })}
          />
        )}
      </div>
      </div>

      {dialog?.kind === 'new' && model && (
        <NewComboDialog
          model={model}
          lines={lines}
          sourceBook={sourceBook}
          ownModules={ownModules.length > 0 ? ownModules : ALL_MODULE_CODES}
          supplierId={supplierId ?? null}
          today={today}
          onHand={() => setDialog({ kind: 'hand' })}
          onClose={() => setDialog(null)}
        />
      )}
      {(dialog?.kind === 'hand' || dialog?.kind === 'edit') && model && (
        <CompartmentDialog
          model={model}
          editing={dialog.kind === 'edit' ? dialog.line : null}
          codes={ownModules.length > 0 ? ownModules : ALL_MODULE_CODES}
          names={moduleNames}
          supplierId={supplierId ?? null}
          today={today}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'assign' && model && (
        <AssignDialog model={model} chosen={chosen} today={today} onDone={closeDone} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'delete' && (
        <DeleteDialog chosen={chosen} supplierId={supplierId ?? null} onDone={closeDone} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'adjust' && (
        <AdjustDialog chosen={chosen} tier={tier} supplierId={supplierId ?? null} today={today} onDone={closeDone} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'export' && (
        <ExportDialog model={model} book={book} supplierName={supplierName} sizesOf={sizesOf} today={today} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'import' && (
        <ImportDialog lines={allLines} modulesByModel={modulesByModel} sizes={allSizesEver} supplierId={supplierId ?? null} supplierName={supplierName} today={today} onDone={closeDone} onClose={() => setDialog(null)} />
      )}
    </div>
  );
};

function ComboPanel({ line, tier, supplierId, onEdit }: {
  line: ComboLine; tier: SofaPriceTier; supplierId: string | null; onEdit: () => void;
}) {
  const rule = line.byTier[tier];
  const historyQ = useSofaComboHistory(rule ? { baseModel: rule.baseModel, modules: rule.modules, tier: rule.tier, customerId: rule.customerId, supplierId } : null);
  const history = historyLines(historyQ.data ?? []);
  return (
    <div className={styles.panel}>
      <div className={styles.panelBody}>
      <div>
      <div style={{ fontSize: 'var(--fs-16)', fontWeight: 700 }}>{line.name}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
        {line.modules.map((slot, i) => (
          <span key={i} title={slot.join(' or ')} style={{ padding: '6px 9px', borderRadius: 'var(--radius-sm)', background: 'var(--c-paper)', color: GREEN, fontSize: 'var(--fs-12)', fontWeight: 600 }}>{slotLabel(slot)}</span>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10, marginTop: 12 }}>
        <div><div style={soft}>Effective from</div><div style={{ fontWeight: 600 }}>{rule ? fmtDate(rule.effectiveFrom) : 'No price'}</div></div>
        <div><div style={soft}>Price</div><div style={{ fontWeight: 600 }}>{tierLabel(tier)}</div></div>
      </div>
      <div style={{ marginTop: 12 }}>
        <Button variant="primary" onClick={onEdit} style={{ width: '100%' }}>Edit compartments</Button>
      </div>
      </div>
      <div>
      <div style={{ ...soft, fontWeight: 600, marginTop: 18 }}>Edit history</div>
      {historyQ.isError && <p style={{ ...soft, color: 'var(--c-festive-b, #8f2c1a)' }}>Couldn't load the history. {errText(historyQ.error)}</p>}
      {!historyQ.isLoading && !historyQ.isError && history.length === 0 && <p style={soft}>No changes at {tierLabel(tier)} yet.</p>}
      {history.map((h) => (
        <div key={h.id} style={{ padding: '10px 0', borderTop: '1px solid var(--line)' }}>
          <div style={{ ...soft, display: 'flex', gap: 8 }}>
            <span style={{ flex: 1 }}>{fmtDate(h.date)}</span>
            <span>{h.who}</span>
          </div>
          <div style={{ fontWeight: 600, marginTop: 2 }}>{h.what}</div>
          {h.detail && <div style={{ marginTop: 2 }}>{h.detail}</div>}
        </div>
      ))}
      </div>
      </div>
    </div>
  );
}
