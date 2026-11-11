// ----------------------------------------------------------------------------
// 3PL Companies — the master where the owner registers an outsourced carrier:
// its company particulars (SSM, contact person, office line, address) AND its
// fleet (lorry plates, driver contacts, helper ICs). A solo operator is a
// one-lorry company.
//
// The fleet a carrier is given here lands in the SAME masters as our own —
// scm.drivers / scm.helpers / scm.lorries — carrying threepl_company_id and
// forced OUTSOURCE by the routes (backend/src/scm/lib/threepl-link.ts). So a
// 3PL's lorry shows up in Fleet, Fleet Health and the assignment pickers exactly
// like ours, marked Outsource, and Module C prices it per company.
//
// Route /scm/threepl-companies, nav "3PL Companies" under Transportation >
// Maintenance. Backed by scm.threepl_companies (migs 0210 + 0237).
// ----------------------------------------------------------------------------

import { useMemo, useState, type ReactNode, type CSSProperties } from 'react';
import { Button } from '@2990s/design-system';
import { Building2, Plus, Trash2, Pencil, Check, X, ChevronRight, ChevronDown } from 'lucide-react';
import { PageHeader } from '../../components/Layout';
import { FormCard, FormGrid, FormField, FormInput, FormSearchSelect } from '../../vendor/scm/components/FormCard';
import { PhoneInput } from '../../vendor/scm/components/PhoneInput';
import { formatPhone } from '@2990s/shared/phone';
import styles from './Suppliers.module.css';
import {
  useThreePLCompanies,
  useThreePLFleet,
  useCreateThreePLCompany,
  useUpdateThreePLCompany,
  useDeleteThreePLCompany,
  type ThreePLCompanyRow,
  type ThreePLSupplierLink,
} from '../../vendor/scm/lib/threepl-companies-queries';
import { useSuppliers } from '../../vendor/scm/lib/suppliers-queries';
import { useCreateDriver } from '../../vendor/scm/lib/drivers-queries';
import { useCreateHelper } from '../../vendor/scm/lib/helpers-queries';
import { useCreateLorry, LORRY_TYPES, LORRY_TYPE_LABEL, type LorryType } from '../../vendor/scm/lib/lorries-queries';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { writeFailedAs } from '../../vendor/scm/lib/mutation-error';
import { cn } from '../../lib/utils';
import { LorrySide } from './fleet/Lorry3D';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

const BLANK = {
  name: '', registrationNo: '', contactName: '', contactPhone: '',
  officePhone: '', email: '', address: '',
};
type Particulars = typeof BLANK;

const particularsOf = (row: ThreePLCompanyRow): Particulars => ({
  name: row.name,
  registrationNo: row.registrationNo ?? '',
  contactName: row.contactName ?? '',
  contactPhone: row.contactPhone ?? '',
  officePhone: row.officePhone ?? '',
  email: row.email ?? '',
  address: row.address ?? '',
});

