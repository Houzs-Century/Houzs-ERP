// ----------------------------------------------------------------------------
// LorryDetail — the drawer behind a row click on Fleet's Lorries section.
// Owner-approved mockup: a COMPLIANCE strip (road tax / insurance / Puspakom /
// next service) over the purchase record and the service/repair history.
//
// All thresholds, cadence labels and the next-service rules come from
// vendor/shared/lorry-compliance.ts — the single logic layer, so a phone screen
// added later cannot disagree with this one about when a tile turns red.
//
// THE ONE RULE THIS FILE MUST NOT BREAK: the odometer is only as fresh as the
// last service (readings are entered per-service, owner option A), so nothing
// here renders a current-mileage or "due in N km" figure. The Next Service tile
// takes its colour from the DATE alone and states the km target as the workshop
// set it, next to the reading it was measured against and how old that reading
// is. See the header of lorry-compliance.ts for why a confident km countdown
// would be the same bug as the costing card that reported a green 100% margin
// off an empty cost table.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { Plus, X, Paperclip, Trash2 } from 'lucide-react';
import { Button } from '@2990s/design-system';
import {
  useUpdateLorry,
  useLorryServiceRecords,
  useCreateLorryServiceRecord,
  useDeleteLorryServiceRecord,
  useUploadServiceInvoice,
  fetchServiceInvoiceUrl,
  LORRY_TYPE_LABEL,
  CAPACITY_LAYERS,
  CAPACITY_LAYER_LABEL,
  type LorryRow,
  type LorryServiceRecord,
  type CapacityLayer,
} from '../../vendor/scm/lib/lorries-queries';
import { useWarehouses } from '../../vendor/scm/lib/inventory-queries';
import { useThreePLCompanies } from '../../vendor/scm/lib/threepl-companies-queries';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { fmtSen } from '../../vendor/shared/format';
import {
  COMPLIANCE_KINDS,
  COMPLIANCE_LABEL,
  COMPLIANCE_CADENCE,
  expiryStatus,
  expiryPhrase,
  nextServiceView,
  nextServiceKmPhrase,
  odometerStalenessNote,
  type ComplianceKind,
  type ComplianceTone,
} from '../../vendor/shared/lorry-compliance';
import { formatDate } from '../../lib/utils';
import styles from './Suppliers.module.css';
import { DateField } from "../../vendor/scm/components/DateField";
import { warehouseLabel } from "../../vendor/scm/lib/warehouse-label";

const ICON = { size: 16, strokeWidth: 1.75 } as const;

// WS3: box capacity (m3) from L x W x H (ft). Mirrors the backend derivation
// (lorries.ts boxCapacityM3) so the live preview matches what gets stored.
const FT3_TO_M3 = 0.0283168;
const numOrNull = (v: number | string | null | undefined): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const boxM3 = (l: number | null, w: number | null, h: number | null): number | null =>
  l != null && w != null && h != null ? Math.round(l * w * h * FT3_TO_M3 * 100) / 100 : null;

/* Tone → the design-system tokens. Kept as a map rather than inline ternaries
   so the four tiles and the history rows can never drift apart on what "red"
   means. 'none' (nothing recorded) is deliberately NOT green — an unrecorded
   expiry is an open question, not a pass. */
const TONE_STYLE: Record<ComplianceTone, { fg: string; bg: string; border: string }> = {
  expired:  { fg: 'var(--c-error)',   bg: 'var(--c-error-bg)',   border: 'var(--c-error)' },
  critical: { fg: 'var(--c-error)',   bg: 'var(--c-error-bg)',   border: 'var(--c-error)' },
  warning:  { fg: 'var(--c-warn)',    bg: 'var(--c-warn-bg)',    border: 'var(--c-warn)' },
  ok:       { fg: 'var(--c-success)', bg: 'var(--c-success-bg)', border: 'var(--line)' },
  none:     { fg: 'var(--fg-muted)',  bg: 'transparent',         border: 'var(--line)' },
};

const lorryExpiry = (l: LorryRow, k: ComplianceKind): string | null =>
  (k === 'roadTax' ? l.road_tax_expiry : k === 'insurance' ? l.insurance_expiry : l.puspakom_expiry) ?? null;

// ─────────────────────────────────────────────────────────────────────────────

