// ----------------------------------------------------------------------------
// ChartOfAccounts — the maintenance page at /scm/chart-of-accounts.
//
// The owner's selective sharing (2026-09-02): 我要做选择性公用是因为往后可能会
// 在加公司，所以要可以公用，可能类似recon setup 我tick 后选择这个公司要不要用.
// One tree of every account any company carries, a TICK COLUMN PER COMPANY —
// tick = that company uses it (the row is instantiated from the master
// definition, parent riding along), untick = it does not (children cascade
// off, after a confirm). A future company is a new column, never a new
// spreadsheet exercise.
//
// The Upload button takes the accountant's AutoCount export (xlsx) straight
// from disk: codes (digit and letter series), two-tier indentation → parent,
// section headings → account_type, Special Acc Type → acc_money (SBK/SCH).
// Rows are pre-classified shared vs company-specific (banks, cash, related-
// party loans, directors, HP/borrowings stay home); the tick columns are
// where a person adjusts afterwards. The file itself never enters the repo.
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { ChevronDown, ChevronRight, Pencil, Plus, Trash2, Upload } from 'lucide-react';
import { Button } from '@2990s/design-system';
import {
  useChartUnion, useChartTick, useChartImport,
  useChartRename, useChartUpdate, useChartDelete, useChartCreate, isControlSpecial,
  type ChartRow, type ChartImportRow,
} from '../../vendor/scm/lib/accounting-queries';
import { useAuth as useHouzsAuth } from '../../auth/AuthContext';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import styles from './SalesOrderDetail.module.css';
import { PageHeader } from '../../components/Layout';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

/* ── The AutoCount export, parsed (the scan page's discipline) ───────────── */

const CODE_RE = /^(\s*)(\d{3}-[A-Za-z0-9]{4})\s*$/;

const SECTION_TYPE: Record<string, ChartImportRow['accountType']> = {
  'CAPITAL': 'EQUITY', 'RETAINED EARNING': 'EQUITY',
  'FIXED ASSETS': 'ASSET', 'OTHER ASSETS': 'ASSET', 'CURRENT ASSETS': 'ASSET',
  'CURRENT LIABILITIES': 'LIABILITY', 'LONG TERM LIABILITIES': 'LIABILITY',
  'SALES': 'INCOME', 'SALES ADJUSTMENTS': 'INCOME', 'OTHER INCOMES': 'INCOME',
  'COST OF GOODS SOLD': 'EXPENSE', 'EXPENSES': 'EXPENSE', 'TAXATION': 'EXPENSE',
};

/* Company-specific by nature: banks and cash are THIS company's accounts
   (SBK/SCH), and the related-party/director/HP/borrowing series name real
   counterparties of one company. Everything else defaults to shared — the
   tick columns are where a person narrows afterwards. */
const isExclusive = (code: string, special: string): boolean =>
  ['SBK', 'SCH'].includes(special) || /^(350|351|430|450|451|460|406)-/.test(code);

export type ParsedChart = { rows: ChartImportRow[]; sections: string[]; unknownSections: string[] };

export function parseChartXlsx(wb: XLSX.WorkBook): ParsedChart {
  const sheet = wb.Sheets[wb.SheetNames[0]!];
  const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet!, { header: 1, raw: false });
  const rows: ChartImportRow[] = [];
  const sections: string[] = [];
  const unknownSections: string[] = [];
  let section = '';
  const prevByDepth: Record<number, string> = {};
  for (const r of grid) {
    const c0 = String(r[0] ?? '');
    const m = c0.match(CODE_RE);
    if (!m) {
      const label = c0.trim().toUpperCase();
      /* Section headings are short single-cell lines. The company letterhead
         and page furniture are not sections. */
      if (label && r.length <= 2 && !label.includes('ACC')
        && !label.includes('SDN') && !label.includes('BHD') && !label.includes('PAGE')) {
        section = label;
        sections.push(label);
        if (!(label in SECTION_TYPE)) unknownSections.push(label);
      }
      continue;
    }
    const depth = Math.floor(m[1]!.length / 4);
    const code = m[2]!;
    prevByDepth[depth] = code;
    const special = r[8] != null ? String(r[8]).trim().toUpperCase() : '';
    rows.push({
      code,
      name: String(r[1] ?? '').trim() || code,
      accountType: SECTION_TYPE[section] ?? 'EXPENSE',
      parentCode: depth > 0 ? (prevByDepth[depth - 1] ?? null) : null,
      accMoney: special === 'SBK' || special === 'SCH',
      specialType: special || null,
      shared: !isExclusive(code, special),
    });
  }
  return { rows, sections, unknownSections };
}