export const ThreePLCompanies = ({ embedded = false }: { embedded?: boolean } = {}) => {
  const companies = useThreePLCompanies();
  const createCo = useCreateThreePLCompany();
  const notify = useNotify();

  const [form, setForm] = useState<Particulars>(BLANK);
  const [supplier, setSupplier] = useState<ThreePLSupplierLink | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const set = (k: keyof Particulars) => (v: string) => setForm((p) => ({ ...p, [k]: v }));
  /* A carrier registered from its supplier takes the supplier's name, unless a name was typed first. */
  const pickSupplier = (s: ThreePLSupplierLink | null) => {
    setSupplier(s);
    if (s) setForm((p) => (p.name.trim() ? p : { ...p, name: s.name }));
  };

  const submit = () => {
    if (!form.name.trim()) { void notify({ title: 'Name required', body: 'Give the 3PL company a name.', tone: 'error' }); return; }
    const trimmed = (v: string) => v.trim() || null;
    createCo.mutate(
      {
        name: form.name.trim(),
        registrationNo: trimmed(form.registrationNo),
        contactName: trimmed(form.contactName),
        contactPhone: trimmed(form.contactPhone),
        officePhone: trimmed(form.officePhone),
        email: trimmed(form.email),
        address: trimmed(form.address),
        supplierId: supplier?.id ?? null,
      },
      {
        onSuccess: () => {
          setForm(BLANK);
          setSupplier(null);
          void notify({ title: 'Company added', body: 'Open it to register its lorries, drivers and helpers.', tone: 'info' });
        },
        onError: writeFailedAs('The company was not added'),
      },
    );
  };

  const rows = companies.data ?? [];

  return (
    <div className="space-y-4">
      {!embedded && (
        <PageHeader
          eyebrow="Delivery"
          title="3PL Companies"
          description="Register each outsourced carrier with its company particulars and its fleet. A carrier's lorries, drivers and helpers join the Fleet module automatically, marked Outsource — and its rate card is set per company, on Rate Cards."
        />
      )}

      {/* Sales Order's card + four-column grid (owner 2026-08-02: "应该要像我们
          Sales Order 那样子的 UI"). It replaces a wrap-flex of hand-sized inputs
          that queued the fields in whatever order they happened to fit — the
          company's identity sat beside its phone number with nothing between
          them, and Address (the longest value) got the narrowest box on the row.

          Grouped the way the paperwork is: WHO the company is, then HOW to
          reach them. The formats that are now enforced server-side are stated
          under the fields rather than hidden in a placeholder that vanishes the
          moment you type. */}
      <FormCard
        title="Register a 3PL company"
        actions={
          <Button variant="primary" size="sm" onClick={submit} disabled={createCo.isPending}>
            <Plus {...ICON} />
            <span>{createCo.isPending ? 'Saving…' : 'Add company'}</span>
          </Button>
        }
      >
        <FormGrid>
          <FormField label="Company name" required span={2}>
            <FormInput value={form.name} onChange={(e) => set('name')(e.target.value)} placeholder="e.g. ABC Logistics Sdn Bhd" />
          </FormField>
          <FormField label="Supplier" span={2} hint="Its entry in Supplier maintenance. Picking one fills an empty company name.">
            <SupplierPicker value={supplier} onChange={pickSupplier} />
          </FormField>
          <FormField label="SSM / registration no" hint="Unique when given — two carriers cannot share one.">
            <FormInput value={form.registrationNo} onChange={(e) => set('registrationNo')(e.target.value)} placeholder="e.g. 202301012345" />
          </FormField>
          <FormField label="Code" hint="Allocated on save — 3PL-001, 3PL-002…">
            <FormInput value="Assigned automatically" readOnly disabled />
          </FormField>

          <FormField label="Contact person">
            <FormInput value={form.contactName} onChange={(e) => set('contactName')(e.target.value)} placeholder="Name" />
          </FormField>
          {/* The app's own phone control, not a bare text box. Owner, 2026-08-02:
              "你的 contact number 为什么不是加 60 的?" — because this screen was
              built with a plain input while Sales Order, Supplier and Team all
              use PhoneInput. It shows the country (+60 by default), stores E.164,
              and stops the browser's contact autofill hijacking the field. */}
          <FormField label="Contact phone" hint="Stored as +60…">
            <PhoneInput className={styles.fieldInput} value={form.contactPhone} onChange={set('contactPhone')} />
          </FormField>
          <FormField label="Office phone" hint="A landline is fine.">
            <PhoneInput className={styles.fieldInput} value={form.officePhone} onChange={set('officePhone')} placeholder="3-1234 5678" />
          </FormField>
          <FormField label="Email">
            <FormInput type="email" value={form.email} onChange={(e) => set('email')(e.target.value)} placeholder="ops@carrier.com" />
          </FormField>

          <FormField label="Registered address" span={4}>
            <FormInput value={form.address} onChange={(e) => set('address')(e.target.value)} placeholder="Registered address" />
          </FormField>
        </FormGrid>
      </FormCard>

      <div className="space-y-3">
        {companies.isLoading ? (
          <p className="text-[13px] text-ink-muted">Loading…</p>
        ) : companies.isError ? (
          <p className="text-[13px] text-[color:var(--hz-dk-err,#8a2c2c)]">The 3PL companies did not load.</p>
        ) : rows.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border p-6 text-center text-[13px] text-ink-muted">
            No 3PL companies yet. Register one above, then open it to add its lorries and crew.
          </p>
        ) : (
          /* NOT a table. Owner, 2026-08-02, on this list inside the Rate Cards
             drawer: "整个都被 squeeze 掉、挤爆了". Nine columns in a 700px panel
             gave every cell ~70px, so "0 lorries · 1 drivers · 0 helpers" broke
             across six lines and the whole thing grew a horizontal scrollbar.
             A wrapping row has no column to starve — the fields reflow instead. */
          rows.map((r) => (
            <CompanyRow
              key={r.id}
              row={r}
              open={open === r.id}
              onToggleOpen={() => setOpen((p) => (p === r.id ? null : r.id))}
            />
          ))
        )}
      </div>

      <div className="flex items-start gap-2 text-[12px] text-ink-muted">
        <Building2 {...ICON} />
        <span>
          A carrier&rsquo;s lorries, drivers and helpers are stored in the shared Fleet masters and flagged Outsource — you cannot mark them in-house while they belong to a 3PL.
          Deleting a company detaches its fleet (nothing is deleted). Leave is not recorded for a 3PL&rsquo;s crew; that is their employer&rsquo;s roster.
        </span>
      </div>
    </div>
  );
};

