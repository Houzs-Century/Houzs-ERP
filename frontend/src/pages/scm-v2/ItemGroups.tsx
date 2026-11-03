// ----------------------------------------------------------------------------
// Item Groups tab — the product-group ↔ ledger-account registry the posting
// rules read (GL redesign item 1, owner 2026-09-05), in the owner's Claude
// Design redesign (Finance-1a-Setup, batch 6 §6.2).
//
// One row per group × four account slots, for the ACTIVE company. A group the
// company has not bound yet shows the SUGGESTED defaults pre-filled and marked
// "Suggested · not saved" — nothing is written until the owner presses Save:
// 他要求"绑定表先给我过目,我改完确认才生效", and this screen IS that sign-off,
// row by row.
//
// New groups are born HERE and born BOUND (create refuses without all four
// accounts) — the server extends the category enums in the same breath, so a
// group created here is immediately pickable on a product. Turn off / Turn on
// (hide from new products, the bindings stay) sit in the row's ⋯ and its
// right-click menu.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { ChevronRight, MoreHorizontal, Plus } from 'lucide-react';
import { getActiveCompanyId } from '../../lib/activeCompany';
import { useToastOptional } from '../../hooks/useToast';
import { PiBackfillCard } from './PiBackfill';
import { SearchCombo, type ComboOption } from '../../vendor/scm/components/SearchCombo';
import { useAccounts } from '../../vendor/scm/lib/accounting-queries';
import {
  useItemGroups, useCreateItemGroup, useBindItemGroup, usePatchItemGroup,
  type ItemGroup, type ItemGroupBinding,
} from './accounting-phase1-queries';
import { Field, PopMenu, SetupModal, Skeleton, Tag, type MenuItem, type Tone } from './finance/SetupParts';
import sp from './finance/SetupParts.module.css';
import css from './ItemGroups.module.css';

/* Each slot names the side of the ledger it may bind to — the purchase slots
   take EXPENSE accounts, the sales slots INCOME. The picker filters on this,
   so CAPITAL and the bank rows never crowd the list (owner 2026-09-05). */
const SLOTS: Array<{ key: keyof ItemGroupBinding; label: string; wants: 'EXPENSE' | 'INCOME' }> = [
  { key: 'purchase', label: 'Purchase', wants: 'EXPENSE' },
  { key: 'sales', label: 'Sales', wants: 'INCOME' },
  { key: 'salesReturn', label: 'Sales return', wants: 'INCOME' },
  { key: 'purchaseReturn', label: 'Purchase return', wants: 'EXPENSE' },
];

/* The picker's section headers are the CHART's sections (owner 2026-09-05:
   不能这样做一个header 分类吗; 2026-09-06: stored on the account, his to move
   by dragging on the chart page) — read off each account row, ordered by
   the vocabulary the same API hands down. Nothing here decides a section. */
const UNSHELVED = 'Unsectioned';

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
  /* Sofa Accessory (2026-09-14): still an accessory in the books — same accounts as ACCESSORY. */
  FABRIC_ACCESSORY: { purchase: '601-0004', sales: '502-0000', salesReturn: '510-0000', purchaseReturn: '612-0000' },
};

const EMPTY: ItemGroupBinding = { purchase: '', sales: '', salesReturn: '', purchaseReturn: '' };

/* Index reads through here so a missing key TYPES as undefined — the compiler
   has noUncheckedIndexedAccess off, and "absent binding" is this screen's
   whole subject matter. */
const pick = <T,>(rec: Record<string, T>, key: string): T | undefined => rec[key];

const complete = (b: ItemGroupBinding): boolean => SLOTS.every((s) => b[s.key].trim() !== '');
const differs = (a: ItemGroupBinding, b: ItemGroupBinding): boolean => SLOTS.some((s) => a[s.key] !== b[s.key]);

