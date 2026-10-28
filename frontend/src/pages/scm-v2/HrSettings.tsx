// ----------------------------------------------------------------------------
// HR Settings — who earns commission, at what rates, which items carry a fixed
// per-unit bonus, and how the manager override is paid. Writes PATCH /config and
// CRUD on /profiles + /item-kpi + /override-levels (all under /api/scm/hr, all
// gated server-side on scm.hr.manage).
//
// EDIT -> SAVE, never naked edits (house rule): tier / showroom / active, every
// rate, every item-KPI bonus and every override level buffer into a draft and
// NOTHING persists until Save. The add rows and the delete button are explicit
// single actions, so they commit directly — deletes behind an in-app confirm.
//
// The override MODE lives here rather than on the report because it is a rate
// decision, not a reporting one: showroom mode pays a flat per-showroom
// override, chain mode pays down the reporting line at the per-level rates in
// the last section. They are alternatives — running both would pay a manager
// twice on the same goods — so the page states which one is live.
//
// Page shell is Inventory's (PageHeader + space-y-4), not the vendored 2990
// card slab — owner 2026-07-18.
// ----------------------------------------------------------------------------

import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '../../components/Button';
import { PageHeader } from '../../components/Layout';
import { fmtSen } from '@2990s/shared';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import {
  useHrConfig, useUpdateHrConfig,
  useHrProfiles, useCreateHrProfile, useUpdateHrProfile, useDeleteHrProfile,
  useHrItemKpi, useCreateHrItemKpi, useUpdateHrItemKpi, useDeleteHrItemKpi,
  useHrOverrideLevels, useCreateHrOverrideLevel, useUpdateHrOverrideLevel, useDeleteHrOverrideLevel,
  useHrPickers,
  type HrConfigPatch, type HrFlagType, type HrOverrideMode, type HrPickerRef, type HrTier,
} from '../../vendor/scm/lib/hr-queries';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

const INPUT_CLASS =
  'w-full appearance-none rounded-md border border-border bg-surface px-3 py-2 text-[13px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:opacity-60';

const SECTION_CLASS = 'space-y-2';
const TABLE_WRAP_CLASS = 'overflow-x-auto rounded-md border border-border bg-surface';
// Batch 4 skin (2026-07-29): the inline-edit tables stay exempt from
// conversion, but their headers take the SO-sample DataTable spec so the whole
// program reads as one system — surface-dim #e3e6e0, 10px/bold, brand tracking,
// ink, 2px rule. Drives all three HrSettings tables.
const THEAD_CLASS = 'border-b-2 border-border bg-surface-dim text-[10px] font-bold uppercase tracking-brand text-ink';

const Label = ({ children }: { children: string }) => (
  <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">{children}</span>
);

const SectionHeading = ({ children }: { children: string }) => (
  <h2 className="text-[14px] font-semibold text-ink">{children}</h2>
);

/** Integer bps -> a human percent, trailing zeros dropped. Display only. */
const fmtPct = (bps: number) => `${(bps / 100).toFixed(2).replace(/\.?0+$/, '')}%`;

/* A rate held as integer basis points, edited as a percent. The bps never
   changes shape in flight: it is divided by 100 to render and multiplied back
   by exactly 100 with Math.round on the way out. */
const RateField = ({
  label, bps, editable, onChange,
}: { label: string; bps: number; editable: boolean; onChange: (bps: number) => void }) => {
  const [text, setText] = useState((bps / 100).toString());
  // Resync when the server value moves under us (save, refetch, concurrent edit).
  useEffect(() => setText((bps / 100).toString()), [bps]);
  return (
    <label className="flex flex-col gap-1">
      <Label>{label}</Label>
      <input
        className={INPUT_CLASS}
        type="number"
        step="0.1"
        min={0}
        value={text}
        disabled={!editable}
        onChange={(e) => setText(e.target.value)}
        /* An EMPTY box is not 0%. Number('') === 0, so accepting it would stage
           a 0% base rate that reads as a deliberate edit — on this page that is
           everybody's pay. Blank reverts to the server value instead. */
        onBlur={() => {
          const n = Number(text);
          if (text.trim() === '' || !Number.isFinite(n) || n < 0) {
            setText((bps / 100).toString());
            return;
          }
          onChange(Math.round(n * 100));
        }}
      />
    </label>
  );
};