const CompanyRow = ({ row, open, onToggleOpen }: { row: ThreePLCompanyRow; open: boolean; onToggleOpen: () => void }) => {
  const update = useUpdateThreePLCompany();
  const del = useDeleteThreePLCompany();
  const notify = useNotify();
  const askConfirm = useConfirm();

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Particulars>(() => particularsOf(row));
  const [supplier, setSupplier] = useState<ThreePLSupplierLink | null>(row.supplier);
  const set = (k: keyof Particulars) => (v: string) => setForm((p) => ({ ...p, [k]: v }));
  /* Seeded from the row as it is NOW: a link refused last time, or changed since
     on the 3PL invoices tab, must not ride along on the next save. */
  const startEdit = () => { setForm(particularsOf(row)); setSupplier(row.supplier); setEditing(true); };

  const save = () => {
    if (!form.name.trim()) { void notify({ title: 'Name required', tone: 'error' }); return; }
    const trimmed = (v: string) => v.trim() || null;
    const supplierId = supplier?.id ?? null;
    update.mutate(
      {
        id: row.id, name: form.name.trim(),
        registrationNo: trimmed(form.registrationNo), contactName: trimmed(form.contactName),
        contactPhone: trimmed(form.contactPhone), officePhone: trimmed(form.officePhone),
        email: trimmed(form.email), address: trimmed(form.address),
        /* Only when it changed, so a phone edit is never refused over a link it did not touch. */
        ...(supplierId !== (row.supplier?.id ?? null) ? { supplierId } : {}),
      },
      { onSuccess: () => setEditing(false), onError: writeFailedAs('The company was not saved') },
    );
  };

  const remove = async () => {
    const total = row.lorryCount + row.driverCount + row.helperCount;
    if (!(await askConfirm({
      title: 'Delete this 3PL company?',
      body: `${row.name} — its ${total} fleet record(s) are detached, not deleted.`,
      confirmLabel: 'Delete',
      danger: true,
    }))) return;
    del.mutate(row.id, { onError: writeFailedAs('The company was not deleted') });
  };

  /* Editing reuses the SAME grid the register form above uses. The old inline
     edit was a <tr> of eight cells under a nine-column header, so every field
     sat one column left of its own label — Company name under "Code", email
     under "Fleet", and the address input under "Active". */
  if (editing) {
    return (
      <div className={SHELL}>
        <div className="p-4">
          <FormGrid>
            <FormField label="Company name" required span={2}>
              <FormInput value={form.name} onChange={(e) => set('name')(e.target.value)} />
            </FormField>
            <FormField label="Supplier" span={2} hint="Its entry in Supplier maintenance.">
              <SupplierPicker value={supplier} onChange={setSupplier} />
            </FormField>
            <FormField label="SSM / registration no">
              <FormInput value={form.registrationNo} onChange={(e) => set('registrationNo')(e.target.value)} />
            </FormField>
            <FormField label="Code" hint="Allocated once, never re-issued.">
              <FormInput value={row.code ?? '—'} readOnly disabled />
            </FormField>
            <FormField label="Contact person">
              <FormInput value={form.contactName} onChange={(e) => set('contactName')(e.target.value)} />
            </FormField>
            <FormField label="Contact phone">
              <PhoneInput className={styles.fieldInput} value={form.contactPhone} onChange={set('contactPhone')} />
            </FormField>
            <FormField label="Office phone">
              <PhoneInput className={styles.fieldInput} value={form.officePhone} onChange={set('officePhone')} placeholder="3-1234 5678" />
            </FormField>
            <FormField label="Email">
              <FormInput type="email" value={form.email} onChange={(e) => set('email')(e.target.value)} />
            </FormField>
            <FormField label="Registered address" span={4}>
              <FormInput value={form.address} onChange={(e) => set('address')(e.target.value)} />
            </FormField>
          </FormGrid>
          <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
            <Button variant="primary" size="sm" onClick={save} disabled={update.isPending}><Check {...ICON} /><span>Save</span></Button>
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)}><X {...ICON} /><span>Cancel</span></Button>
          </div>
        </div>
      </div>
    );
  }

  const fleet = [
    `${row.lorryCount} ${row.lorryCount === 1 ? 'lorry' : 'lorries'}`,
    `${row.driverCount} ${row.driverCount === 1 ? 'driver' : 'drivers'}`,
    `${row.helperCount} ${row.helperCount === 1 ? 'helper' : 'helpers'}`,
  ].join(' · ');

  return (
    <div className={cn(SHELL, !row.isActive && 'opacity-70')}>
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <button type="button" onClick={onToggleOpen} aria-expanded={open} aria-label={open ? 'Close fleet' : 'Open fleet'}
          className="grid h-8 w-8 flex-none place-items-center rounded-lg bg-surface-2 text-ink-secondary">
          {open ? <ChevronDown {...ICON} /> : <ChevronRight {...ICON} />}
        </button>

        {/* The minted code (mig 0242). It was stored and returned but nowhere
            on screen, which makes an auto-allocated identifier useless — you
            cannot quote a code you cannot see. */}
        <div className="min-w-0 flex-[1_1_190px]">
          <div className="flex items-center gap-2">
            <span className="rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-[11.5px] font-semibold text-ink-secondary">{row.code ?? '—'}</span>
            <strong className="text-[14px] text-ink">{row.name}</strong>
          </div>
          <div className="mt-0.5 text-[12px] text-ink-muted">
            {row.registrationNo ? `SSM ${row.registrationNo}` : 'No SSM on file'} · {fleet}
          </div>
        </div>

        <SupplierFact supplier={row.supplier} />
        <Fact label="Contact" value={row.contactName} sub={row.contactPhone ? formatPhone(row.contactPhone) : null} />
        <Fact label="Office" value={row.officePhone ? formatPhone(row.officePhone) : null} sub={row.email} />

        <label className="inline-flex flex-none cursor-pointer items-center gap-1.5">
          <input type="checkbox" className="h-4 w-4 accent-[#16695f]" checked={row.isActive} disabled={update.isPending}
            onChange={() => update.mutate({ id: row.id, isActive: !row.isActive }, {
              onError: writeFailedAs('The company was not updated'),
            })} />
          <span className={cn('rounded-full px-2 py-0.5 text-[11.5px] font-semibold', row.isActive ? 'bg-[color:var(--hz-dk-synced-bg,#dcebe3)] text-[#1f5c43]' : 'bg-surface-2 text-ink-muted')}>{row.isActive ? 'Active' : 'Inactive'}</span>
        </label>

        <div className="inline-flex flex-none gap-1">
          <Button variant="ghost" size="sm" onClick={startEdit}><Pencil {...ICON} /><span>Edit</span></Button>
          <Button variant="ghost" size="sm" onClick={() => void remove()} disabled={del.isPending} aria-label={`Delete ${row.name}`}><Trash2 {...ICON} /></Button>
        </div>
      </div>

      {open && (
        <div className="border-t border-border bg-surface-2/50 px-4 pb-4">
          <CarrierFleet companyId={row.id} companyName={row.name} />
        </div>
      )}
    </div>
  );
};