/** Where a row stands, in the design's words and tones. */
type RowState = { label: string; tone: Tone; suggested: boolean; canSave: boolean; canUndo: boolean };
function rowState(saved: ItemGroupBinding | undefined, own: ItemGroupBinding | undefined, suggestion: ItemGroupBinding | undefined): RowState {
  const base = saved ?? suggestion ?? EMPTY;
  const cur = own ?? base;
  const changed = own !== undefined && differs(own, base);
  const canSave = complete(cur) && (saved === undefined || differs(cur, saved));
  const out = (label: string, tone: Tone, suggested = false): RowState => ({ label, tone, suggested, canSave, canUndo: changed });
  if (saved) return differs(cur, saved) ? out('Changed · not saved', 'warn') : out('Bound', 'info');
  if (!complete(cur)) return out('Unbound', 'late');
  if (changed || !suggestion) return out('Changed · not saved', 'warn');
  return out('Suggested · not saved', 'warn', true);
}

export const ItemGroupsTab = () => {
  const groupsQ = useItemGroups();
  const accountsQ = useAccounts();
  const create = useCreateItemGroup();
  const bind = useBindItemGroup();
  const patchGroup = usePatchItemGroup();
  const toast = useToastOptional();

  const companies = groupsQ.data?.companies ?? [];
  const activeCo = getActiveCompanyId() ?? companies.at(0)?.id ?? null;
  const coKey = activeCo == null ? '' : String(activeCo);

  /* One option list per ledger side, sectioned the AutoCount way: a purchase
     slot sees only EXPENSE accounts (Cost of goods sold first, then
     Expenses), a sales slot only INCOME (Sales / Sales adjustments / Other
     incomes). 397 accounts collapse to the relevant page. */
  const optionsByWants = useMemo(() => {
    const order = (accountsQ.data?.sections ?? []).map((s) => s.section);
    const rank = (section: string): number => {
      const i = order.indexOf(section);
      return i < 0 ? order.length : i;
    };
    const build = (wants: 'EXPENSE' | 'INCOME'): ComboOption[] => (accountsQ.data?.accounts ?? [])
      .filter((a) => a.is_active !== false && a.account_type === wants)
      .map((a) => ({
        value: a.account_code,
        label: `${a.account_code} — ${a.account_name}`,
        group: a.section ?? UNSHELVED,
      }))
      .sort((x, y) => (rank(x.group) - rank(y.group)) || x.value.localeCompare(y.value));
    return { EXPENSE: build('EXPENSE'), INCOME: build('INCOME') };
  }, [accountsQ.data]);

  /* Unsaved edits per group. A group with no saved binding starts from the
     SUGGESTED defaults (marked as such) — the sign-off flow. */
  const [drafts, setDrafts] = useState<Record<string, ItemGroupBinding>>({});
  const [showNew, setShowNew] = useState(false);
  const [menu, setMenu] = useState<{ group: ItemGroup; x: number; y: number } | null>(null);

  /* The design's header line: what the page is, and New group at the right
     (the Accounting page above owns the title). */
  const lead = (withNew: boolean) => (
    <div className={css.lead}>
      <span className={css.leadSub}>Each product group’s ledger accounts · nothing is written until a row is saved</span>
      <span className={sp.grow} />
      {withNew && (
        <button type="button" className={sp.btnSolid} onClick={() => setShowNew(true)}>
          <Plus size={14} /> New group
        </button>
      )}
    </div>
  );

  if (groupsQ.isLoading) return <div className={sp.page}>{lead(false)}<section className={sp.card}><Skeleton rows={8} label="Loading the item groups" /></section></div>;
  if (groupsQ.isError || !groupsQ.data) return <div className={sp.page}>{lead(false)}<div className={sp.problem}>Item groups did not load. Refresh to retry.</div></div>;
  if (activeCo == null) return <div className={sp.page}><div className={sp.problem}>No company grants resolve for this session.</div></div>;

  const rows = groupsQ.data.groups;
  const coCode = companies.find((co) => co.id === activeCo)?.code ?? String(activeCo);

  const draftOf = (code: string, saved: ItemGroupBinding | undefined): ItemGroupBinding =>
    pick(drafts, code) ?? saved ?? pick(SUGGESTED, code) ?? EMPTY;
  const setSlot = (code: string, saved: ItemGroupBinding | undefined, key: keyof ItemGroupBinding, value: string) => {
    setDrafts((d) => ({ ...d, [code]: { ...draftOf(code, saved), [key]: value } }));
  };
  const dropDraft = (code: string) => setDrafts((d) => { const { [code]: _gone, ...rest } = d; return rest; });
  const save = (g: ItemGroup, accounts: ItemGroupBinding) => bind.mutate(
    { code: g.code, companyId: activeCo, accounts },
    { onSuccess: () => { dropDraft(g.code); toast?.success(`${g.name} bound · its sales and purchases post to these accounts from now`); } },
  );
  const menuOf = (g: ItemGroup): MenuItem[] => [g.isActive
    ? { label: 'Turn off', title: 'Hide from new products (bindings stay)', disabled: patchGroup.isPending, onClick: () => patchGroup.mutate({ code: g.code, isActive: false }, { onSuccess: () => toast?.success(`${g.name} turned off · new products no longer offer it`) }) }
    : { label: 'Turn on', title: 'Offer to new products again', disabled: patchGroup.isPending, onClick: () => patchGroup.mutate({ code: g.code, isActive: true }, { onSuccess: () => toast?.success(`${g.name} turned on · new products offer it again`) }) }];

  return (
    <div className={sp.page}>
      {lead(true)}

      <section className={sp.card} aria-label="Item groups">
        <div className={sp.scroll}>
          <table className={`${sp.table} ${css.grid}`}>
            <thead>
              <tr>
                <th>Group</th>
                {SLOTS.map((s) => <th key={s.key}>{s.label}</th>)}
                <th>Status</th>
                <th aria-label="actions" />
              </tr>
            </thead>
            <tbody>
              {rows.map((g) => {
                const saved = pick(g.bindings, coKey);
                const own = pick(drafts, g.code);
                const st = rowState(saved, own, pick(SUGGESTED, g.code));
                const draft = draftOf(g.code, saved);
                const rowClass = [!g.isActive ? css.offRow : '', st.label !== 'Bound' ? css.unsavedRow : ''].filter(Boolean).join(' ');
                return (
                  <tr key={g.code} data-group={g.code} className={rowClass || undefined}
                    onContextMenu={(e) => { e.preventDefault(); setMenu({ group: g, x: e.clientX + 180, y: e.clientY }); }}>
                    <td className={css.groupCell}>
                      <span className={css.groupName}>{g.name}</span>
                      <span className={css.groupCode}>{g.code}{!g.isActive && ' · off for new products'}</span>
                    </td>
                    {SLOTS.map((s) => {
                      const v = draft[s.key];
                      const slotClass = !v.trim() ? css.slotEmpty : st.suggested ? css.slotSuggested : '';
                      return (
                        <td key={s.key} className={css.slotCell}>
                          <SearchCombo
                            fill
                            className={`${sp.input} ${sp.compact} ${css.slot} ${slotClass}`}
                            options={optionsByWants[s.wants]}
                            value={v}
                            onChange={(next) => setSlot(g.code, saved, s.key, next)}
                            aria-label={`${g.code} ${s.label} account`}
                            placeholder="— pick account —"
                          />
                        </td>
                      );
                    })}
                    <td><Tag tone={st.tone} dot={st.tone === 'late'}>{st.label}</Tag></td>
                    <td className={css.actCell}>
                      <span className={sp.acts}>
                        {st.canUndo && (
                          <button type="button" className={css.undo} onClick={() => dropDraft(g.code)}>Undo</button>
                        )}
                        {st.canSave && (
                          <button type="button" className={`${sp.btnPrimary} ${sp.small} ${css.save}`} disabled={bind.isPending}
                            onClick={() => save(g, draft)}>
                            Save <ChevronRight size={12} />
                          </button>
                        )}
                        <button type="button" className={sp.more} aria-label={`More for ${g.code}`} title={g.isActive ? 'Turn off' : 'Turn on'}
                          onClick={(e) => setMenu({ group: g, x: e.clientX, y: e.clientY })}>
                          <MoreHorizontal size={14} />
                        </button>
                      </span>
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr><td colSpan={SLOTS.length + 3} className={sp.empty}>No item group yet — New group opens one.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div className={sp.cardFoot}>
          For {coCode}. Purchase and purchase-return slots take cost and expense accounts; sales slots take income accounts. A
          group must be bound before its purchases can post. A group not bound yet shows the suggested accounts; nothing is
          written until you press Save on its row. A new group is born bound and is pickable on a product at once.
        </div>
      </section>

      {(bind.isError || create.isError || patchGroup.isError) && (
        <div className={sp.problem}>
          {String(((bind.error ?? create.error ?? patchGroup.error) as { message?: string } | null)?.message ?? 'The change was not saved.')}
        </div>
      )}

      {showNew && (
        <NewGroupDialog
          optionsByWants={optionsByWants}
          taken={rows.map((g) => g.code)}
          pending={create.isPending}
          onClose={() => setShowNew(false)}
          onCreate={(body, onFail) => create.mutate(
            { ...body, companyId: activeCo },
            {
              onSuccess: () => { setShowNew(false); toast?.success(`${body.code} created and bound · pickable on a product now`); },
              onError: (e) => onFail(e instanceof Error ? e.message : 'The group was not created.'),
            },
          )}
        />
      )}

      {menu && (
        <PopMenu x={menu.x} y={menu.y} label={`${menu.group.code} menu`} items={menuOf(menu.group)} onClose={() => setMenu(null)} />
      )}

      {/* Bindings feed the backfill — the historical PIs repost right where
          the groups were just signed off (item 3's door, owner-pressed). */}
      <PiBackfillCard />
    </div>
  );
};

/* ── New item group — born bound ─────────────────────────────────────────── */
const NewGroupDialog = ({
  optionsByWants, taken, pending, onClose, onCreate,
}: {
  optionsByWants: Record<'EXPENSE' | 'INCOME', ComboOption[]>;
  taken: string[];
  pending: boolean;
  onClose: () => void;
  onCreate: (body: { code: string; name: string; accounts: ItemGroupBinding }, onFail: (why: string) => void) => void;
}) => {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [accounts, setAccounts] = useState<ItemGroupBinding>(EMPTY);
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const upper = code.trim().toUpperCase();
    if (!/^[A-Za-z][A-Za-z0-9_]{1,29}$/.test(code.trim())) { setError('The code is letters, digits or _, starting with a letter, e.g. CURTAIN.'); return; }
    if (taken.includes(upper)) { setError(`${upper} already exists.`); return; }
    if (!name.trim()) { setError('Name the group.'); return; }
    if (!complete(accounts)) { setError('A new group needs all four accounts.'); return; }
    setError(null);
    onCreate({ code: upper, name: name.trim(), accounts }, setError);
  };

  return (
    <SetupModal
      title="New item group"
      sub="Born bound: it needs all four accounts, and it is pickable on a product at once."
      okLabel="Create group"
      busyLabel="Creating…"
      busy={pending}
      error={error}
      onOk={submit}
      onCancel={onClose}
    >
      <Field label="Code" w="32%">
        <input className={sp.input} placeholder="CURTAIN" value={code} aria-label="Group code"
          onChange={(e) => { setCode(e.target.value); setError(null); }} />
      </Field>
      <Field label="Name" w="64%">
        <input className={sp.input} placeholder="Curtain" value={name} aria-label="Group name"
          onChange={(e) => { setName(e.target.value); setError(null); }} />
      </Field>
      {SLOTS.map((s) => (
        <Field key={s.key} label={s.label}>
          <SearchCombo fill className={sp.input} options={optionsByWants[s.wants]} value={accounts[s.key]}
            onChange={(v) => { setAccounts((a) => ({ ...a, [s.key]: v })); setError(null); }}
            aria-label={`New group ${s.label} account`} placeholder="— pick account —" />
        </Field>
      ))}
    </SetupModal>
  );
};