export /** A date column the LorryRow type does not declare yet (mig 0245). */
const fmtDateField = (l: unknown, col: string): string => {
  const v = (l as Record<string, unknown>)[col];
  return typeof v === 'string' && v ? formatDate(v) : '—';
};

export const LorryDetail = ({ lorry, onClose }: { lorry: LorryRow; onClose: () => void }) => {
  const records = useLorryServiceRecords(lorry.id);
  const [adding, setAdding] = useState(false);

  const next = useMemo(() => nextServiceView(records.data ?? []), [records.data]);

  return (
    <>
      <div className={styles.backdrop} onClick={onClose} />
      <aside className={styles.drawer} style={{ width: 'min(680px, 100vw)' }}>
        <header className={styles.drawerHeader}>
          <div>
            <h2 className={styles.drawerTitle}>{lorry.plate}</h2>
            <p className={styles.eyebrow}>
              {LORRY_TYPE_LABEL[lorry.type] ?? lorry.type}
              {lorry.model ? ` · ${lorry.model}` : ''}
            </p>
          </div>
          <button type="button" className={styles.iconBtn} onClick={onClose}><X {...ICON} /></button>
        </header>

        <div className={styles.drawerBody}>
          <ComplianceStrip lorry={lorry} next={next} />
          <CapacitySection lorry={lorry} />
          <PurchaseSection lorry={lorry} />

          <section className={styles.section}>
            <div className={styles.headerRow}>
              <h3 className={styles.title} style={{ fontSize: 'var(--fs-15)' }}>Service &amp; repair history</h3>
              <Button variant="primary" size="sm" onClick={() => setAdding(true)}>
                <Plus {...ICON} />
                <span>Add record</span>
              </Button>
            </div>

            {records.isLoading ? (
              <p className={styles.eyebrow}>Loading…</p>
            ) : (records.data ?? []).length === 0 ? (
              <p className={styles.eyebrow}>
                No service records yet. Add one after each workshop visit — date, what was done,
                cost, odometer, and the invoice.
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
                {(records.data ?? []).map((r) => (
                  <ServiceRow key={r.id} record={r} lorryId={lorry.id} />
                ))}
              </div>
            )}
          </section>
        </div>

        <footer className={styles.drawerFooter}>
          <Button variant="ghost" size="md" onClick={onClose}>Close</Button>
        </footer>
      </aside>

      {adding && <AddServiceRecord lorryId={lorry.id} onClose={() => setAdding(false)} />}
    </>
  );
};

// ── the compliance strip ─────────────────────────────────────────────────────

const ComplianceStrip = ({ lorry, next }: { lorry: LorryRow; next: ReturnType<typeof nextServiceView> }) => {
  const kmLine = nextServiceKmPhrase(next);
  const stale = odometerStalenessNote(next);

  return (
    <section className={styles.section}>
      <h3 className={styles.title} style={{ fontSize: 'var(--fs-15)' }}>Compliance</h3>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 'var(--space-2)' }}>
        {COMPLIANCE_KINDS.map((k) => {
          const s = expiryStatus(lorryExpiry(lorry, k));
          const t = TONE_STYLE[s.tone];
          return (
            <Tile
              key={k}
              title={COMPLIANCE_LABEL[k]}
              cadence={COMPLIANCE_CADENCE[k]}
              date={s.date ? formatDate(s.date) : '—'}
              phrase={expiryPhrase(s)}
              tone={t}
            />
          );
        })}

        {/* Next service. Colour comes from the DATE only — see the file header. */}
        <Tile
          title="Next service"
          cadence="Set by the workshop"
          date={next.dueDate ? formatDate(next.dueDate) : '—'}
          phrase={
            next.dueDate
              ? expiryPhrase({ tone: next.tone, days: next.daysToDue, date: next.dueDate })
              : kmLine
                ? 'No date set'
                : 'Not recorded'
          }
          tone={TONE_STYLE[next.tone]}
          extra={kmLine}
          caveat={stale}
        />
      </div>
    </section>
  );
};