const SHELL = 'overflow-hidden rounded-xl border border-border bg-surface';

/* One labelled value that shrinks instead of wrapping to six lines. */
const Fact = ({ label, value, sub }: { label: string; value?: string | null; sub?: string | null }) => (
  <div className="min-w-0 flex-[1_1_150px]">
    <div className="text-[11.5px] font-semibold text-ink-muted">{label}</div>
    <div className="truncate text-[13px] text-ink">{value || '—'}</div>
    {sub && <div className="truncate text-[12px] text-ink-muted">{sub}</div>}
  </div>
);

/* The supplier the carrier bills as: code on one line, name below. */
const SupplierFact = ({ supplier }: { supplier: ThreePLSupplierLink | null }) => (
  <div className="min-w-0 flex-[1_1_170px]">
    <div className="text-[11.5px] font-semibold text-ink-muted">Supplier</div>
    {supplier ? (
      <>
        <div className="truncate font-mono text-[12px] font-semibold text-ink-secondary">{supplier.code}</div>
        <div className="truncate text-[13px] text-ink" title={supplier.name}>{supplier.name}</div>
      </>
    ) : (
      <div className="text-[13px] text-ink-muted">No supplier linked</div>
    )}
  </div>
);

/* Pick the carrier's supplier from this company's supplier master, by code or
   name. The saved link stays an option when the list leaves it out (an inactive
   supplier, or one only Finance sees), so opening the form never blanks it. */