/* ── The tree order: parents first, children under them ──────────────────── */
function treeOrder(accounts: ChartRow[]): ChartRow[] {
  const byParent = new Map<string | null, ChartRow[]>();
  for (const a of accounts) {
    const list = byParent.get(a.parentCode) ?? [];
    list.push(a);
    byParent.set(a.parentCode, list);
  }
  for (const list of byParent.values()) list.sort((x, y) => x.code.localeCompare(y.code));
  const out: ChartRow[] = [];
  const walk = (parent: string | null) => {
    for (const a of byParent.get(parent) ?? []) {
      out.push(a);
      walk(a.code);
    }
  };
  walk(null);
  /* Orphans (parent not in the union — should not happen, but a broken tree
     must still RENDER) trail at the end rather than vanishing. */
  const seen = new Set(out.map((a) => a.code));
  for (const a of accounts) if (!seen.has(a.code)) out.push(a);
  return out;
}

const TYPE_TONE: Record<string, string> = {
  ASSET: '#2F5D4F', LIABILITY: '#B06000', EQUITY: '#4A4A8A', INCOME: '#16695f', EXPENSE: '#8A3B3B',
};

export const ChartOfAccounts = () => {
  const askConfirm = useConfirm();
  const notify = useNotify();
  const { can } = useHouzsAuth();
  const canManage = can('scm.payment_voucher.post');

  const unionQ = useChartUnion();
  const tick = useChartTick();
  const doImport = useChartImport();
  const doRename = useChartRename();
  const doUpdate = useChartUpdate();
  const doDelete = useChartDelete();
  const doCreate = useChartCreate();
  const fileRef = useRef<HTMLInputElement>(null);

  const companies = unionQ.data?.companies ?? [];
  const accounts = useMemo(() => treeOrder(unionQ.data?.accounts ?? []), [unionQ.data]);
  const [parsed, setParsed] = useState<ParsedChart | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  /* ── 展开/收缩 (owner point 4): fold a header, its whole subtree hides. ── */
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const parentOf = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const a of accounts) m.set(a.code, a.parentCode);
    return m;
  }, [accounts]);
  const isHidden = (code: string): boolean => {
    let cursor = parentOf.get(code) ?? null;
    for (let depth = 0; cursor && depth < 6; depth += 1) {
      if (folded.has(cursor)) return true;
      cursor = parentOf.get(cursor) ?? null;
    }
    return false;
  };
  const toggleFold = (code: string) => {
    setFolded((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code); else next.add(code);
      return next;
    });
  };

  /* ── 拖动改父户 (the owner, 2026-09-03: 我希望可以拖动式 put account under
     别的 account). Drop A onto B → confirm → B becomes A's header. The moved
     account keeps its GL (lines hang on its own code); the SERVER holds the
     rule — a target with postings or references refuses (父户不记账), same
     type only, no cycles — and its sentence lands in the dialog on refusal. */
  const [dragCode, setDragCode] = useState<string | null>(null);
  const onDropInto = async (target: ChartRow) => {
    const src = dragCode;
    setDragCode(null);
    if (!src || src === target.code) return;
    const srcRow = accounts.find((x) => x.code === src);
    if (!srcRow || (srcRow.parentCode ?? '') === target.code) return;
    const ok = await askConfirm({
      title: `把 ${src} 挂到 ${target.code} 下？`,
      body: `${srcRow.name} → under ${target.name}. A target that carries postings or references refuses (父户不记账); the move itself never touches the GL.`,
      confirmLabel: 'Move',
    });
    if (!ok) return;
    try {
      await doUpdate.mutateAsync({ code: src, parentCode: target.code });
    } catch (e) {
      void notify({ title: 'Move failed', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
    }
  };

  /* ── 改码/改名 (owner point 1): edit panel above the table. A changed code
     goes through the rename RPC (改码全账跟); name/type ride the update. ── */
  const [editing, setEditing] = useState<ChartRow | null>(null);
  const [editCode, setEditCode] = useState('');
  const [editName, setEditName] = useState('');
  const [editType, setEditType] = useState<ChartRow['type']>('ASSET');
  const [editParent, setEditParent] = useState('');
  /* With the list scrolling inside its card the panel is normally already on
     screen; this nudge covers the remainder (a small window, the Add form
     open too). Optional-called — jsdom has no scrollIntoView. */
  const editPanelRef = useRef<HTMLElement>(null);
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- lib.dom types scrollIntoView as always-present; jsdom (the test runtime) has none
    if (editing) editPanelRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [editing]);
  const openEdit = (row: ChartRow) => {
    setEditing(row);
    setEditCode(row.code);
    setEditName(row.name);
    setEditType(row.type);
    setEditParent(row.parentCode ?? '');
  };
  const saveEdit = async () => {
    if (!editing) return;
    const codeChanged = editCode.trim() !== editing.code;
    const nameChanged = editName.trim() !== editing.name;
    const typeChanged = editType !== editing.type;
    const parentChanged = editParent.trim() !== (editing.parentCode ?? '');
    if (!codeChanged && !nameChanged && !typeChanged && !parentChanged) { setEditing(null); return; }
    if (codeChanged) {
      const ok = await askConfirm({
        title: `Rename ${editing.code} → ${editCode.trim()}?`,
        body: '改码全账跟: every journal line, voucher, settlement link and role binding moves to the new code in one transaction — or none of it does.',
        confirmLabel: 'Rename everywhere',
      });
      if (!ok) return;
    }
    try {
      if (codeChanged) {
        const res = await doRename.mutateAsync({ oldCode: editing.code, newCode: editCode.trim() });
        const moved = Object.entries(res.moved).filter(([, n]) => Number(n) > 0)
          .map(([k, n]) => `${k}: ${n}`).join(', ');
        void notify({ title: `${editing.code} → ${editCode.trim()}`, body: moved ? `Moved — ${moved}.` : 'Renamed.', tone: 'info' });
      }
      if (nameChanged || typeChanged || parentChanged) {
        await doUpdate.mutateAsync({
          code: codeChanged ? editCode.trim() : editing.code,
          ...(nameChanged ? { name: editName.trim() } : {}),
          ...(typeChanged ? { accountType: editType } : {}),
          ...(parentChanged ? { parentCode: editParent.trim() || null } : {}),
        });
      }
      setEditing(null);
    } catch (e) {
      void notify({ title: 'Save failed', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
    }
  };

  /* ── 一个门开户 (owner 2026-09-03: 照理说应该维护 overall chart 罢了):
     the definition is created once, lands in every ticked company, parent
     chain riding along per company. ── */
  const [addingNew, setAddingNew] = useState(false);
  const [newCode, setNewCode] = useState('');
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<ChartRow['type']>('ASSET');
  const [newParent, setNewParent] = useState('');
  const [newMoney, setNewMoney] = useState(false);
  const [newSpecial, setNewSpecial] = useState('');
  const [depOn, setDepOn] = useState(true);
  const [depCode, setDepCode] = useState('');
  const [depName, setDepName] = useState('');
  const [newCompanies, setNewCompanies] = useState<Set<number>>(new Set());
  const openAdd = () => {
    setAddingNew(true);
    setNewCode(''); setNewName(''); setNewType('ASSET'); setNewParent(''); setNewMoney(false);
    setNewSpecial(''); setDepOn(true); setDepCode(''); setDepName('');
    setNewCompanies(new Set(companies.map((co) => co.id)));
  };
  /* His chart's own SFA/SAD convention: the twin is the asset's code with the
     last digit +5 (201-1000 → 201-1005), named ACCUM. DEPRN. - <asset>. */
  const deriveDep = (assetCode: string, assetName: string) => {
    const m = /^(\d{3}-\d{3})(\d)$/.exec(assetCode.trim());
    setDepCode(m && Number(m[2]) < 5 ? `${m[1]}${Number(m[2]) + 5}` : '');
    setDepName(assetName.trim() ? `ACCUM. DEPRN. - ${assetName.trim()}` : '');
  };
  const pickSpecial = (sp: string) => {
    setNewSpecial(sp);
    if (sp === 'SBK' || sp === 'SCH') setNewMoney(true);
    if (sp === 'SFA') deriveDep(newCode, newName);
  };
  const saveNew = async () => {
    try {
      const withDep = newSpecial === 'SFA' && depOn && depCode.trim() && depName.trim();
      const res = await doCreate.mutateAsync({
        code: newCode.trim(),
        name: newName.trim(),
        accountType: newType,
        parentCode: newParent.trim() || null,
        accMoney: newMoney,
        ...(newSpecial ? { specialType: newSpecial } : {}),
        ...(withDep ? { depreciation: { code: depCode.trim(), name: depName.trim() } } : {}),
        companyIds: [...newCompanies],
      });
      setAddingNew(false);
      void notify({
        title: `${res.code} created`,
        body: `Live in ${res.companies.length} company(ies)${newParent.trim() ? ` under ${newParent.trim()}` : ''}${res.depreciationCode ? ` — depreciation twin ${res.depreciationCode} created beside it` : ''}. Adjust the ticks any time.`,
        tone: 'info',
      });
    } catch (e) {
      void notify({ title: 'Create failed', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
    }
  };

  /* ── 删除 (owner point 2): only a never-used code dies; the server names
     every holdout otherwise — that sentence goes straight to the dialog. ── */
  const onDelete = async (row: ChartRow) => {
    const ok = await askConfirm({
      title: `Delete ${row.code} · ${row.name}?`,
      body: 'Only an account with NO transactions and NO references anywhere can be deleted — otherwise untick it instead. This removes it from every company.',
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    try {
      await doDelete.mutateAsync(row.code);
      void notify({ title: `${row.code} deleted`, body: 'It existed in no ledger — gone from every company.', tone: 'info' });
    } catch (e) {
      void notify({ title: 'Cannot delete', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
    }
  };

  const onTick = async (companyId: number, row: ChartRow, next: boolean) => {
    if (!next) {
      const kids = accounts.filter((a) => a.parentCode === row.code && a.perCompany[companyId]?.active);
      const ok = await askConfirm({
        title: `Untick ${row.code} for ${companies.find((c) => c.id === companyId)?.code ?? companyId}?`,
        body: kids.length > 0
          ? `This is a header — its ${kids.length} active sub-account(s) go off with it.`
          : 'The account is kept (history stays); it just stops being offered in this company.',
        confirmLabel: 'Untick',
      });
      if (!ok) return;
    }
    setBusyKey(`${companyId}:${row.code}`);
    try {
      await tick.mutateAsync({ companyId, code: row.code, active: next });
    } catch (e) {
      void notify({ title: 'Tick failed', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
    } finally {
      setBusyKey(null);
    }
  };

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    try {
      const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' });
      const p = parseChartXlsx(wb);
      if (p.rows.length === 0) {
        void notify({ title: 'Nothing to import', body: 'No account codes were found in the file — is this the AutoCount chart export?', tone: 'error' });
        return;
      }
      setParsed(p);
    } catch (e) {
      void notify({ title: 'Could not read the file', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
    }
  };

  const runImport = async () => {
    if (!parsed) return;
    try {
      const res = await doImport.mutateAsync({ companyId: 1, rows: parsed.rows });
      setParsed(null);
      void notify({
        title: `${res.imported} account(s) imported`,
        body: res.shared > 0 && res.sharedTo.length > 0
          ? `${res.shared} shared row(s) copied to ${res.sharedTo.length} other company(ies); the rest stay HOUZS-only. Adjust any tick below.`
          : 'Adjust the ticks below.',
        tone: 'info',
      });
    } catch (e) {
      void notify({ title: 'Import failed', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
    }
  };

  const exclusiveRows = parsed?.rows.filter((r) => !r.shared) ?? [];

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Finance"
        title="Chart of Accounts"
        actions={canManage ? (
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-3)' }}>
            <button
              type="button"
              onClick={openAdd}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--c-orange)', fontWeight: 600, cursor: 'pointer', fontSize: 'var(--fs-13)', background: 'none', border: 'none', padding: 0 }}
            >
              <Plus {...ICON} /> Add account
            </button>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--c-orange)', fontWeight: 600, cursor: 'pointer', fontSize: 'var(--fs-13)' }}>
              <Upload {...ICON} /> Upload AutoCount chart
              <input ref={fileRef} type="file" accept=".xlsx,.xls" style={{ display: 'none' }}
                onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ''; }} />
            </label>
          </div>
        ) : undefined}
      />

      <datalist id="chart-parent-codes">
        {accounts.map((a) => <option key={a.code} value={a.code}>{a.name}</option>)}
      </datalist>

      {addingNew && (
        <section className={styles.card}>
          <div className={styles.cardHeader}>
            <h2 className={styles.cardTitle}>New account</h2>
          </div>
          <div className={styles.cardBody} style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-3)', alignItems: 'flex-end', fontSize: 'var(--fs-13)' }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>Code (NNN-XXXX)</span>
              <input value={newCode} onChange={(e) => setNewCode(e.target.value)} placeholder="305-0010"
                style={{ fontFamily: 'var(--font-mono)', padding: '6px 8px', border: '1px solid var(--border-weak, #d8d5cd)', borderRadius: 6, width: 130 }} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 220px' }}>
              <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>Name</span>
              <input value={newName} onChange={(e) => setNewName(e.target.value)}
                style={{ padding: '6px 8px', border: '1px solid var(--border-weak, #d8d5cd)', borderRadius: 6 }} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>Type</span>
              <select value={newType} onChange={(e) => setNewType(e.target.value as ChartRow['type'])}
                style={{ padding: '6px 8px', border: '1px solid var(--border-weak, #d8d5cd)', borderRadius: 6 }}>
                {Object.keys(TYPE_TONE).map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>Parent (optional)</span>
              <input value={newParent} onChange={(e) => setNewParent(e.target.value)} list="chart-parent-codes" placeholder="305-0000"
                style={{ fontFamily: 'var(--font-mono)', padding: '6px 8px', border: '1px solid var(--border-weak, #d8d5cd)', borderRadius: 6, width: 150 }} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>Special type</span>
              <select value={newSpecial} onChange={(e) => pickSpecial(e.target.value)} aria-label="Special type"
                style={{ padding: '6px 8px', border: '1px solid var(--border-weak, #d8d5cd)', borderRadius: 6 }}>
                <option value="">— none —</option>
                <option value="SBK">SBK · 银行</option>
                <option value="SCH">SCH · 现金</option>
                <option value="SOP">SOP · 电子钱包/其他</option>
                <option value="SFA">SFA · 固定资产 (带折旧对)</option>
                <option value="SAD">SAD · 累计折旧</option>
                <option value="SRE">SRE · Retained earning</option>
                <option value="SDP">SDP · Deferred</option>
                <option value="SOS">SOS · 期初存货</option>
                <option value="SCS">SCS · 期末存货</option>
                <option value="SDC">SDC · Debtor control (由模块过账)</option>
                <option value="SCC">SCC · Creditor control (由模块过账)</option>
                <option value="SBS">SBS · Stock control (由模块过账)</option>
              </select>
            </label>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={newMoney} onChange={(e) => setNewMoney(e.target.checked)} />
              money (bank/cash/wallet)
            </label>
            {newSpecial === 'SFA' && (
              <div style={{ flexBasis: '100%', display: 'flex', flexWrap: 'wrap', gap: 'var(--space-3)', alignItems: 'flex-end', padding: 'var(--space-2)', border: '1px dashed var(--border-weak, #d8d5cd)', borderRadius: 8 }}>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <input type="checkbox" checked={depOn} onChange={(e) => setDepOn(e.target.checked)} />
                  同时开折旧户 (SAD)
                </label>
                {depOn && (<>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>Depreciation code</span>
                    <input value={depCode} onChange={(e) => setDepCode(e.target.value)} aria-label="Depreciation code"
                      style={{ fontFamily: 'var(--font-mono)', padding: '6px 8px', border: '1px solid var(--border-weak, #d8d5cd)', borderRadius: 6, width: 130 }} />
                  </label>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 240px' }}>
                    <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>Depreciation name</span>
                    <input value={depName} onChange={(e) => setDepName(e.target.value)} aria-label="Depreciation name"
                      style={{ padding: '6px 8px', border: '1px solid var(--border-weak, #d8d5cd)', borderRadius: 6 }} />
                  </label>
                  <Button variant="ghost" size="sm" onClick={() => deriveDep(newCode, newName)}>
                    照惯例填 (+5 / ACCUM. DEPRN.)
                  </Button>
                </>)}
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
              {companies.map((co) => (
                <label key={co.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <input
                    type="checkbox"
                    aria-label={`new account for ${co.code}`}
                    checked={newCompanies.has(co.id)}
                    onChange={(e) => setNewCompanies((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(co.id); else next.delete(co.id);
                      return next;
                    })}
                  />
                  {co.code}
                </label>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
              <Button variant="primary" size="sm" onClick={() => void saveNew()}
                disabled={doCreate.isPending || !newCode.trim() || !newName.trim() || newCompanies.size === 0}>
                {doCreate.isPending ? 'Creating…' : 'Create'}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setAddingNew(false)} disabled={doCreate.isPending}>
                Cancel
              </Button>
            </div>
          </div>
        </section>
      )}

      {parsed && (
        <section className={styles.card}>
          <div className={styles.cardHeader}>
            <h2 className={styles.cardTitle}>Ready to import</h2>
          </div>
          <div className={styles.cardBody} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', fontSize: 'var(--fs-13)' }}>
            <div>
              {parsed.rows.length} account(s) read · {parsed.rows.length - exclusiveRows.length} will be SHARED to every company ·{' '}
              {exclusiveRows.length} stay HOUZS-only (banks, cash, related-party loans, directors, HP/borrowings).
            </div>
            {parsed.unknownSections.length > 0 && (
              <div style={{ color: 'var(--c-festive-b, #B8331F)' }}>
                Unknown section(s) fell back to EXPENSE: {parsed.unknownSections.join(', ')} — check them after import.
              </div>
            )}
            <details>
              <summary style={{ cursor: 'pointer' }}>The HOUZS-only list ({exclusiveRows.length})</summary>
              <div style={{ maxHeight: 220, overflowY: 'auto', marginTop: 6, fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-12)' }}>
                {exclusiveRows.map((r) => <div key={r.code}>{r.code} · {r.name}</div>)}
              </div>
            </details>
            <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
              <Button variant="primary" size="sm" onClick={() => void runImport()} disabled={doImport.isPending}>
                {doImport.isPending ? 'Importing…' : `Import ${parsed.rows.length} accounts`}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setParsed(null)} disabled={doImport.isPending}>
                Cancel
              </Button>
            </div>
          </div>
        </section>
      )}

      {editing && (
        <section className={styles.card} ref={editPanelRef}>
          <div className={styles.cardHeader}>
            <h2 className={styles.cardTitle}>Edit {editing.code}</h2>
          </div>
          <div className={styles.cardBody} style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-3)', alignItems: 'flex-end', fontSize: 'var(--fs-13)' }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>Code — 改码全账跟</span>
              <input value={editCode} onChange={(e) => setEditCode(e.target.value)}
                style={{ fontFamily: 'var(--font-mono)', padding: '6px 8px', border: '1px solid var(--border-weak, #d8d5cd)', borderRadius: 6, width: 130 }} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 240px' }}>
              <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>Name</span>
              <input value={editName} onChange={(e) => setEditName(e.target.value)}
                style={{ padding: '6px 8px', border: '1px solid var(--border-weak, #d8d5cd)', borderRadius: 6 }} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>Type</span>
              <select value={editType} onChange={(e) => setEditType(e.target.value as ChartRow['type'])}
                style={{ padding: '6px 8px', border: '1px solid var(--border-weak, #d8d5cd)', borderRadius: 6 }}>
                {Object.keys(TYPE_TONE).map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>Under (parent — 留空 = 根)</span>
              <input value={editParent} onChange={(e) => setEditParent(e.target.value)} list="chart-parent-codes" aria-label="Edit parent"
                style={{ fontFamily: 'var(--font-mono)', padding: '6px 8px', border: '1px solid var(--border-weak, #d8d5cd)', borderRadius: 6, width: 150 }} />
            </label>
            <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
              <Button variant="primary" size="sm" onClick={() => void saveEdit()} disabled={doRename.isPending || doUpdate.isPending}>
                {doRename.isPending || doUpdate.isPending ? 'Saving…' : 'Save'}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setEditing(null)} disabled={doRename.isPending || doUpdate.isPending}>
                Cancel
              </Button>
            </div>
          </div>
        </section>
      )}

      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Every account, every company</h2>
          <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
            tick = the company uses it · unticking a header takes its children · headers never book (父户不记账)
          </span>
        </div>
        {/* The LIST scrolls inside the card, not the page (owner 2026-09-04:
            按 edit 时要跑回上去 / 往下滑时看不到 header). With the page short,
            the Edit/Add panels above this card stay in sight wherever you are
            in the list — press ✎ on row 400 and the panel is right there, and
            saving leaves the list where you were. And a scroll container of
            its OWN is what lets the header row stick: .card carries
            overflow:hidden (its rounded corners), which would swallow a
            page-scroll sticky. */}
        <div className={styles.cardBody} style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: 'calc(100vh - 260px)' }}>
          {unionQ.isLoading && <div style={{ fontSize: 'var(--fs-13)' }}>Loading the chart…</div>}
          {unionQ.error != null && (
            <div className={styles.bannerWarn}>
              Failed to load the chart. {unionQ.error instanceof Error ? unionQ.error.message : ''}
            </div>
          )}
          {!unionQ.isLoading && accounts.length === 0 && (
            <div style={{ fontSize: 'var(--fs-13)', color: 'var(--fg-muted)' }}>
              No accounts yet — upload the AutoCount chart to begin.
            </div>
          )}
          {accounts.length > 0 && (
            <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 'var(--fs-13)' }}>
              <thead>
                {/* Sticky INSIDE the card's scroll (see the cardBody note).
                    Solid background + inset shadow instead of the old tr
                    border — a border on the <tr> does not travel with sticky
                    cells, the shadow does. */}
                <tr style={{ textAlign: 'left' }}>
                  {(() => {
                    const stickyTh = {
                      position: 'sticky' as const, top: 0, zIndex: 5,
                      background: 'var(--c-paper, #fff)',
                      boxShadow: 'inset 0 -1px var(--border-weak, #e3e1da)',
                      padding: '6px 8px',
                    };
                    return (
                      <>
                        <th style={stickyTh}>Code</th>
                        <th style={stickyTh}>Name</th>
                        <th style={stickyTh}>Type</th>
                        {companies.map((co) => (
                          <th key={co.id} style={{ ...stickyTh, textAlign: 'center' }}>{co.code}</th>
                        ))}
                        {canManage && <th style={stickyTh} aria-label="actions" />}
                      </>
                    );
                  })()}
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => {
                  const isParent = accounts.some((x) => x.parentCode === a.code);
                  if (isHidden(a.code)) return null;
                  const isControl = isControlSpecial(a.special);
                  return (
                    <tr
                      key={a.code}
                      draggable={canManage}
                      onDragStart={() => setDragCode(a.code)}
                      onDragOver={(e) => { if (canManage && dragCode && dragCode !== a.code) e.preventDefault(); }}
                      onDrop={(e) => { e.preventDefault(); void onDropInto(a); }}
                      style={{ borderBottom: '1px solid var(--border-weak, #f0eee8)', cursor: canManage ? 'grab' : undefined }}
                    >
                      <td style={{ padding: '4px 8px', fontFamily: 'var(--font-mono)', paddingLeft: a.parentCode ? 28 : 8, fontWeight: isParent ? 700 : 400, whiteSpace: 'nowrap' }}>
                        {isParent ? (
                          <button
                            type="button"
                            aria-label={`${folded.has(a.code) ? 'Expand' : 'Collapse'} ${a.code}`}
                            onClick={() => toggleFold(a.code)}
                            style={{ background: 'none', border: 'none', padding: 0, marginRight: 4, cursor: 'pointer', verticalAlign: 'middle', color: 'var(--fg-muted)' }}
                          >
                            {folded.has(a.code) ? <ChevronRight size={14} strokeWidth={2} /> : <ChevronDown size={14} strokeWidth={2} />}
                          </button>
                        ) : (
                          <span style={{ display: 'inline-block', width: 18 }} />
                        )}
                        {a.code}
                      </td>
                      <td style={{ padding: '4px 8px', fontWeight: isParent ? 700 : 400 }}>
                        {a.name}
                        {a.accMoney && <span style={{ marginLeft: 6, fontSize: 'var(--fs-11)', color: 'var(--c-secondary-a, #2F5D4F)' }}>money</span>}
                        {isParent && <span style={{ marginLeft: 6, fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>header</span>}
                        {a.special != null && a.special !== '' && (
                          <span style={{ marginLeft: 6, fontSize: 'var(--fs-11)', fontFamily: 'var(--font-mono)', color: isControl ? 'var(--c-festive-b, #B8331F)' : 'var(--fg-muted)' }}>
                            {a.special}{isControl ? ' · control' : ''}
                          </span>
                        )}
                      </td>
                      <td style={{ padding: '4px 8px', fontSize: 'var(--fs-11)', color: TYPE_TONE[a.type] ?? 'inherit' }}>{a.type}</td>
                      {companies.map((co) => {
                        const active = a.perCompany[co.id]?.active === true;
                        const key = `${co.id}:${a.code}`;
                        return (
                          <td key={co.id} style={{ padding: '4px 8px', textAlign: 'center' }}>
                            <input
                              type="checkbox"
                              aria-label={`${a.code} for ${co.code}`}
                              checked={active}
                              disabled={!canManage || busyKey === key || tick.isPending}
                              onChange={(e) => void onTick(co.id, a, e.target.checked)}
                              style={{ width: 15, height: 15, accentColor: 'var(--c-orange)' }}
                            />
                          </td>
                        );
                      })}
                      {canManage && (
                        <td style={{ padding: '4px 8px', whiteSpace: 'nowrap', textAlign: 'right' }}>
                          <button
                            type="button"
                            aria-label={`Edit ${a.code}`}
                            onClick={() => openEdit(a)}
                            style={{ background: 'none', border: 'none', padding: 2, cursor: 'pointer', color: 'var(--fg-muted)' }}
                          >
                            <Pencil size={14} strokeWidth={1.75} />
                          </button>
                          <button
                            type="button"
                            aria-label={`Delete ${a.code}`}
                            onClick={() => void onDelete(a)}
                            disabled={doDelete.isPending}
                            style={{ background: 'none', border: 'none', padding: 2, cursor: 'pointer', color: 'var(--fg-muted)' }}
                          >
                            <Trash2 size={14} strokeWidth={1.75} />
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  );
};