const Tile = ({
  title, cadence, date, phrase, tone, extra, caveat,
}: {
  title: string; cadence: string; date: string; phrase: string;
  tone: { fg: string; bg: string; border: string };
  extra?: string | null; caveat?: string | null;
}) => (
  <div style={{
    border: `1px solid ${tone.border}`, background: tone.bg,
    borderRadius: 'var(--radius-md)', padding: 'var(--space-3)',
    display: 'flex', flexDirection: 'column', gap: 2,
  }}>
    <span style={{ fontSize: 'var(--fs-12)', fontWeight: 600, color: 'var(--c-ink)' }}>{title}</span>
    {/* The cadence rides on the tile, not in a date formula — the renewal
        interval is the thing the operator needs to know and the system
        deliberately never computes the next date from it. */}
    <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-soft)' }}>{cadence}</span>
    <span style={{ fontSize: 'var(--fs-15)', fontWeight: 700, color: tone.fg, marginTop: 4 }}>{date}</span>
    <span style={{ fontSize: 'var(--fs-12)', color: tone.fg }}>{phrase}</span>
    {extra ? <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)', marginTop: 4 }}>{extra}</span> : null}
    {caveat ? <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-soft)', fontStyle: 'italic' }}>{caveat}</span> : null}
  </div>
);

// ── purchase ─────────────────────────────────────────────────────────────────