const SupplierPicker = ({ value, onChange }: {
  value: ThreePLSupplierLink | null;
  onChange: (supplier: ThreePLSupplierLink | null) => void;
}) => {
  const suppliers = useSuppliers({ status: 'ACTIVE' });
  const choices = useMemo(() => {
    const listed: ThreePLSupplierLink[] = (suppliers.data ?? []).map((s) => ({ id: s.id, code: s.code, name: s.name }));
    return value && !listed.some((s) => s.id === value.id) ? [value, ...listed] : listed;
  }, [suppliers.data, value]);
  const options = useMemo(() => choices.map((s) => {
    const label = `${s.code} · ${s.name}`;
    /* `search` keeps the match to code and name: the value is a uuid, and digits
       typed for a code would hit it too. */
    return { value: s.id, label, search: label };
  }), [choices]);
  return (
    <div className="flex items-center gap-1.5">
      <div className="min-w-0 flex-1">
        <FormSearchSelect
          ariaLabel="Supplier"
          value={value?.id ?? ''}
          onChange={(id) => onChange(choices.find((s) => s.id === id) ?? null)}
          options={options}
          placeholder={suppliers.isError ? 'The supplier list did not load' : suppliers.isLoading ? 'Loading suppliers…' : 'Search by code or name'}
        />
      </div>
      {value && (
        <Button variant="ghost" size="sm" onClick={() => onChange(null)} aria-label="Clear supplier"><X {...ICON} /></Button>
      )}
    </div>
  );
};

/* The carrier's own fleet. Everything created here posts threeplCompanyId, so
   the row lands OUTSOURCE — the routes refuse to let it be in-house. */