/** A money threshold held as integer sen, edited as ringgit. */
const SenField = ({
  label, centi, editable, onChange,
}: { label: string; centi: number; editable: boolean; onChange: (centi: number) => void }) => {
  const [text, setText] = useState((centi / 100).toString());
  useEffect(() => setText((centi / 100).toString()), [centi]);
  return (
    <label className="flex flex-col gap-1">
      <Label>{label}</Label>
      <input
        className={INPUT_CLASS}
        type="number"
        min={0}
        value={text}
        disabled={!editable}
        onChange={(e) => setText(e.target.value)}
        // Blank is "unknown", not RM 0 — see RateField.
        onBlur={() => {
          const n = Number(text);
          if (text.trim() === '' || !Number.isFinite(n) || n < 0) {
            setText((centi / 100).toString());
            return;
          }
          onChange(Math.round(n * 100));
        }}
      />
    </label>
  );
};

/* The in-table twin of RateField/SenField: an integer minor unit (sen or bps)
   edited as its major one, with the same blank guard. Read-only mode prints the
   value rather than showing a disabled box, because a table of greyed inputs
   reads as broken. `render` formats the committed value; `scale` is what one
   major unit is worth (100 for both RM->sen and %->bps). */
const MinorUnitCell = ({
  value, editable, scale, step, render, onChange,
}: {
  value: number;
  editable: boolean;
  scale: number;
  step?: string;
  render: (v: number) => string;
  onChange: (v: number) => void;
}) => {
  const [text, setText] = useState((value / scale).toString());
  useEffect(() => setText((value / scale).toString()), [value, scale]);
  if (!editable) return <span className="font-mono">{render(value)}</span>;
  return (
    <input
      className={`${INPUT_CLASS} text-right`}
      type="number"
      min={0}
      step={step}
      value={text}
      onChange={(e) => setText(e.target.value)}
      // Blank is "unknown", not zero — Number('') === 0 would stage a real edit.
      onBlur={() => {
        const n = Number(text);
        if (text.trim() === '' || !Number.isFinite(n) || n < 0) {
          setText((value / scale).toString());
          return;
        }
        onChange(Math.round(n * scale));
      }}
    />
  );
};

type ProfileDraft = { tier?: HrTier; showroomId?: string; active?: boolean };
type ItemKpiDraft = { label?: string; bonusSen?: number; active?: boolean };
type LevelDraft = { rateBps?: number; label?: string; active?: boolean };