// Fleet A1 — the per-lorry delivery capacity ceilings the auto-propose packer
// reads. Blank max_* => the packer uses its config default (10 sets / RM30k).
const CapacitySection = ({ lorry }: { lorry: LorryRow }) => {
  const update = useUpdateLorry();
  const warehouses = useWarehouses();
  const companies = useThreePLCompanies();
  const notify = useNotify();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    warehouseId: lorry.warehouse_id ?? '',
    threeplCompanyId: lorry.threepl_company_id ?? '',
    maxSets: lorry.max_sets != null ? String(lorry.max_sets) : '',
    maxRevenueRm: lorry.max_revenue_sen != null ? String(lorry.max_revenue_sen / 100) : '',
    layer: (lorry.capacity_layer ?? 'SETS') as CapacityLayer,
    lengthFt: lorry.length_ft != null ? String(lorry.length_ft) : '',
    widthFt: lorry.width_ft != null ? String(lorry.width_ft) : '',
    heightFt: lorry.height_ft != null ? String(lorry.height_ft) : '',
  });
  const set = <K extends keyof typeof form>(k: K, v: typeof form[K]) => setForm((s) => ({ ...s, [k]: v }));

  const whName = useMemo(() => {
    const m = new Map<string, string>();
    for (const w of warehouses.data ?? []) m.set(w.id, warehouseLabel(w) ?? '');
    return m;
  }, [warehouses.data]);
  const coName = useMemo(() => {
    const m = new Map<string, string>();
    for (const co of companies.data ?? []) m.set(co.id, co.name);
    return m;
  }, [companies.data]);

  // Live preview of the derived capacity (edit) / stored value (view).
  const formM3 = boxM3(numOrNull(form.lengthFt), numOrNull(form.widthFt), numOrNull(form.heightFt));
  const viewM3 = numOrNull(lorry.capacity_m3 ?? null);

  const save = () => {
    const setsStr = form.maxSets.trim();
    const revStr = form.maxRevenueRm.trim();
    if (setsStr && !(Number.isInteger(Number(setsStr)) && Number(setsStr) >= 0)) { notify({ title: 'Max sets must be a whole number.', tone: 'error' }); return; }
    if (revStr && !(Number.isFinite(Number(revStr)) && Number(revStr) >= 0)) { notify({ title: 'Max revenue must be a number.', tone: 'error' }); return; }
    for (const [label, v] of [['Length', form.lengthFt], ['Width', form.widthFt], ['Height', form.heightFt]] as const) {
      if (v.trim() && !(Number.isFinite(Number(v)) && Number(v) >= 0)) { notify({ title: `${label} must be a non-negative number.`, tone: 'error' }); return; }
    }
    update.mutate({
      id: lorry.id,
      warehouseId: form.warehouseId || null,
      threeplCompanyId: form.threeplCompanyId || null,
      maxSets: setsStr ? Math.round(Number(setsStr)) : null,
      maxRevenueSen: revStr ? Math.round(Number(revStr) * 100) : null,
      capacityLayer: form.layer,
      lengthFt: numOrNull(form.lengthFt),
      widthFt: numOrNull(form.widthFt),
      heightFt: numOrNull(form.heightFt),
    }, {
      onSuccess: () => { setEditing(false); notify({ title: 'Capacity updated.' }); },
      onError: (e: unknown) => notify({ title: (e as Error)?.message ?? 'Save failed.', tone: 'error' }),
    });
  };

  if (!editing) {
    const box = lorry.length_ft != null && lorry.width_ft != null && lorry.height_ft != null
      ? `${lorry.length_ft} x ${lorry.width_ft} x ${lorry.height_ft} ft` : '—';
    return (
      <section className={styles.section}>
        <div className={styles.headerRow}>
          <h3 className={styles.title} style={{ fontSize: 'var(--fs-15)' }}>Delivery capacity</h3>
          <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>Edit</Button>
        </div>
        <dl style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 'var(--space-3)', margin: 0 }}>
          {/* WS3: region gates which trips can pick this lorry. "Any region" =
              warehouse_id NULL, i.e. selectable from any depot until pinned. */}
          <Fact label="Region (home warehouse)" value={lorry.warehouse_id ? (whName.get(lorry.warehouse_id) ?? '—') : 'Any region'} />
          <Fact label="3PL company" value={lorry.threepl_company_id ? (coName.get(lorry.threepl_company_id) ?? '—') : 'Own fleet'} />
          <Fact label="Box (L x W x H)" value={box} />
          <Fact label="Capacity (m3)" value={viewM3 != null ? `${viewM3} m3` : '—'} />
          <Fact label="Max sets / trip" value={lorry.max_sets != null ? String(lorry.max_sets) : 'default (10)'} />
          <Fact label="Max revenue / trip" value={lorry.max_revenue_sen != null ? fmtSen(lorry.max_revenue_sen) : 'default (RM30k)'} />
          <Fact label="Ceiling layer" value={CAPACITY_LAYER_LABEL[(lorry.capacity_layer ?? 'SETS') as CapacityLayer]} />
        </dl>
      </section>
    );
  }

  return (
    <section className={styles.section}>
      <div className={styles.headerRow}>
        <h3 className={styles.title} style={{ fontSize: 'var(--fs-15)' }}>Delivery capacity</h3>
      </div>
      <div className={styles.formGrid}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Region (home warehouse)</span>
          <select className={styles.fieldInput} value={form.warehouseId} onChange={(e) => set('warehouseId', e.target.value)}>
            <option value="">Any region (unpinned)</option>
            {(warehouses.data ?? []).map((w) => (<option key={w.id} value={w.id}>{warehouseLabel(w)}</option>))}
          </select>
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>3PL company</span>
          <select className={styles.fieldInput} value={form.threeplCompanyId} onChange={(e) => set('threeplCompanyId', e.target.value)}>
            <option value="">Own fleet (none)</option>
            {(companies.data ?? []).filter((co) => co.isActive || co.id === form.threeplCompanyId).map((co) => (<option key={co.id} value={co.id}>{co.name}</option>))}
          </select>
        </label>
        <Field label="Length (ft)" value={form.lengthFt} onChange={(v) => set('lengthFt', v)} placeholder="e.g. 17" />
        <Field label="Width (ft)" value={form.widthFt} onChange={(v) => set('widthFt', v)} placeholder="e.g. 7" />
        <Field label="Height (ft)" value={form.heightFt} onChange={(v) => set('heightFt', v)} placeholder="e.g. 6.7" />
        <div>
          <span className={styles.fieldLabel}>Capacity (m3)</span>
          <div style={{ fontSize: 'var(--fs-15)', fontWeight: 700 }}>{formM3 != null ? `${formM3} m3` : '—'}</div>
          <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>Auto-calculated from L x W x H (ft)</span>
        </div>
        <Field label="Max sets / trip" value={form.maxSets} onChange={(v) => set('maxSets', v)} placeholder="blank = default 10" />
        <Field label="Max revenue / trip (RM)" value={form.maxRevenueRm} onChange={(v) => set('maxRevenueRm', v)} placeholder="blank = default 30000" />
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Ceiling layer</span>
          <select className={styles.fieldInput} value={form.layer} onChange={(e) => set('layer', e.target.value as CapacityLayer)}>
            {CAPACITY_LAYERS.map((l) => (<option key={l} value={l}>{CAPACITY_LAYER_LABEL[l]}</option>))}
          </select>
        </label>
      </div>
      <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-3)' }}>
        <Button variant="primary" size="sm" onClick={save} disabled={update.isPending}>
          {update.isPending ? 'Saving…' : 'Save'}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>Cancel</Button>
      </div>
    </section>
  );
};

