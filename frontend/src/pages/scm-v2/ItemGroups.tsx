// ----------------------------------------------------------------------------
// Item Groups tab — the product-group ↔ ledger-account registry the posting
// rules read (GL redesign item 1, owner 2026-09-05).
//
// One row per group × four account slots, for the ACTIVE company. A group the
// company has not bound yet shows the SUGGESTED defaults pre-filled and marked
// 建议 — nothing is written until the owner presses Save: 他要求"绑定表先给我
// 过目,我改完确认才生效", and this screen IS that sign-off, row by row.
//
// New groups are born HERE and born BOUND (create refuses without all four
// accounts) — the server extends the category enums in the same breath, so a
// group created here is immediately pickable on a product.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { getActiveCompanyId } from '../../lib/activeCompany';
import { PiBackfillCard } from './PiBackfill';
import { SearchCombo, type ComboOption } from '../../vendor/scm/components/SearchCombo';
import { useAccounts } from '../../vendor/scm/lib/accounting-queries';
import {
  useItemGroups, useCreateItemGroup, useBindItemGroup, usePatchItemGroup,
  type ItemGroupBinding,
} from './accounting-phase1-queries';

/* Each slot names the side of the ledger it may bind to — the purchase slots
   take EXPENSE accounts, the sales slots INCOME. The picker filters on this,
   so CAPITAL and the bank rows never crowd the list (owner 2026-09-05). */
const SLOTS: Array<{ key: keyof ItemGroupBinding; label: string; wants: 'EXPENSE' | 'INCOME' }> = [
  { key: 'purchase', label: 'Purchase', wants: 'EXPENSE' },
  { key: 'sales', label: 'Sales', wants: 'INCOME' },
  { key: 'salesReturn', label: 'Sales Return', wants: 'INCOME' },
  { key: 'purchaseReturn', label: 'Purchase Return', wants: 'EXPENSE' },
];

/* AutoCount-style section headers inside the picker (owner 2026-09-05: 不能
   这样做一个header 分类吗?不然有时分不清楚) — the same code boundaries the
   standard P&L reads (6xx = cost of sales, accounting-reports.ts). Purely how
   the list is SHOWN; the account rows stay the law. */
const sectionOf = (code: string, wants: 'EXPENSE' | 'INCOME'): string => {
  if (wants === 'EXPENSE') return code.startsWith('6') ? 'Cost of goods sold' : 'Expenses';
  if (code.startsWith('50')) return 'Sales';
  if (code.startsWith('51') || code.startsWith('52')) return 'Sales adjustments';
  return 'Other incomes';
};
/* Widened value type: noUncheckedIndexedAccess is off, and an unranked
   section is a real case (it sorts last), not a type impossibility. */
const SECTION_RANK: Record<string, number | undefined> = {
  'Sales': 0, 'Sales adjustments': 1, 'Other incomes': 2,
  'Cost of goods sold': 0, 'Expenses': 1,
};

/* The defaults the owner approved in outline (2026-09-05): sofa/bedding/dining
   purchases into their 601 children, bedlines into 602; furniture sales into
   501, bedlines & accessories into 502; returns into 510 / 612. SUGGESTIONS
   ONLY — they sit unsaved in the form until he presses Save. */