export const HrSettings = () => {
  const profiles = useHrProfiles();
  const pickers = useHrPickers();
  const createProfile = useCreateHrProfile();
  const updateProfile = useUpdateHrProfile();
  const deleteProfile = useDeleteHrProfile();

  const config = useHrConfig();
  const updateConfig = useUpdateHrConfig();

  const itemKpi = useHrItemKpi();
  const createItemKpi = useCreateHrItemKpi();
  const updateItemKpi = useUpdateHrItemKpi();
  const deleteItemKpi = useDeleteHrItemKpi();

  const levels = useHrOverrideLevels();
  const createLevel = useCreateHrOverrideLevel();
  const updateLevel = useUpdateHrOverrideLevel();
  const deleteLevel = useDeleteHrOverrideLevel();

  const askConfirm = useConfirm();
  const notify = useNotify();

  const [editMode, setEditMode] = useState(false);
  const [profileDraft, setProfileDraft] = useState<Record<string, ProfileDraft>>({});
  const [itemDraft, setItemDraft] = useState<Record<string, ItemKpiDraft>>({});
  const [levelDraft, setLevelDraft] = useState<Record<string, LevelDraft>>({});
  const [cfgDraft, setCfgDraft] = useState<HrConfigPatch>({});
  const [saving, setSaving] = useState(false);

  const [newStaff, setNewStaff] = useState('');
  const [newTier, setNewTier] = useState<HrTier>('sales');
  const [newShowroom, setNewShowroom] = useState('');

  const [flagType, setFlagType] = useState<HrFlagType>('product');
  /* MULTI-SELECT, and it means N SEPARATE RULES — not one rule holding a list
     (owner 2026-07-18: "fabric 只能选一个 item", commission is read by item).
     Picking three fabrics creates three independently editable rows, each paying
     its own bonus for its own item. The confirm below says so before it happens,
     because "add 3 rules" and "add 1 rule covering 3 things" pay differently and
     the owner must not have to guess which one he just got. */
  const [flagRefs, setFlagRefs] = useState<string[]>([]);
  const [flagBonus, setFlagBonus] = useState('');

  const [newLevel, setNewLevel] = useState('');
  const [newLevelRate, setNewLevelRate] = useState('');
  const [newLevelLabel, setNewLevelLabel] = useState('');

  const cfg = config.data;
  const showrooms = pickers.data?.showrooms ?? [];
  const levelRows = levels.data ?? [];
  const dirtyCount =
    Object.keys(profileDraft).length +
    Object.keys(itemDraft).length +
    Object.keys(levelDraft).length +
    Object.keys(cfgDraft).length;

  const stageProfile = (id: string, patch: ProfileDraft) =>
    setProfileDraft((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  const stageItem = (id: string, patch: ItemKpiDraft) =>
    setItemDraft((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  const stageLevel = (id: string, patch: LevelDraft) =>
    setLevelDraft((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  const stageCfg = (patch: HrConfigPatch) => setCfgDraft((prev) => ({ ...prev, ...patch }));

  /* The mode as the page currently believes it (staged edit wins over server).
     Drives the chain-only hints — the ladder section itself stays visible in
     both modes, because you must be able to BUILD the ladder before the mode
     that needs it can be selected. */
  const effectiveMode: HrOverrideMode = cfgDraft.overrideMode ?? cfg?.overrideMode ?? 'showroom';
  const activeLevelCount = levelRows.filter((l) => levelDraft[l.id]?.active ?? l.active).length;

  const cancelEdits = () => {
    setProfileDraft({});
    setItemDraft({});
    setLevelDraft({});
    setCfgDraft({});
    setEditMode(false);
  };

  const saveEdits = async () => {
    setSaving(true);
    try {
      for (const [id, patch] of Object.entries(profileDraft)) {
        await updateProfile.mutateAsync({ id, ...patch });
      }
      for (const [id, patch] of Object.entries(itemDraft)) {
        await updateItemKpi.mutateAsync({ id, ...patch });
      }
      /* Levels BEFORE config, deliberately. The backend refuses to switch the
         mode to 'chain' unless at least one ACTIVE level exists; applying the
         ladder edits first means that check runs against the state this save is
         actually establishing, not the one it is replacing. */
      for (const [id, patch] of Object.entries(levelDraft)) {
        await updateLevel.mutateAsync({ id, ...patch });
      }
      if (Object.keys(cfgDraft).length > 0) await updateConfig.mutateAsync(cfgDraft);
      setProfileDraft({});
      setItemDraft({});
      setLevelDraft({});
      setCfgDraft({});
      setEditMode(false);
    } catch (e) {
      /* The draft is deliberately NOT cleared and edit mode stays open: the
         rates on screen are what the user meant to save, and silently dropping
         them on a failed request would look like the save succeeded. */
      await notify({ title: 'Could not save', body: (e as Error)?.message, tone: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const refList: HrPickerRef[] =
    flagType === 'product' ? pickers.data?.products ?? []
      : flagType === 'category' ? pickers.data?.categories ?? []
        : flagType === 'fabric' ? pickers.data?.fabrics ?? []
          : pickers.data?.specials ?? [];

  /* BONUS VALIDATION — explicit, not a clamp. Math.max(0, NaN) is NaN and
     Number('') is 0, so neither "empty" nor "abc" may be allowed to reach the
     API as a number: a bonus that silently becomes 0 or NaN is a wrong payslip,
     not a cosmetic bug. Returns the reason so the UI can SAY it rather than
     disabling a button for no visible cause. */
  const bonusError = ((): string | null => {
    if (flagBonus.trim() === '') return 'Enter the bonus amount in ringgit.';
    const n = Number(flagBonus);
    if (!Number.isFinite(n)) return 'The bonus must be a number, in ringgit.';
    if (n <= 0) return 'The bonus must be more than RM 0.';
    // Sen is the smallest unit that can be paid; 1.234 would silently round.
    if (Math.round(n * 100) !== n * 100) return 'The bonus cannot be smaller than one sen.';
    return null;
  })();
  const canAddItemKpi = flagRefs.length > 0 && bonusError === null && !createItemKpi.isPending;

  const addProfile = async () => {
    if (!newStaff || !newShowroom) return;
    try {
      await createProfile.mutateAsync({ staffId: newStaff, tier: newTier, showroomId: newShowroom });
      setNewStaff('');
      setNewShowroom('');
    } catch (e) {
      await notify({ title: 'Could not add salesperson', body: (e as Error)?.message, tone: 'error' });
    }
  };

  const addItemKpi = async () => {
    if (!canAddItemKpi || bonusError !== null) return;
    const bonusSen = Math.round(Number(flagBonus) * 100);
    const chosen = flagRefs.map((ref) => ({
      ref,
      // The label is what the owner reads back on the row. A ref with no picker
      // entry means the list moved under us, so keep the raw ref rather than
      // inventing a friendly name for something we could not resolve.
      label: refList.find((r) => r.ref === ref)?.label ?? ref,
    }));

    /* Say the shape of what is about to happen BEFORE it happens. Three
       selections = three rules, each paying the bonus on its own item. */
    if (chosen.length > 1) {
      const ok = await askConfirm({
        title: `Add ${chosen.length} separate ${flagType} rules?`,
        body:
          `Each of these gets its OWN rule paying ${fmtSen(bonusSen)} per unit, and each can be ` +
          `edited or removed on its own afterwards:\n\n` +
          chosen.map((c) => `  • ${c.label}`).join('\n') +
          `\n\nThis is not one rule covering all ${chosen.length}. An item is paid by whichever single ` +
          `rule matches it, once.`,
        confirmLabel: `Add ${chosen.length} rules`,
      });
      if (!ok) return;
    }

    /* Created one at a time so a mid-way failure can name EXACTLY which rules
       exist and which do not. Reporting "could not save" after two of three
       landed would leave the owner to guess, and re-running would duplicate the
       two that worked. */
    const added: string[] = [];
    for (const c of chosen) {
      try {
        await createItemKpi.mutateAsync({ flagType, ref: c.ref, label: c.label, bonusSen });
        added.push(c.label);
      } catch (e) {
        // Everything from the one that failed onwards is still unsaved.
        const failed = chosen.slice(chosen.indexOf(c));
        await notify({
          title: added.length === 0 ? 'Could not add the bonus rule' : 'Only some rules were added',
          body:
            (added.length > 0
              ? `Added: ${added.join(', ')}.\nNot added: ${failed.map((x) => x.label).join(', ')}.\n\n`
              : '') +
            // authed-fetch already ran the response through humanApiError and
            // threw an Error carrying that plain sentence — do not re-wrap it.
            `${(e as Error)?.message ?? 'The system did not say why.'}\n\nPlease add the missing ones again — the rules listed as added are already saved, so do not re-add those.`,
          tone: 'error',
        });
        // Keep the failures selected so the retry is one click, not a re-pick.
        setFlagRefs(failed.map((x) => x.ref));
        return;
      }
    }
    setFlagRefs([]);
    setFlagBonus('');
  };

  const addLevel = async () => {
    /* Both fields are read from their TEXT, never coerced: Number('') === 0, so
       a blank rate box would silently add a 0% rung — a level that pays nobody
       but makes chain mode selectable. Blank is refused, an explicit 0 is not. */
    const lvl = Number(newLevel);
    const rate = Number(newLevelRate);
    if (newLevel.trim() === '' || !Number.isInteger(lvl) || lvl < 1) return;
    if (newLevelRate.trim() === '' || !Number.isFinite(rate) || rate < 0) return;
    try {
      await createLevel.mutateAsync({
        level: lvl,
        rateBps: Math.round(rate * 100),
        label: newLevelLabel.trim(),
      });
      setNewLevel('');
      setNewLevelRate('');
      setNewLevelLabel('');
    } catch (e) {
      await notify({ title: 'Could not add override level', body: (e as Error)?.message, tone: 'error' });
    }
  };

  const newLevelValid =
    newLevel.trim() !== '' && Number.isInteger(Number(newLevel)) && Number(newLevel) >= 1 &&
    newLevelRate.trim() !== '' && Number.isFinite(Number(newLevelRate)) && Number(newLevelRate) >= 0;

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="HR"
        title="HR Settings"
        primaryAction={
          editMode ? (
            <div className="flex items-center gap-2">
              <Button variant="ghost" onClick={cancelEdits} disabled={saving}>
                Cancel
              </Button>
              <Button variant="primary" onClick={saveEdits} disabled={saving || dirtyCount === 0}>
                {saving ? 'Saving…' : dirtyCount > 0 ? `Save (${dirtyCount})` : 'Save'}
              </Button>
            </div>
          ) : (
            <Button variant="primary" onClick={() => setEditMode(true)}>
              Edit
            </Button>
          )
        }
      />

      {/* A failed read must never look like an empty list — "no salespeople
          configured" and "we could not ask" are different answers, and only one
          of them means nobody gets paid. */}
      {config.isError && (
        <div className="rounded-md border border-err/40 bg-err/5 px-3 py-3 text-[13px] text-ink">
          {(config.error as Error)?.message || 'The commission rate settings could not be loaded.'}
        </div>
      )}
      {profiles.isError && (
        <div className="rounded-md border border-err/40 bg-err/5 px-3 py-3 text-[13px] text-ink">
          {(profiles.error as Error)?.message || 'The salesperson list could not be loaded.'}
        </div>
      )}
      {itemKpi.isError && (
        <div className="rounded-md border border-err/40 bg-err/5 px-3 py-3 text-[13px] text-ink">
          {(itemKpi.error as Error)?.message || 'The item KPI list could not be loaded.'}
        </div>
      )}
      {levels.isError && (
        <div className="rounded-md border border-err/40 bg-err/5 px-3 py-3 text-[13px] text-ink">
          {(levels.error as Error)?.message || 'The override levels could not be loaded.'}
        </div>
      )}

      {/* 1 · Salespeople */}
      <section className={SECTION_CLASS}>
        <SectionHeading>Salespeople</SectionHeading>
        <div className={TABLE_WRAP_CLASS}>
          <table className="w-full text-[12px]">
            <thead className={THEAD_CLASS}>
              <tr>
                <th className="px-3 py-2 text-left">Name</th>
                <th className="px-2 py-2 text-left">Tier</th>
                <th className="px-2 py-2 text-left">Showroom</th>
                <th className="px-2 py-2 text-left">Active</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {(profiles.data ?? []).map((p) => (
                <tr key={p.id} className="border-t border-border-subtle">
                  <td className="px-3 py-2">
                    <span className="font-semibold text-ink">{p.staffName}</span>{' '}
                    <span className="text-ink-muted">{p.staffCode}</span>
                  </td>
                  <td className="px-2 py-2">
                    <select
                      className={INPUT_CLASS}
                      disabled={!editMode}
                      value={profileDraft[p.id]?.tier ?? p.tier}
                      onChange={(e) => stageProfile(p.id, { tier: e.target.value as HrTier })}
                    >
                      <option value="sales">sales</option>
                      <option value="manager">manager</option>
                    </select>
                  </td>
                  <td className="px-2 py-2">
                    <select
                      className={INPUT_CLASS}
                      disabled={!editMode}
                      value={profileDraft[p.id]?.showroomId ?? p.showroomId}
                      onChange={(e) => stageProfile(p.id, { showroomId: e.target.value })}
                    >
                      {showrooms.map((s) => (
                        <option key={s.id} value={s.id}>{s.name}</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-2 py-2">
                    <input
                      type="checkbox"
                      disabled={!editMode}
                      checked={profileDraft[p.id]?.active ?? p.active}
                      onChange={(e) => stageProfile(p.id, { active: e.target.checked })}
                    />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      aria-label={`Remove ${p.staffName}`}
                      className="rounded p-1 text-ink-muted hover:bg-err/10 hover:text-err"
                      onClick={async () => {
                        const ok = await askConfirm({
                          title: 'Remove this salesperson?',
                          body: `${p.staffName} will stop appearing on the commission report. Past closed periods keep their frozen figures.`,
                          confirmLabel: 'Remove',
                          danger: true,
                        });
                        if (!ok) return;
                        try {
                          await deleteProfile.mutateAsync(p.id);
                        } catch (e) {
                          await notify({ title: 'Could not remove', body: (e as Error)?.message, tone: 'error' });
                        }
                      }}
                    >
                      <Trash2 {...ICON} />
                    </button>
                  </td>
                </tr>
              ))}
              {(profiles.data ?? []).length === 0 && !profiles.isLoading && !profiles.isError && (
                <tr className="border-t border-border-subtle">
                  <td colSpan={5} className="px-3 py-4 text-center text-[12px] text-ink-secondary">
                    No salespeople configured yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-end gap-3 rounded-md border border-border bg-surface px-3 py-3">
          <label className="flex min-w-[220px] flex-col gap-1">
            <Label>Staff</Label>
            <select className={INPUT_CLASS} value={newStaff} onChange={(e) => setNewStaff(e.target.value)}>
              <option value="">Select…</option>
              {(pickers.data?.staff ?? []).map((s) => (
                <option key={s.id} value={s.id}>{s.name} ({s.role})</option>
              ))}
            </select>
          </label>
          <label className="flex min-w-[140px] flex-col gap-1">
            <Label>Tier</Label>
            <select className={INPUT_CLASS} value={newTier} onChange={(e) => setNewTier(e.target.value as HrTier)}>
              <option value="sales">sales</option>
              <option value="manager">manager</option>
            </select>
          </label>
          <label className="flex min-w-[180px] flex-col gap-1">
            <Label>Showroom</Label>
            <select className={INPUT_CLASS} value={newShowroom} onChange={(e) => setNewShowroom(e.target.value)}>
              <option value="">Select…</option>
              {showrooms.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
            {/* A salesperson CANNOT be added without a showroom (it is NOT NULL
                on the profile), so an empty list is a dead end. Say which one it
                is: "none set up yet" and "we could not ask" need different
                actions from the owner, and neither is "the page is broken". */}
            {showrooms.length === 0 && !pickers.isLoading && (
              <span className="text-[11px] text-ink-secondary">
                {pickers.isError
                  ? 'The showroom list could not be loaded, so nobody can be added yet.'
                  : 'No showrooms have been set up yet. One is required before a salesperson can be added.'}
              </span>
            )}
          </label>
          <Button
            variant="primary"
            icon={<Plus {...ICON} />}
            disabled={!newStaff || !newShowroom || createProfile.isPending}
            onClick={addProfile}
          >
            Add
          </Button>
        </div>
      </section>

      {/* 2 · Commission rates */}
      <section className={SECTION_CLASS}>
        <SectionHeading>Commission rates</SectionHeading>
        {cfg && (
          <div className="grid grid-cols-1 gap-3 rounded-md border border-border bg-surface px-3 py-3 sm:grid-cols-2 lg:grid-cols-4">
            <RateField
              label="Base %"
              editable={editMode}
              bps={cfgDraft.baseBps ?? cfg.baseBps}
              onChange={(v) => stageCfg({ baseBps: v })}
            />
            <RateField
              label="Personal KPI +%"
              editable={editMode}
              bps={cfgDraft.personalKpiBonusBps ?? cfg.personalKpiBonusBps}
              onChange={(v) => stageCfg({ personalKpiBonusBps: v })}
            />
            <SenField
              label="Personal threshold RM"
              editable={editMode}
              centi={cfgDraft.personalKpiThresholdSen ?? cfg.personalKpiThresholdSen}
              onChange={(v) => stageCfg({ personalKpiThresholdSen: v })}
            />
            <RateField
              label="Showroom KPI +%"
              editable={editMode}
              bps={cfgDraft.showroomKpiBonusBps ?? cfg.showroomKpiBonusBps}
              onChange={(v) => stageCfg({ showroomKpiBonusBps: v })}
            />
            <SenField
              label="Showroom threshold RM"
              editable={editMode}
              centi={cfgDraft.showroomKpiThresholdSen ?? cfg.showroomKpiThresholdSen}
              onChange={(v) => stageCfg({ showroomKpiThresholdSen: v })}
            />
            <RateField
              label="Override base %"
              editable={editMode}
              bps={cfgDraft.overrideBaseBps ?? cfg.overrideBaseBps}
              onChange={(v) => stageCfg({ overrideBaseBps: v })}
            />
            <RateField
              label="Override KPI +%"
              editable={editMode}
              bps={cfgDraft.overrideKpiBonusBps ?? cfg.overrideKpiBonusBps}
              onChange={(v) => stageCfg({ overrideKpiBonusBps: v })}
            />
            <label className="flex flex-col gap-1">
              <Label>Override mode</Label>
              <select
                className={INPUT_CLASS}
                disabled={!editMode}
                value={effectiveMode}
                onChange={(e) => stageCfg({ overrideMode: e.target.value as HrOverrideMode })}
              >
                <option value="showroom">showroom — flat rate per showroom</option>
                <option value="chain">chain — by reporting line</option>
              </select>
            </label>
          </div>
        )}

        {/* The two modes are alternatives, never both: running them together
            pays a manager twice on the same goods. Saying which one is live is
            worth a line, because the rate fields above only explain one of them. */}
        {cfg && (
          <p className="text-[12px] text-ink-secondary">
            {effectiveMode === 'chain'
              ? 'Chain mode: a manager earns on every level of their reporting line, at the per-level rates below. The Override base % and Override KPI +% above are not used.'
              : 'Showroom mode: a manager earns one flat Override base % on their whole showroom. The override levels below are not used.'}
          </p>
        )}

        {effectiveMode === 'chain' && activeLevelCount === 0 && (
          <p className="rounded-md border border-err/40 bg-err/5 px-3 py-2 text-[12px] text-ink">
            Chain mode needs at least one active override level. Add one below first — saving without it will be refused, because every manager would otherwise earn RM 0 override.
          </p>
        )}
      </section>

      {/* 3 · Item KPIs */}
      <section className={SECTION_CLASS}>
        <SectionHeading>Item KPIs</SectionHeading>
        <div className={TABLE_WRAP_CLASS}>
          <table className="w-full text-[12px]">
            <thead className={THEAD_CLASS}>
              <tr>
                <th className="px-3 py-2 text-left">Type</th>
                <th className="px-2 py-2 text-left">Item</th>
                <th className="px-2 py-2 text-right">Bonus / unit</th>
                <th className="px-2 py-2 text-left">Active</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {(itemKpi.data ?? []).map((it) => (
                <tr key={it.id} className="border-t border-border-subtle">
                  <td className="px-3 py-2 text-ink-secondary">{it.flagType}</td>
                  <td className="px-2 py-2 text-ink">{it.label || it.ref}</td>
                  <td className="px-2 py-2 text-right">
                    <MinorUnitCell
                      value={itemDraft[it.id]?.bonusSen ?? it.bonusSen}
                      editable={editMode}
                      scale={100}
                      render={fmtSen}
                      onChange={(v) => stageItem(it.id, { bonusSen: v })}
                    />
                  </td>
                  <td className="px-2 py-2 text-ink-secondary">
                    {editMode ? (
                      <input
                        type="checkbox"
                        checked={itemDraft[it.id]?.active ?? it.active}
                        onChange={(e) => stageItem(it.id, { active: e.target.checked })}
                      />
                    ) : (
                      it.active ? 'Yes' : 'No'
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      aria-label={`Remove ${it.label || it.ref}`}
                      className="rounded p-1 text-ink-muted hover:bg-err/10 hover:text-err"
                      onClick={async () => {
                        const ok = await askConfirm({
                          title: 'Remove this item KPI?',
                          body: 'It will stop adding a bonus on future commission runs.',
                          confirmLabel: 'Remove',
                          danger: true,
                        });
                        if (!ok) return;
                        try {
                          await deleteItemKpi.mutateAsync(it.id);
                        } catch (e) {
                          await notify({ title: 'Could not remove', body: (e as Error)?.message, tone: 'error' });
                        }
                      }}
                    >
                      <Trash2 {...ICON} />
                    </button>
                  </td>
                </tr>
              ))}
              {(itemKpi.data ?? []).length === 0 && !itemKpi.isLoading && !itemKpi.isError && (
                <tr className="border-t border-border-subtle">
                  <td colSpan={5} className="px-3 py-4 text-center text-[12px] text-ink-secondary">
                    No item KPIs configured yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="space-y-2 rounded-md border border-border bg-surface px-3 py-3">
          <div className="flex flex-wrap items-start gap-3">
            <label className="flex min-w-[140px] flex-col gap-1">
              <Label>Type</Label>
              <select
                className={INPUT_CLASS}
                value={flagType}
                onChange={(e) => {
                  setFlagType(e.target.value as HrFlagType);
                  setFlagRefs([]);
                }}
              >
                <option value="product">product — one specific product</option>
                <option value="category">category — every product in a category</option>
                <option value="fabric">fabric — a fabric series</option>
                <option value="special">special — a special-order option</option>
              </select>
            </label>
            <label className="flex min-w-[300px] flex-col gap-1">
              <Label>{flagType === 'category' ? 'Categories' : 'Items'}</Label>
              {/* A real multi-select list, not a combo box: the owner is choosing
                  how many rules to create, so how many are highlighted has to be
                  visible at a glance. */}
              <select
                multiple
                size={Math.min(8, Math.max(4, refList.length))}
                className={`${INPUT_CLASS} h-auto py-1`}
                value={flagRefs}
                onChange={(e) =>
                  setFlagRefs(Array.from(e.target.selectedOptions, (o) => o.value))
                }
              >
                {refList.map((r) => (
                  <option key={r.ref} value={r.ref} className="px-1 py-0.5">{r.label}</option>
                ))}
              </select>
              <span className="text-[11px] text-ink-secondary">
                {refList.length === 0
                  ? pickers.isLoading
                    ? 'Loading…'
                    : pickers.isError
                      ? 'This list could not be loaded.'
                      : 'Nothing to choose from yet.'
                  : flagRefs.length === 0
                    ? 'Select one or more. Hold Ctrl (or Cmd) to pick several.'
                    : flagRefs.length === 1
                      ? 'Adds 1 rule.'
                      : `Adds ${flagRefs.length} separate rules — one per ${flagType === 'category' ? 'category' : 'item'}, each paying the bonus below.`}
              </span>
            </label>
            <label className="flex min-w-[160px] flex-col gap-1">
              <Label>Bonus RM / unit</Label>
              <input
                className={INPUT_CLASS}
                type="number"
                min={0}
                step="0.01"
                value={flagBonus}
                onChange={(e) => setFlagBonus(e.target.value)}
              />
              {/* The reason is SHOWN, never just used to grey the button out:
                  a disabled Add with no explanation reads as a broken page. */}
              {flagBonus.trim() !== '' && bonusError && (
                <span className="text-[11px] text-err">{bonusError}</span>
              )}
            </label>
            <div className="flex flex-col gap-1">
              <Label>&nbsp;</Label>
              <Button
                variant="primary"
                icon={<Plus {...ICON} />}
                disabled={!canAddItemKpi}
                onClick={addItemKpi}
              >
                {createItemKpi.isPending
                  ? 'Adding…'
                  : flagRefs.length > 1
                    ? `Add ${flagRefs.length} rules`
                    : 'Add'}
              </Button>
            </div>
          </div>

          {/* The precedence rule, stated where the rule is created rather than
              left for someone to discover from a payslip. */}
          {flagType === 'category' && (
            <p className="text-[12px] text-ink-secondary">
              A category rule pays on every product in that category. If a product also has its own
              rule, that product's own rule is the one that pays — the two are never added together.
            </p>
          )}
        </div>
      </section>

      {/* 4 · Override levels (chain mode) */}
      <section className={SECTION_CLASS}>
        <SectionHeading>Override levels</SectionHeading>
        <p className="text-[12px] text-ink-secondary">
          Used by chain override mode only. Level 1 is a manager's direct reports, level 2 is their
          reports' reports, and so on — add as many levels as the reporting line goes deep. Each
          level's rate applies to that level's goods.
        </p>

        <div className={TABLE_WRAP_CLASS}>
          <table className="w-full text-[12px]">
            <thead className={THEAD_CLASS}>
              <tr>
                <th className="px-3 py-2 text-left">Level</th>
                <th className="px-2 py-2 text-left">Label</th>
                <th className="px-2 py-2 text-right">Rate</th>
                <th className="px-2 py-2 text-left">Active</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {levelRows.map((lv) => (
                <tr key={lv.id} className="border-t border-border-subtle">
                  {/* The level NUMBER is never editable — the backend refuses to
                      patch it too. Renumbering a rung in place would repoint an
                      existing rate at a different set of people without anyone
                      choosing that. Delete and re-add instead. */}
                  <td className="px-3 py-2 font-semibold text-ink">{lv.level}</td>
                  <td className="px-2 py-2">
                    {editMode ? (
                      <input
                        className={INPUT_CLASS}
                        value={levelDraft[lv.id]?.label ?? lv.label}
                        onChange={(e) => stageLevel(lv.id, { label: e.target.value })}
                      />
                    ) : (
                      <span className="text-ink">{lv.label || '—'}</span>
                    )}
                  </td>
                  <td className="px-2 py-2 text-right">
                    <MinorUnitCell
                      value={levelDraft[lv.id]?.rateBps ?? lv.rateBps}
                      editable={editMode}
                      scale={100}
                      step="0.1"
                      render={fmtPct}
                      onChange={(v) => stageLevel(lv.id, { rateBps: v })}
                    />
                  </td>
                  <td className="px-2 py-2 text-ink-secondary">
                    {editMode ? (
                      <input
                        type="checkbox"
                        checked={levelDraft[lv.id]?.active ?? lv.active}
                        onChange={(e) => stageLevel(lv.id, { active: e.target.checked })}
                      />
                    ) : (
                      lv.active ? 'Yes' : 'No'
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      aria-label={`Remove level ${lv.level}`}
                      className="rounded p-1 text-ink-muted hover:bg-err/10 hover:text-err"
                      onClick={async () => {
                        const ok = await askConfirm({
                          title: `Remove override level ${lv.level}?`,
                          body:
                            effectiveMode === 'chain' && activeLevelCount <= 1
                              ? `This is the last active level. Chain override mode is switched on, so removing it means every manager earns RM 0 override on the next run. Past closed periods keep their frozen figures.`
                              : `Managers will stop earning override on level ${lv.level} of their reporting line from the next run. Past closed periods keep their frozen figures.`,
                          confirmLabel: 'Remove',
                          danger: true,
                        });
                        if (!ok) return;
                        try {
                          await deleteLevel.mutateAsync(lv.id);
                        } catch (e) {
                          await notify({ title: 'Could not remove', body: (e as Error)?.message, tone: 'error' });
                        }
                      }}
                    >
                      <Trash2 {...ICON} />
                    </button>
                  </td>
                </tr>
              ))}
              {levelRows.length === 0 && !levels.isLoading && !levels.isError && (
                <tr className="border-t border-border-subtle">
                  <td colSpan={5} className="px-3 py-4 text-center text-[12px] text-ink-secondary">
                    No override levels configured yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-end gap-3 rounded-md border border-border bg-surface px-3 py-3">
          <label className="flex min-w-[120px] flex-col gap-1">
            <Label>Level</Label>
            <input
              className={INPUT_CLASS}
              type="number"
              min={1}
              step="1"
              value={newLevel}
              onChange={(e) => setNewLevel(e.target.value)}
            />
          </label>
          <label className="flex min-w-[140px] flex-col gap-1">
            <Label>Rate %</Label>
            <input
              className={INPUT_CLASS}
              type="number"
              min={0}
              step="0.1"
              value={newLevelRate}
              onChange={(e) => setNewLevelRate(e.target.value)}
            />
          </label>
          <label className="flex min-w-[220px] flex-col gap-1">
            <Label>Label (optional)</Label>
            <input
              className={INPUT_CLASS}
              value={newLevelLabel}
              onChange={(e) => setNewLevelLabel(e.target.value)}
            />
          </label>
          <Button
            variant="primary"
            icon={<Plus {...ICON} />}
            disabled={!newLevelValid || createLevel.isPending}
            onClick={addLevel}
          >
            Add
          </Button>
        </div>
      </section>
    </div>
  );
};
