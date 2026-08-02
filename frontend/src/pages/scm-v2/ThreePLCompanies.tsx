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

import { useState, type ReactNode, type CSSProperties } from 'react';
import { Button } from '@2990s/design-system';
import { Building2, Plus, Trash2, Pencil, Check, X, ChevronRight, ChevronDown } from 'lucide-react';
import { PageHeader } from '../../components/Layout';
import {
  useThreePLCompanies,
  useThreePLFleet,
  useCreateThreePLCompany,
  useUpdateThreePLCompany,
  useDeleteThreePLCompany,
  type ThreePLCompanyRow,
} from '../../vendor/scm/lib/threepl-companies-queries';
import { useCreateDriver } from '../../vendor/scm/lib/drivers-queries';
import { useCreateHelper } from '../../vendor/scm/lib/helpers-queries';
import { useCreateLorry, LORRY_TYPES, LORRY_TYPE_LABEL, type LorryType } from '../../vendor/scm/lib/lorries-queries';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

const BLANK = {
  name: '', registrationNo: '', contactName: '', contactPhone: '',
  officePhone: '', email: '', address: '',
};
type Particulars = typeof BLANK;

export const ThreePLCompanies = ({ embedded = false }: { embedded?: boolean } = {}) => {
  const companies = useThreePLCompanies();
  const createCo = useCreateThreePLCompany();
  const notify = useNotify();

  const [form, setForm] = useState<Particulars>(BLANK);
  const [open, setOpen] = useState<string | null>(null);
  const set = (k: keyof Particulars) => (v: string) => setForm((p) => ({ ...p, [k]: v }));

  const submit = () => {
    if (!form.name.trim()) { notify({ title: 'Name required', body: 'Give the 3PL company a name.', tone: 'error' }); return; }
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
      },
      {
        onSuccess: () => {
          setForm(BLANK);
          notify({ title: 'Company added', body: 'Open it to register its lorries, drivers and helpers.', tone: 'info' });
        },
        onError: (err) => notify({ title: 'Could not add', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' }),
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

      {/* Register a carrier — particulars only; the fleet goes in after it exists. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-end', padding: '14px 16px', borderRadius: 10, background: 'var(--bg-subtle, rgba(0,0,0,0.03))' }}>
        <Ctl label="Company name"><Inp value={form.name} onChange={set('name')} placeholder="e.g. ABC Logistics Sdn Bhd" width={220} /></Ctl>
        <Ctl label="SSM / registration no"><Inp value={form.registrationNo} onChange={set('registrationNo')} placeholder="e.g. 202301012345" width={170} /></Ctl>
        <Ctl label="Contact person"><Inp value={form.contactName} onChange={set('contactName')} placeholder="Name" width={150} /></Ctl>
        <Ctl label="Contact phone"><Inp value={form.contactPhone} onChange={set('contactPhone')} placeholder="01x-xxx xxxx" width={140} /></Ctl>
        <Ctl label="Office phone"><Inp value={form.officePhone} onChange={set('officePhone')} placeholder="03-xxxx xxxx" width={140} /></Ctl>
        <Ctl label="Email"><Inp value={form.email} onChange={set('email')} placeholder="ops@carrier.com" width={180} /></Ctl>
        <Ctl label="Address"><Inp value={form.address} onChange={set('address')} placeholder="Registered address" width={240} /></Ctl>
        <Button variant="primary" size="md" onClick={submit} disabled={createCo.isPending}>
          <Plus {...ICON} />
          <span>{createCo.isPending ? 'Saving…' : 'Add company'}</span>
        </Button>
      </div>

      <div style={{ borderRadius: 10, border: '1px solid var(--border, rgba(0,0,0,0.12))', overflow: 'hidden' }}>
        {companies.isLoading ? (
          <p style={{ padding: '12px 16px', fontSize: 'var(--fs-13)', color: 'var(--fg-muted)' }}>Loading…</p>
        ) : rows.length === 0 ? (
          <p style={{ padding: '12px 16px', fontSize: 'var(--fs-13)', color: 'var(--fg-muted)' }}>
            No 3PL companies yet. Register one above, then open it to add its lorries and crew.
          </p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-13)' }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--fg-muted)' }}>
                  <Th></Th><Th>Company</Th><Th>SSM</Th><Th>Contact</Th><Th>Office</Th><Th>Fleet</Th><Th>Active</Th><Th></Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <CompanyRow
                    key={r.id}
                    row={r}
                    open={open === r.id}
                    onToggleOpen={() => setOpen((p) => (p === r.id ? null : r.id))}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
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
  const [form, setForm] = useState<Particulars>({
    name: row.name,
    registrationNo: row.registrationNo ?? '',
    contactName: row.contactName ?? '',
    contactPhone: row.contactPhone ?? '',
    officePhone: row.officePhone ?? '',
    email: row.email ?? '',
    address: row.address ?? '',
  });
  const set = (k: keyof Particulars) => (v: string) => setForm((p) => ({ ...p, [k]: v }));

  const save = () => {
    if (!form.name.trim()) { notify({ title: 'Name required', tone: 'error' }); return; }
    const trimmed = (v: string) => v.trim() || null;
    update.mutate(
      {
        id: row.id, name: form.name.trim(),
        registrationNo: trimmed(form.registrationNo), contactName: trimmed(form.contactName),
        contactPhone: trimmed(form.contactPhone), officePhone: trimmed(form.officePhone),
        email: trimmed(form.email), address: trimmed(form.address),
      },
      { onSuccess: () => setEditing(false), onError: (err) => notify({ title: 'Could not save', body: err instanceof Error ? err.message : '', tone: 'error' }) },
    );
  };

  const remove = async () => {
    const total = row.lorryCount + row.driverCount + row.helperCount;
    if (!(await askConfirm({
      title: 'Delete this 3PL company?',
      body: `${row.name} — its ${total} fleet record(s) are detached, not deleted.`,
      confirmLabel: 'Delete',
    }))) return;
    del.mutate(row.id, { onError: (err) => notify({ title: 'Could not delete', body: err instanceof Error ? err.message : '', tone: 'error' }) });
  };

  if (editing) {
    return (
      <tr style={{ borderTop: '1px solid var(--border, rgba(0,0,0,0.06))' }}>
        <Td></Td>
        <Td><Inp value={form.name} onChange={set('name')} width={170} /></Td>
        <Td><Inp value={form.registrationNo} onChange={set('registrationNo')} width={140} /></Td>
        <Td>
          <div style={{ display: 'flex', gap: 4 }}>
            <Inp value={form.contactName} onChange={set('contactName')} width={110} />
            <Inp value={form.contactPhone} onChange={set('contactPhone')} width={120} />
          </div>
        </Td>
        <Td><Inp value={form.officePhone} onChange={set('officePhone')} width={120} /></Td>
        <Td><Inp value={form.email} onChange={set('email')} width={150} /></Td>
        <Td><Inp value={form.address} onChange={set('address')} width={160} /></Td>
        <Td>
          <div style={{ display: 'inline-flex', gap: 4 }}>
            <Button variant="primary" size="sm" onClick={save} disabled={update.isPending}><Check {...ICON} /><span>Save</span></Button>
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)}><X {...ICON} /></Button>
          </div>
        </Td>
      </tr>
    );
  }

  return (
    <>
      <tr style={{ borderTop: '1px solid var(--border, rgba(0,0,0,0.06))' }}>
        <Td>
          <button onClick={onToggleOpen} title={open ? 'Collapse' : 'Open fleet'}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--fg-muted)', padding: 2 }}>
            {open ? <ChevronDown {...ICON} /> : <ChevronRight {...ICON} />}
          </button>
        </Td>
        <Td><strong>{row.name}</strong></Td>
        <Td>{row.registrationNo ?? '—'}</Td>
        <Td>{row.contactName ? `${row.contactName}${row.contactPhone ? ` · ${row.contactPhone}` : ''}` : (row.contactPhone ?? '—')}</Td>
        <Td>{row.officePhone ?? '—'}</Td>
        <Td>
          <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
            {row.lorryCount} lorries · {row.driverCount} drivers · {row.helperCount} helpers
          </span>
        </Td>
        <Td>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={row.isActive} disabled={update.isPending}
              onChange={() => update.mutate({ id: row.id, isActive: !row.isActive }, {
                onError: (err) => notify({ title: 'Could not update', body: err instanceof Error ? err.message : '', tone: 'error' }),
              })} />
            <span style={{ fontSize: 'var(--fs-12)', color: row.isActive ? 'var(--c-secondary-a, inherit)' : 'var(--fg-muted)' }}>{row.isActive ? 'Active' : 'Inactive'}</span>
          </label>
        </Td>
        <Td>
          <div style={{ display: 'inline-flex', gap: 4 }}>
            <Button variant="ghost" size="sm" onClick={() => setEditing(true)}><Pencil {...ICON} /><span>Edit</span></Button>
            <Button variant="ghost" size="sm" onClick={remove} disabled={del.isPending}><Trash2 {...ICON} /></Button>
          </div>
        </Td>
      </tr>
      {open && (
        <tr>
          <td colSpan={8} style={{ padding: '0 12px 14px 40px', background: 'var(--bg-subtle, rgba(0,0,0,0.02))' }}>
            <CarrierFleet companyId={row.id} companyName={row.name} />
          </td>
        </tr>
      )}
    </>
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

  const fail = (err: unknown) => notify({ title: 'Could not add', body: err instanceof Error ? err.message : '', tone: 'error' });
  const num = (v: string) => (v.trim() === '' ? null : Number(v));

  const addLorry = () => {
    if (!plate.trim()) { notify({ title: 'Plate required', tone: 'error' }); return; }
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
      notify({ title: 'Name and phone are required', tone: 'error' }); return;
    }
    createDriver.mutate(
      { name: drv.name.trim(), phone: drv.phone.trim(), icNumber: drv.ic.trim() || undefined, threeplCompanyId: companyId },
      { onSuccess: () => { setDrv({ name: '', phone: '', ic: '' }); void fleet.refetch(); }, onError: fail },
    );
  };

  const addHelper = () => {
    if (!hlp.name.trim()) { notify({ title: 'Name is required', tone: 'error' }); return; }
    createHelper.mutate(
      { name: hlp.name.trim(), contact: hlp.contact.trim() || undefined, icNumber: hlp.ic.trim() || undefined, threeplCompanyId: companyId },
      { onSuccess: () => { setHlp({ name: '', contact: '', ic: '' }); void fleet.refetch(); }, onError: fail },
    );
  };

  const d = fleet.data;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingTop: 12 }}>
      <span style={{ fontSize: 'var(--fs-11)', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--fg-muted)' }}>
        {companyName} — fleet
      </span>

      <FleetBlock title="Lorries" empty="No lorries registered for this carrier."
        rows={(d?.lorries ?? []).map((l) => ({
          id: l.id,
          main: l.plate,
          sub: [l.type, l.capacity_m3 != null ? `${l.capacity_m3} m3` : null,
            l.length_ft && l.width_ft && l.height_ft ? `${l.length_ft} x ${l.width_ft} x ${l.height_ft} ft` : null]
            .filter(Boolean).join(' · '),
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
          sub: [x.driver_code, x.phone, x.ic_number].filter(Boolean).join(' · '),
        }))}
        loading={fleet.isLoading}
        form={
          <>
            <Ctl label="Name"><Inp value={drv.name} onChange={(v) => setDrv((p) => ({ ...p, name: v }))} width={150} /></Ctl>
            <Ctl label="Phone"><Inp value={drv.phone} onChange={(v) => setDrv((p) => ({ ...p, phone: v }))} placeholder="01x-xxx xxxx" width={130} /></Ctl>
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
          sub: [x.helper_code, x.contact, x.ic_number].filter(Boolean).join(' · '),
        }))}
        loading={fleet.isLoading}
        form={
          <>
            <Ctl label="Name"><Inp value={hlp.name} onChange={(v) => setHlp((p) => ({ ...p, name: v }))} width={150} /></Ctl>
            <Ctl label="Contact"><Inp value={hlp.contact} onChange={(v) => setHlp((p) => ({ ...p, contact: v }))} placeholder="01x-xxx xxxx" width={130} /></Ctl>
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
  rows: Array<{ id: string; main: string; sub: string }>;
  empty: string;
  loading: boolean;
  form: ReactNode;
}) => (
  <div style={{ borderRadius: 8, border: '1px solid var(--border, rgba(0,0,0,0.1))', background: 'var(--bg, #fff)', overflow: 'hidden' }}>
    <div style={{ padding: '8px 12px', fontSize: 'var(--fs-12)', fontWeight: 600, borderBottom: '1px solid var(--border, rgba(0,0,0,0.06))' }}>
      {title} <span style={{ fontWeight: 400, color: 'var(--fg-muted)' }}>({rows.length})</span>
    </div>
    {loading ? (
      <p style={{ padding: '8px 12px', fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>Loading…</p>
    ) : rows.length === 0 ? (
      <p style={{ padding: '8px 12px', fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>{empty}</p>
    ) : (
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {rows.map((r) => (
          <li key={r.id} style={{ padding: '6px 12px', borderBottom: '1px solid var(--border, rgba(0,0,0,0.04))', fontSize: 'var(--fs-12)' }}>
            <strong>{r.main}</strong>
            {r.sub && <span style={{ color: 'var(--fg-muted)' }}> — {r.sub}</span>}
          </li>
        ))}
      </ul>
    )}
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end', padding: '10px 12px', borderTop: '1px solid var(--border, rgba(0,0,0,0.06))' }}>
      {form}
    </div>
  </div>
);

const Th = ({ children }: { children?: ReactNode }) => (
  <th style={{ padding: '8px 12px', fontWeight: 500 }}>{children}</th>
);
const Td = ({ children }: { children?: ReactNode }) => (
  <td style={{ padding: '8px 12px' }}>{children}</td>
);
const Ctl = ({ label, children }: { label: string; children: ReactNode }) => (
  <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
    <span style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>{label}</span>
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
  padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border, rgba(0,0,0,0.2))',
  background: 'var(--bg, #fff)', color: 'var(--fg, inherit)', fontSize: 'var(--fs-13)',
};

export default ThreePLCompanies;
