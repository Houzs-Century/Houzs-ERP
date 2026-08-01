// ----------------------------------------------------------------------------
// 3PL Companies (WS4a) — the master where the owner registers a 3PL carrier
// company. A 3PL owns several lorries; a solo operator is a one-lorry company.
// Register the company here, then attach its lorries from the lorry drawer
// (Fleet > a lorry > 3PL company). WS4b will price by company from this list.
//
// Route /scm/threepl-companies, nav "3PL Companies" under Transportation >
// Maintenance. Backed by scm.threepl_companies (mig 0210). Mirrors the small
// masters (Driver Leave / Residence Rules): create form + table + inline edit.
// ----------------------------------------------------------------------------

import { useState, type ReactNode, type CSSProperties } from 'react';
import { Button } from '@2990s/design-system';
import { Building2, Plus, Trash2, Pencil, Check, X } from 'lucide-react';
import { PageHeader } from '../../components/Layout';
import {
  useThreePLCompanies,
  useCreateThreePLCompany,
  useUpdateThreePLCompany,
  useDeleteThreePLCompany,
  type ThreePLCompanyRow,
} from '../../vendor/scm/lib/threepl-companies-queries';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

export const ThreePLCompanies = ({ embedded = false }: { embedded?: boolean } = {}) => {
  const companies = useThreePLCompanies();
  const createCo = useCreateThreePLCompany();
  const notify = useNotify();

  const [name, setName] = useState('');
  const [contactName, setContactName] = useState('');
  const [contactPhone, setContactPhone] = useState('');

  const submit = () => {
    if (!name.trim()) { notify({ title: 'Name required', body: 'Give the 3PL company a name.', tone: 'error' }); return; }
    createCo.mutate(
      { name: name.trim(), contactName: contactName.trim() || null, contactPhone: contactPhone.trim() || null },
      {
        onSuccess: () => { setName(''); setContactName(''); setContactPhone(''); notify({ title: 'Company added', body: 'Attach its lorries from the lorry drawer.', tone: 'info' }); },
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
          description="Register each outsourced (3PL) carrier company. A solo operator is a one-lorry company. Attach a company's lorries from the lorry drawer (Fleet); the delivery rate card is set per company."
        />
      )}

      {/* Create */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-end', padding: '14px 16px', borderRadius: 10, background: 'var(--bg-subtle, rgba(0,0,0,0.03))' }}>
        <Ctl label="Company name">
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. ABC Logistics" style={{ ...selStyle, minWidth: 200 }} />
        </Ctl>
        <Ctl label="Contact (optional)">
          <input type="text" value={contactName} onChange={(e) => setContactName(e.target.value)} placeholder="Name" style={{ ...selStyle, width: 160 }} />
        </Ctl>
        <Ctl label="Phone (optional)">
          <input type="text" value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} placeholder="01x-xxxxxxx" style={{ ...selStyle, width: 150 }} />
        </Ctl>
        <Button variant="primary" size="md" onClick={submit} disabled={createCo.isPending}>
          <Plus {...ICON} />
          <span>{createCo.isPending ? 'Saving…' : 'Add company'}</span>
        </Button>
      </div>

      {/* List */}
      <div style={{ borderRadius: 10, border: '1px solid var(--border, rgba(0,0,0,0.12))', overflow: 'hidden' }}>
        {companies.isLoading ? (
          <p style={{ padding: '12px 16px', fontSize: 'var(--fs-13)', color: 'var(--fg-muted)' }}>Loading…</p>
        ) : rows.length === 0 ? (
          <p style={{ padding: '12px 16px', fontSize: 'var(--fs-13)', color: 'var(--fg-muted)' }}>
            No 3PL companies yet. Add one above, then attach its lorries from the lorry drawer.
          </p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-13)' }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--fg-muted)' }}>
                  <Th>Company</Th><Th>Contact</Th><Th>Phone</Th><Th>Lorries</Th><Th>Active</Th><Th></Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => <CompanyRow key={r.id} row={r} />)}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
        <Building2 {...ICON} />
        <span>Deleting a company detaches its lorries (they are not deleted). Set a lorry&rsquo;s company on the lorry drawer under Fleet.</span>
      </div>
    </div>
  );
};