const PurchaseSection = ({ lorry }: { lorry: LorryRow }) => {
  const update = useUpdateLorry();
  const notify = useNotify();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    model: lorry.model ?? '',
    /* Mig 0245 — four DIFFERENT dates. A reconditioned import is registered
       here years after it was built, and a lorry can start work before its
       transfer paperwork clears, so none of them can be inferred from another. */
    manufactureDate: (lorry as Record<string, unknown>).manufacture_date as string ?? '',
    registrationDate: (lorry as Record<string, unknown>).registration_date as string ?? '',
    inServiceDate: (lorry as Record<string, unknown>).in_service_date as string ?? '',
    purchaseDate: lorry.purchase_date ?? '',
    price: lorry.purchase_price_sen != null ? String(lorry.purchase_price_sen / 100) : '',
    roadTaxExpiry: lorry.road_tax_expiry ?? '',
    insuranceExpiry: lorry.insurance_expiry ?? '',
    puspakomExpiry: lorry.puspakom_expiry ?? '',
  });
  const set = <K extends keyof typeof form>(k: K, v: string) => setForm((s) => ({ ...s, [k]: v }));

  // Edit → Save, never a naked edit: nothing is written until Save is pressed.
  const save = () => {
    const rm = form.price.trim();
    if (rm && !Number.isFinite(Number(rm))) { notify({ title: 'Purchase price must be a number.', tone: 'error' }); return; }
    update.mutate({
      id: lorry.id,
      model: form.model.trim() || null,
      manufactureDate: form.manufactureDate || null,
      registrationDate: form.registrationDate || null,
      inServiceDate: form.inServiceDate || null,
      purchaseDate: form.purchaseDate || null,
      // RM → cents. Math.round because 1234.56 * 100 is 123455.99999 in binary
      // floating point and a truncation would quietly lose a sen per lorry.
      purchasePriceSen: rm ? Math.round(Number(rm) * 100) : null,
      roadTaxExpiry: form.roadTaxExpiry || null,
      insuranceExpiry: form.insuranceExpiry || null,
      puspakomExpiry: form.puspakomExpiry || null,
    }, {
      onSuccess: () => { setEditing(false); notify({ title: 'Lorry updated.' }); },
      onError: (e: unknown) => notify({ title: (e as Error)?.message ?? 'Save failed.', tone: 'error' }),
    });
  };

  if (!editing) {
    return (
      <section className={styles.section}>
        <div className={styles.headerRow}>
          <h3 className={styles.title} style={{ fontSize: 'var(--fs-15)' }}>Purchase &amp; documents</h3>
          <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>Edit</Button>
        </div>
        <dl style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 'var(--space-3)', margin: 0 }}>
          <Fact label="Model" value={lorry.model || '—'} />
          <Fact label="Manufactured" value={fmtDateField(lorry, 'manufacture_date')} />
          <Fact label="Registered" value={fmtDateField(lorry, 'registration_date')} />
          <Fact label="In service" value={fmtDateField(lorry, 'in_service_date')} />
          <Fact label="Purchased" value={lorry.purchase_date ? formatDate(lorry.purchase_date) : '—'} />
          <Fact label="Purchase price" value={lorry.purchase_price_sen != null ? fmtSen(lorry.purchase_price_sen) : '—'} />
        </dl>
      </section>
    );
  }

  return (
    <section className={styles.section}>
      <div className={styles.headerRow}>
        <h3 className={styles.title} style={{ fontSize: 'var(--fs-15)' }}>Purchase &amp; documents</h3>
      </div>
      <div className={styles.formGrid}>
        <Field label="Model" value={form.model} onChange={(v) => set('model', v)} placeholder="e.g. Isuzu NPR 3.0" />
        <Field label="Manufactured" type="date" value={form.manufactureDate} onChange={(v) => set('manufactureDate', v)} />
        <Field label="Registered (JPJ)" type="date" value={form.registrationDate} onChange={(v) => set('registrationDate', v)} />
        <Field label="First day in service" type="date" value={form.inServiceDate} onChange={(v) => set('inServiceDate', v)} />
        <Field label="Purchase date" type="date" value={form.purchaseDate} onChange={(v) => set('purchaseDate', v)} />
        <Field label="Purchase price (RM)" value={form.price} onChange={(v) => set('price', v)} placeholder="e.g. 128000" />
        {/* The expiry dates are typed from the document, never computed from the
            cadence — see vendor/shared/lorry-compliance.ts. */}
        <Field label="Road tax expiry" type="date" value={form.roadTaxExpiry} onChange={(v) => set('roadTaxExpiry', v)} />
        <Field label="Insurance expiry" type="date" value={form.insuranceExpiry} onChange={(v) => set('insuranceExpiry', v)} />
        <Field label="Puspakom expiry" type="date" value={form.puspakomExpiry} onChange={(v) => set('puspakomExpiry', v)} />
      </div>
      <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-3)' }}>
        <Button variant="primary" size="sm" onClick={save} disabled={update.isPending}>
          {update.isPending ? 'Saving…' : 'Save'}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>Cancel</Button>
      </div>
    </section>
  );
};