export const SUGGESTED: Record<string, ItemGroupBinding> = {
  SOFA:      { purchase: '601-0003', sales: '501-0000', salesReturn: '510-0000', purchaseReturn: '612-0000' },
  BEDFRAME:  { purchase: '601-0001', sales: '501-0000', salesReturn: '510-0000', purchaseReturn: '612-0000' },
  MATTRESS:  { purchase: '601-0001', sales: '501-0000', salesReturn: '510-0000', purchaseReturn: '612-0000' },
  DINING:    { purchase: '601-0002', sales: '501-0000', salesReturn: '510-0000', purchaseReturn: '612-0000' },
  BEDLINES:  { purchase: '602-0000', sales: '502-0000', salesReturn: '510-0000', purchaseReturn: '612-0000' },
  ACCESSORY: { purchase: '601-0004', sales: '502-0000', salesReturn: '510-0000', purchaseReturn: '612-0000' },
  DIFFUSER:  { purchase: '601-0004', sales: '501-0000', salesReturn: '510-0000', purchaseReturn: '612-0000' },
  CARPET:    { purchase: '601-0004', sales: '501-0000', salesReturn: '510-0000', purchaseReturn: '612-0000' },
  SERVICE:   { purchase: '601-0004', sales: '501-0000', salesReturn: '510-0000', purchaseReturn: '612-0000' },
};

const EMPTY: ItemGroupBinding = { purchase: '', sales: '', salesReturn: '', purchaseReturn: '' };

/* Index reads through here so a missing key TYPES as undefined — the compiler
   has noUncheckedIndexedAccess off, and "absent binding" is this screen's
   whole subject matter. */
const pick = <T,>(rec: Record<string, T>, key: string): T | undefined => rec[key];

const cardStyle: React.CSSProperties = {
  padding: 'var(--space-4)',
  background: 'var(--c-cream)',
  border: '1px solid var(--c-line, rgba(34,31,32,0.12))',
  borderRadius: 'var(--radius-md)',
};
const btnStyle = (primary?: boolean, disabled?: boolean): React.CSSProperties => ({
  padding: '5px 12px',
  border: '1px solid var(--c-line, rgba(34,31,32,0.2))',
  borderRadius: 'var(--radius-sm, 6px)',
  background: primary ? 'var(--c-ink)' : 'transparent',
  color: primary ? 'var(--c-cream)' : 'var(--c-ink)',
  fontSize: 'var(--fs-13)',
  cursor: disabled ? 'not-allowed' : 'pointer',
  opacity: disabled ? 0.5 : 1,
});
const fieldStyle: React.CSSProperties = {
  padding: '5px 8px',
  border: '1px solid var(--c-line, rgba(34,31,32,0.2))',
  borderRadius: 'var(--radius-sm, 6px)',
  fontSize: 'var(--fs-13)',
  background: 'white',
};
const softText: React.CSSProperties = { fontSize: 'var(--fs-13)', color: 'var(--text-soft, #8a8578)' };