const CompanyRow = ({ row }: { row: ThreePLCompanyRow }) => {
  const update = useUpdateThreePLCompany();
  const del = useDeleteThreePLCompany();
  const notify = useNotify();
  const askConfirm = useConfirm();

  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(row.name);
  const [contactName, setContactName] = useState(row.contactName ?? '');
  const [contactPhone, setContactPhone] = useState(row.contactPhone ?? '');

  const save = () => {
    if (!name.trim()) { notify({ title: 'Name required', tone: 'error' }); return; }
    update.mutate(
      { id: row.id, name: name.trim(), contactName: contactName.trim() || null, contactPhone: contactPhone.trim() || null },
      { onSuccess: () => setEditing(false), onError: (err) => notify({ title: 'Could not save', body: err instanceof Error ? err.message : '', tone: 'error' }) },
    );
  };

  const toggleActive = () => {
    update.mutate({ id: row.id, isActive: !row.isActive }, { onError: (err) => notify({ title: 'Could not update', body: err instanceof Error ? err.message : '', tone: 'error' }) });
  };

  const remove = async () => {
    if (!(await askConfirm({ title: 'Delete this 3PL company?', body: `${row.name} — its ${row.lorryCount} lorr${row.lorryCount === 1 ? 'y is' : 'ies are'} detached (not deleted).`, confirmLabel: 'Delete' }))) return;
    del.mutate(row.id, { onError: (err) => notify({ title: 'Could not delete', body: err instanceof Error ? err.message : '', tone: 'error' }) });
  };

  if (editing) {
    return (
      <tr style={{ borderTop: '1px solid var(--border, rgba(0,0,0,0.06))' }}>
        <Td><input value={name} onChange={(e) => setName(e.target.value)} style={{ ...selStyle, width: 180 }} /></Td>
        <Td><input value={contactName} onChange={(e) => setContactName(e.target.value)} style={{ ...selStyle, width: 140 }} /></Td>
        <Td><input value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} style={{ ...selStyle, width: 130 }} /></Td>
        <Td>{row.lorryCount}</Td>
        <Td>{row.isActive ? 'Active' : 'Inactive'}</Td>
        <Td>
          <div style={{ display: 'inline-flex', gap: 4 }}>
            <Button variant="primary" size="sm" onClick={save} disabled={update.isPending}><Check {...ICON} /><span>Save</span></Button>
            <Button variant="ghost" size="sm" onClick={() => { setEditing(false); setName(row.name); setContactName(row.contactName ?? ''); setContactPhone(row.contactPhone ?? ''); }}><X {...ICON} /></Button>
          </div>
        </Td>
      </tr>
    );
  }

  return (
    <tr style={{ borderTop: '1px solid var(--border, rgba(0,0,0,0.06))' }}>
      <Td><strong>{row.name}</strong></Td>
      <Td>{row.contactName ?? '—'}</Td>
      <Td>{row.contactPhone ?? '—'}</Td>
      <Td>{row.lorryCount}</Td>
      <Td>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <input type="checkbox" checked={row.isActive} onChange={toggleActive} disabled={update.isPending} />
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
  );
};

const Th = ({ children }: { children?: ReactNode }) => (
  <th style={{ padding: '8px 12px', fontWeight: 500 }}>{children}</th>
);
const Td = ({ children }: { children: ReactNode }) => (
  <td style={{ padding: '8px 12px' }}>{children}</td>
);
const Ctl = ({ label, children }: { label: string; children: ReactNode }) => (
  <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
    <span style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>{label}</span>
    {children}
  </label>
);
const selStyle: CSSProperties = {
  padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border, rgba(0,0,0,0.2))',
  background: 'var(--bg, #fff)', color: 'var(--fg, inherit)', fontSize: 'var(--fs-13)',
};

export default ThreePLCompanies;