const CarrierFleet = ({ companyId, companyName }: { companyId: string; companyName: string }) => {
  const fleet = useThreePLFleet(companyId);
  const notify = useNotify();

  const createLorry = useCreateLorry();
  const createDriver = useCreateDriver();
  const createHelper = useCreateHelper();

  const [plate, setPlate] = useState('');
  /* The REAL scm.lorry_type enum, from the shared list the Fleet page uses.
     Inventing options here is how this form shipped LORRY/VAN/TRUCK against an
     enum that has neither LORRY nor TRUCK - every add but Van returned 400. */
  const [lorryType, setLorryType] = useState<LorryType>('LORRY_14FT');
  const [dims, setDims] = useState({ l: '', w: '', h: '' });
  const [drv, setDrv] = useState({ name: '', phone: '', ic: '' });
  const [hlp, setHlp] = useState({ name: '', contact: '', ic: '' });

  const fail = writeFailedAs('That was not added');
  const num = (v: string) => (v.trim() === '' ? null : Number(v));

  const addLorry = () => {
    if (!plate.trim()) { void notify({ title: 'Plate required', tone: 'error' }); return; }
    createLorry.mutate(
      {
        plate: plate.trim(), type: lorryType, threeplCompanyId: companyId,
        lengthFt: num(dims.l), widthFt: num(dims.w), heightFt: num(dims.h),
      },
      { onSuccess: () => { setPlate(''); setDims({ l: '', w: '', h: '' }); void fleet.refetch(); }, onError: fail },
    );
  };

  const addDriver = () => {
    if (!drv.name.trim() || !drv.phone.trim()) {
      void notify({ title: 'Name and phone are required', tone: 'error' }); return;
    }
    createDriver.mutate(
      { name: drv.name.trim(), phone: drv.phone.trim(), icNumber: drv.ic.trim() || undefined, threeplCompanyId: companyId },
      { onSuccess: () => { setDrv({ name: '', phone: '', ic: '' }); void fleet.refetch(); }, onError: fail },
    );
  };

  const addHelper = () => {
    if (!hlp.name.trim()) { void notify({ title: 'Name is required', tone: 'error' }); return; }
    createHelper.mutate(
      { name: hlp.name.trim(), contact: hlp.contact.trim() || undefined, icNumber: hlp.ic.trim() || undefined, threeplCompanyId: companyId },
      { onSuccess: () => { setHlp({ name: '', contact: '', ic: '' }); void fleet.refetch(); }, onError: fail },
    );
  };

  const d = fleet.data;

  return (
    <div className="flex flex-col gap-3.5 pt-3">
      <span className="text-[12px] font-bold uppercase tracking-[0.06em] text-ink-muted">
        {companyName} — fleet
      </span>
      {fleet.isError && <p className="text-[13px] text-[color:var(--hz-dk-err,#8a2c2c)]">This carrier&rsquo;s fleet did not load.</p>}

      <FleetBlock title="Lorries" empty="No lorries registered for this carrier."
        rows={(d?.lorries ?? []).map((l) => ({
          id: l.id,
          main: l.plate,
          sub: [l.type ? (LORRY_TYPE_LABEL as Partial<Record<string, string>>)[l.type] ?? l.type : null, l.capacity_m3 != null ? `${l.capacity_m3} m3` : null,
            l.length_ft && l.width_ft && l.height_ft ? `${l.length_ft} x ${l.width_ft} x ${l.height_ft} ft` : null]
            .filter(Boolean).join(' · '),
          /* Drawn on the same per-foot scale as the Fleet cards. */
          visual: <LorrySide box={l.length_ft && l.width_ft && l.height_ft ? { length: Number(l.length_ft), width: Number(l.width_ft), height: Number(l.height_ft) } : null} />,
        }))}
        loading={fleet.isLoading}
        form={
          <>
            <Ctl label="Plate"><Inp value={plate} onChange={setPlate} placeholder="ABC 1234" width={120} /></Ctl>
            <Ctl label="Type">
              <select value={lorryType} onChange={(e) => setLorryType(e.target.value as LorryType)} style={{ ...selStyle, width: 130 }}>
                {LORRY_TYPES.map((t) => <option key={t} value={t}>{LORRY_TYPE_LABEL[t]}</option>)}
              </select>
            </Ctl>
            <Ctl label="L x W x H (ft)">
              <div style={{ display: 'flex', gap: 4 }}>
                <Inp value={dims.l} onChange={(v) => setDims((p) => ({ ...p, l: v }))} placeholder="L" width={54} />
                <Inp value={dims.w} onChange={(v) => setDims((p) => ({ ...p, w: v }))} placeholder="W" width={54} />
                <Inp value={dims.h} onChange={(v) => setDims((p) => ({ ...p, h: v }))} placeholder="H" width={54} />
              </div>
            </Ctl>
            <Button variant="secondary" size="sm" onClick={addLorry} disabled={createLorry.isPending}>
              <Plus {...ICON} /><span>Add lorry</span>
            </Button>
          </>
        }
      />

      <FleetBlock title="Drivers" empty="No drivers registered for this carrier."
        rows={(d?.drivers ?? []).map((x) => ({
          id: x.id, main: x.name,
          sub: [x.driver_code, x.phone ? formatPhone(x.phone) : null, x.ic_number].filter(Boolean).join(' · '),
        }))}
        loading={fleet.isLoading}
        form={
          <>
            <Ctl label="Name"><Inp value={drv.name} onChange={(v) => setDrv((p) => ({ ...p, name: v }))} width={150} /></Ctl>
            <Ctl label="Phone"><div style={{ width: 230 }}><PhoneInput className={styles.fieldInput} value={drv.phone} onChange={(v) => setDrv((p) => ({ ...p, phone: v }))} /></div></Ctl>
            <Ctl label="IC"><Inp value={drv.ic} onChange={(v) => setDrv((p) => ({ ...p, ic: v }))} width={130} /></Ctl>
            <Button variant="secondary" size="sm" onClick={addDriver} disabled={createDriver.isPending}>
              <Plus {...ICON} /><span>Add driver</span>
            </Button>
          </>
        }
      />

      <FleetBlock title="Helpers" empty="No helpers registered for this carrier."
        rows={(d?.helpers ?? []).map((x) => ({
          id: x.id, main: x.name,
          sub: [x.helper_code, x.contact ? formatPhone(x.contact) : null, x.ic_number].filter(Boolean).join(' · '),
        }))}
        loading={fleet.isLoading}
        form={
          <>
            <Ctl label="Name"><Inp value={hlp.name} onChange={(v) => setHlp((p) => ({ ...p, name: v }))} width={150} /></Ctl>
            <Ctl label="Contact"><div style={{ width: 230 }}><PhoneInput className={styles.fieldInput} value={hlp.contact} onChange={(v) => setHlp((p) => ({ ...p, contact: v }))} /></div></Ctl>
            <Ctl label="IC"><Inp value={hlp.ic} onChange={(v) => setHlp((p) => ({ ...p, ic: v }))} width={130} /></Ctl>
            <Button variant="secondary" size="sm" onClick={addHelper} disabled={createHelper.isPending}>
              <Plus {...ICON} /><span>Add helper</span>
            </Button>
          </>
        }
      />
    </div>
  );
};