const Fact = ({ label, value }: { label: string; value: string }) => (
  <div>
    <dt className={styles.fieldLabel}>{label}</dt>
    <dd style={{ margin: 0, fontSize: 'var(--fs-13)' }}>{value}</dd>
  </div>
);

// ── one history row ──────────────────────────────────────────────────────────

const ServiceRow = ({ record, lorryId }: { record: LorryServiceRecord; lorryId: string }) => {
  const upload = useUploadServiceInvoice(lorryId);
  const del = useDeleteLorryServiceRecord(lorryId);
  const notify = useNotify();
  const confirm = useConfirm();

  const openInvoice = async () => {
    try {
      const { url } = await fetchServiceInvoiceUrl(record.id);
      window.open(url, '_blank', 'noopener');
    } catch (e) {
      notify({ title: (e as Error)?.message ?? 'Could not open the invoice.', tone: 'error' });
    }
  };

  // Destructive → in-app confirm, never a naked delete.
  const remove = async () => {
    const ok = await confirm({
      title: 'Delete this service record?',
      body: `${formatDate(record.service_date)} — ${record.description}. The attached invoice is deleted too. This cannot be undone.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    del.mutate(record.id, {
      onError: (e: unknown) => notify({ title: (e as Error)?.message ?? 'Delete failed.', tone: 'error' }),
    });
  };

  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 'var(--radius-md)', padding: 'var(--space-3)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-2)' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 'var(--fs-13)', fontWeight: 600 }}>{record.description}</div>
          <div style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
            {formatDate(record.service_date)}
            {record.workshop ? ` · ${record.workshop}` : ''}
            {/* 0 km is treated as "not recorded" rather than a real reading —
                the table allows 0 but nobody services a lorry at 0 km. */}
            {record.odometer_km ? ` · ${record.odometer_km.toLocaleString()} km` : ''}
          </div>
          {record.notes ? (
            <div style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-soft)', marginTop: 2 }}>{record.notes}</div>
          ) : null}
        </div>
        <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
          <div style={{ fontSize: 'var(--fs-13)', fontWeight: 700 }}>{fmtSen(record.cost_sen)}</div>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}>
        {record.invoice_key ? (
          <Button variant="ghost" size="sm" onClick={openInvoice}>
            <Paperclip {...ICON} />
            <span>{record.invoice_name || 'Invoice'}</span>
          </Button>
        ) : (
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 'var(--fs-12)', color: 'var(--fg-accent)' }}>
            <Paperclip {...ICON} />
            <span>{upload.isPending ? 'Uploading…' : 'Attach invoice'}</span>
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp,application/pdf"
              style={{ display: 'none' }}
              disabled={upload.isPending}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                upload.mutate({ id: record.id, file }, {
                  onError: (err: unknown) => notify({ title: (err as Error)?.message ?? 'Upload failed.', tone: 'error' }),
                });
                // Reset so re-picking the same file after a failure re-fires.
                e.target.value = '';
              }}
            />
          </label>
        )}
        <span style={{ flex: 1 }} />
        <Button variant="ghost" size="sm" onClick={remove} disabled={del.isPending}>
          <Trash2 {...ICON} />
        </Button>
      </div>
    </div>
  );
};

// ── add ──────────────────────────────────────────────────────────────────────

const AddServiceRecord = ({ lorryId, onClose }: { lorryId: string; onClose: () => void }) => {
  const create = useCreateLorryServiceRecord();
  const notify = useNotify();
  const [form, setForm] = useState({
    serviceDate: '', description: '', workshop: '', cost: '',
    odometerKm: '', nextServiceDate: '', nextServiceKm: '', notes: '',
  });
  const set = <K extends keyof typeof form>(k: K, v: string) => setForm((s) => ({ ...s, [k]: v }));

  const submit = () => {
    if (!form.serviceDate) { notify({ title: 'Service date required.', tone: 'error' }); return; }
    if (!form.description.trim()) { notify({ title: 'Describe what was done.', tone: 'error' }); return; }
    const cost = form.cost.trim();
    if (cost && !Number.isFinite(Number(cost))) { notify({ title: 'Cost must be a number.', tone: 'error' }); return; }

    create.mutate({
      lorryId,
      serviceDate: form.serviceDate,
      description: form.description.trim(),
      workshop: form.workshop.trim() || null,
      costSen: cost ? Math.round(Number(cost) * 100) : 0,
      odometerKm: form.odometerKm.trim() ? Math.round(Number(form.odometerKm)) : null,
      nextServiceDate: form.nextServiceDate || null,
      nextServiceKm: form.nextServiceKm.trim() ? Math.round(Number(form.nextServiceKm)) : null,
      notes: form.notes.trim() || null,
    }, {
      onSuccess: () => { notify({ title: 'Service record added.' }); onClose(); },
      onError: (e: unknown) => notify({ title: (e as Error)?.message ?? 'Could not save the record.', tone: 'error' }),
    });
  };

  return (
    <>
      <div className={styles.backdrop} onClick={onClose} />
      <aside className={styles.drawer}>
        <header className={styles.drawerHeader}>
          <h2 className={styles.drawerTitle}>Add service record</h2>
          <button type="button" className={styles.iconBtn} onClick={onClose}><X {...ICON} /></button>
        </header>
        <div className={styles.drawerBody}>
          <div className={styles.formGrid}>
            <Field label="Service date *" type="date" value={form.serviceDate} onChange={(v) => set('serviceDate', v)} />
            <Field label="What was done *" value={form.description} onChange={(v) => set('description', v)} placeholder="e.g. Engine oil + filter" />
            <Field label="Workshop" value={form.workshop} onChange={(v) => set('workshop', v)} />
            <Field label="Cost (RM)" value={form.cost} onChange={(v) => set('cost', v)} placeholder="e.g. 480" />
            <Field label="Odometer (km)" value={form.odometerKm} onChange={(v) => set('odometerKm', v)} placeholder="e.g. 148200" />
            <Field label="Next service date" type="date" value={form.nextServiceDate} onChange={(v) => set('nextServiceDate', v)} />
            <Field label="Next service (km)" value={form.nextServiceKm} onChange={(v) => set('nextServiceKm', v)} placeholder="e.g. 158200" />
            <Field label="Notes" value={form.notes} onChange={(v) => set('notes', v)} />
          </div>
          <p className={styles.eyebrow} style={{ marginTop: 'var(--space-3)' }}>
            The odometer is only recorded here, so the reading is only as fresh as the last
            service. Next service shows the date countdown and the workshop&rsquo;s km target
            against the reading it was set from — current mileage is not tracked.
          </p>
          <p className={styles.eyebrow}>Attach the invoice from the history list once the record is saved.</p>
        </div>
        <footer className={styles.drawerFooter}>
          <Button variant="ghost" size="md" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="md" onClick={submit} disabled={create.isPending}>
            {create.isPending ? 'Saving…' : 'Add record'}
          </Button>
        </footer>
      </aside>
    </>
  );
};

const Field = ({
  label, value, onChange, placeholder, type,
}: {
  label: string; value: string;
  onChange: (v: string) => void; placeholder?: string; type?: string;
}) => (
  <label className={styles.field}>
    <span className={styles.fieldLabel}>{label}</span>
    {/* type="date" routes to DateField, not to a native date input: the native
           one renders in the OPERATING SYSTEM's locale, so the same field read
           DD/MM/YYYY on one machine and MM/DD/YYYY on another. Same ISO contract
           in and out. */}
    {type === 'date' ? (
      <DateField className={styles.fieldInput} value={value} placeholder={placeholder} onChange={onChange} fullWidth/>
    ) : (
      <input className={styles.fieldInput} value={value} placeholder={placeholder} type={type ?? 'text'}
        onChange={(e) => onChange(e.target.value)} />
    )}
  </label>
);