export const ItemGroupsTab = () => {
  const groupsQ = useItemGroups();
  const accountsQ = useAccounts();
  const create = useCreateItemGroup();
  const bind = useBindItemGroup();
  const patchGroup = usePatchItemGroup();

  const companies = groupsQ.data?.companies ?? [];
  const activeCo = getActiveCompanyId() ?? companies.at(0)?.id ?? null;
  const coKey = activeCo == null ? '' : String(activeCo);

  /* One option list per ledger side, sectioned the AutoCount way: a purchase
     slot sees only EXPENSE accounts (Cost of goods sold first, then
     Expenses), a sales slot only INCOME (Sales / Sales adjustments / Other
     incomes). 397 accounts collapse to the relevant page. */
  const optionsByWants = useMemo(() => {
    const build = (wants: 'EXPENSE' | 'INCOME'): ComboOption[] => (accountsQ.data?.accounts ?? [])
      .filter((a) => a.is_active !== false && a.account_type === wants)
      .map((a) => ({
        value: a.account_code,
        label: `${a.account_code} — ${a.account_name}`,
        group: sectionOf(a.account_code, wants),
      }))
      .sort((x, y) => ((SECTION_RANK[x.group] ?? 9) - (SECTION_RANK[y.group] ?? 9)) || x.value.localeCompare(y.value));
    return { EXPENSE: build('EXPENSE'), INCOME: build('INCOME') };
  }, [accountsQ.data]);

  /* Unsaved edits per group. A group with no saved binding starts from the
     SUGGESTED defaults (marked as such) — the sign-off flow. */
  const [drafts, setDrafts] = useState<Record<string, ItemGroupBinding>>({});
  const [showNew, setShowNew] = useState(false);

  if (groupsQ.isLoading) return <div style={softText}>Loading…</div>;
  if (groupsQ.isError || !groupsQ.data) return <div style={softText}>Item groups did not load. Refresh to retry.</div>;
  if (activeCo == null) return <div style={softText}>No company grants resolve for this session.</div>;

  const rows = groupsQ.data.groups;

  const draftOf = (code: string, saved: ItemGroupBinding | undefined): ItemGroupBinding =>
    pick(drafts, code) ?? saved ?? pick(SUGGESTED, code) ?? EMPTY;

  const setSlot = (code: string, saved: ItemGroupBinding | undefined, key: keyof ItemGroupBinding, value: string) => {
    setDrafts((d) => ({ ...d, [code]: { ...draftOf(code, saved), [key]: value } }));
  };

  const complete = (b: ItemGroupBinding) => SLOTS.every((s) => b[s.key].trim() !== '');
  const differs = (a: ItemGroupBinding, b: ItemGroupBinding | undefined) =>
    !b || SLOTS.some((s) => a[s.key] !== b[s.key]);

  return (
    <div className="space-y-3">
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
        <div style={softText}>
          Binding for company <b>{companies.find((co) => co.id === activeCo)?.code ?? activeCo}</b> — a group must be
          bound here before its purchases can post. 灰字 = 建议,按 Save 才生效.
        </div>
        <button type="button" style={btnStyle(true)} onClick={() => setShowNew(true)}>New group</button>
      </div>

      <div style={{ ...cardStyle, padding: 0, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-13)' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: '8px 10px' }}>Group</th>
              {SLOTS.map((s) => <th key={s.key} style={{ textAlign: 'left', padding: '8px 10px', minWidth: 180 }}>{s.label}</th>)}
              <th style={{ textAlign: 'left', padding: '8px 10px' }}>Status</th>
              <th style={{ padding: '8px 10px' }} />
            </tr>
          </thead>
          <tbody>
            {rows.map((g) => {
              const saved = pick(g.bindings, coKey);
              const draft = draftOf(g.code, saved);
              const dirty = differs(draft, saved);
              const suggested = !saved && pick(drafts, g.code) === undefined && pick(SUGGESTED, g.code) !== undefined;
              return (
                <tr key={g.code} style={{ borderTop: '1px solid var(--border-weak, #e3e1da)', opacity: g.isActive ? 1 : 0.55 }}>
                  <td style={{ padding: '6px 10px', whiteSpace: 'nowrap' }}>
                    <b>{g.code}</b>
                    <div style={softText}>{g.name}{!g.isActive && ' · off'}</div>
                  </td>
                  {SLOTS.map((s) => (
                    <td key={s.key} style={{ padding: '6px 10px' }}>
                      <SearchCombo
                        options={optionsByWants[s.wants]}
                        value={draft[s.key]}
                        onChange={(v) => setSlot(g.code, saved, s.key, v)}
                        aria-label={`${g.code} ${s.label} account`}
                        placeholder="— pick account —"
                      />
                    </td>
                  ))}
                  <td style={{ padding: '6px 10px', whiteSpace: 'nowrap' }}>
                    {saved && !dirty && <span style={{ color: 'var(--c-good, #2f5d4f)' }}>bound</span>}
                    {suggested && <span style={softText}>建议 · unsaved</span>}
                    {!saved && !suggested && !complete(draft) && <span style={{ color: 'var(--c-danger, #a33)' }}>unbound</span>}
                    {dirty && !suggested && (saved || complete(draft)) && <span style={softText}>edited · unsaved</span>}
                  </td>
                  <td style={{ padding: '6px 10px', whiteSpace: 'nowrap' }}>
                    <button
                      type="button"
                      style={btnStyle(true, !complete(draft) || !dirty || bind.isPending)}
                      disabled={!complete(draft) || !dirty || bind.isPending}
                      onClick={() => bind.mutate(
                        { code: g.code, companyId: activeCo, accounts: draft },
                        { onSuccess: () => setDrafts((d) => { const { [g.code]: _gone, ...rest } = d; return rest; }) },
                      )}
                    >
                      Save
                    </button>{' '}
                    <button
                      type="button"
                      style={btnStyle(false, patchGroup.isPending)}
                      disabled={patchGroup.isPending}
                      title={g.isActive ? 'Hide from new products (bindings stay)' : 'Offer to new products again'}
                      onClick={() => patchGroup.mutate({ code: g.code, isActive: !g.isActive })}
                    >
                      {g.isActive ? 'Turn off' : 'Turn on'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {(bind.isError || create.isError || patchGroup.isError) && (
        <div style={{ fontSize: 'var(--fs-13)', color: 'var(--c-danger, #a33)' }}>
          {String(((bind.error ?? create.error ?? patchGroup.error) as { message?: string } | null)?.message ?? 'The change was not saved.')}
        </div>
      )}

      {showNew && (
        <NewGroupDialog
          optionsByWants={optionsByWants}
          pending={create.isPending}
          onClose={() => setShowNew(false)}
          onCreate={(body) => create.mutate(
            { ...body, companyId: activeCo },
            { onSuccess: () => setShowNew(false) },
          )}
        />
      )}

      {/* Bindings feed the backfill — the historical PIs repost right where
          the groups were just signed off (item 3's door, owner-pressed). */}
      <PiBackfillCard />
    </div>
  );
};

/* ── New group — born bound ──────────────────────────────────────────────── */
const NewGroupDialog = ({
  optionsByWants, pending, onClose, onCreate,
}: {
  optionsByWants: Record<'EXPENSE' | 'INCOME', ComboOption[]>;
  pending: boolean;
  onClose: () => void;
  onCreate: (body: { code: string; name: string; accounts: ItemGroupBinding }) => void;
}) => {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [accounts, setAccounts] = useState<ItemGroupBinding>(EMPTY);
  const codeOk = /^[A-Za-z][A-Za-z0-9_]{1,29}$/.test(code.trim());
  const ready = codeOk && name.trim() !== '' && SLOTS.every((s) => accounts[s.key].trim() !== '');

  return (
    <div role="presentation" style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.28)', zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div role="dialog" aria-label="New item group" style={{ ...cardStyle, background: 'var(--c-paper, #fff)', width: 'min(440px, 92vw)' }}>
        <div className="space-y-2">
          <b>New group</b>
          <div style={softText}>四个 account 都绑了才能 create — 没绑的 group 不给过账。</div>
          <input style={{ ...fieldStyle, width: '100%' }} placeholder="Code (e.g. CURTAIN)" value={code}
            aria-label="Group code" onChange={(e) => setCode(e.target.value)} />
          <input style={{ ...fieldStyle, width: '100%' }} placeholder="Name" value={name}
            aria-label="Group name" onChange={(e) => setName(e.target.value)} />
          {SLOTS.map((s) => (
            <div key={s.key}>
              <div style={softText}>{s.label}</div>
              <SearchCombo options={optionsByWants[s.wants]} value={accounts[s.key]}
                onChange={(v) => setAccounts((a) => ({ ...a, [s.key]: v }))}
                aria-label={`New group ${s.label} account`} placeholder="— pick account —" />
            </div>
          ))}
          <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end' }}>
            <button type="button" style={btnStyle(false)} onClick={onClose}>Cancel</button>
            <button type="button" style={btnStyle(true, !ready || pending)} disabled={!ready || pending}
              onClick={() => onCreate({ code: code.trim().toUpperCase(), name: name.trim(), accounts })}>
              Create
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