const FleetBlock = ({ title, rows, empty, loading, form }: {
  title: string;
  rows: Array<{ id: string; main: string; sub: string; visual?: ReactNode }>;
  empty: string;
  loading: boolean;
  form: ReactNode;
}) => (
  <div className="overflow-hidden rounded-xl border border-border bg-surface">
    <div className="border-b border-border px-3.5 py-2.5 text-[13px] font-semibold text-ink">
      {title} <span className="font-normal text-ink-muted">({rows.length})</span>
    </div>
    {loading ? (
      <p className="px-3.5 py-2.5 text-[12.5px] text-ink-muted">Loading…</p>
    ) : rows.length === 0 ? (
      <p className="px-3.5 py-2.5 text-[12.5px] text-ink-muted">{empty}</p>
    ) : rows.some((r) => r.visual) ? (
      <ul className="grid gap-2.5 p-3 sm:grid-cols-2">
        {rows.map((r) => (
          <li key={r.id} className="rounded-lg border border-border p-2.5">
            <span className="rounded-md bg-[#1d2420] px-2 py-0.5 font-mono text-[12.5px] tracking-wider text-white">{r.main}</span>
            <div className="my-1.5">{r.visual}</div>
            {r.sub && <div className="text-[12px] text-ink-muted">{r.sub}</div>}
          </li>
        ))}
      </ul>
    ) : (
      <ul>
        {rows.map((r) => (
          <li key={r.id} className="border-b border-border-subtle px-3.5 py-2 text-[13px] last:border-b-0">
            <strong className="text-ink">{r.main}</strong>
            {r.sub && <span className="text-ink-muted"> — {r.sub}</span>}
          </li>
        ))}
      </ul>
    )}
    <div className="flex flex-wrap items-end gap-2.5 border-t border-border bg-surface-2/60 px-3.5 py-3">
      {form}
    </div>
  </div>
);

const Ctl = ({ label, children }: { label: string; children: ReactNode }) => (
  <label className="flex flex-col gap-1">
    <span className="text-[12px] font-semibold text-ink-secondary">{label}</span>
    {children}
  </label>
);
const Inp = ({ value, onChange, placeholder, width }: {
  value: string; onChange: (v: string) => void; placeholder?: string; width?: number;
}) => (
  <input type="text" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
    style={{ ...selStyle, width: width ?? 150 }} />
);
const selStyle: CSSProperties = {
  minHeight: 38, padding: '0 10px', borderRadius: 8, border: '1px solid var(--hz-c-border)',
  background: 'var(--hz-c-surface)', color: 'var(--hz-c-ink)', fontSize: 13,
};

export default ThreePLCompanies;
