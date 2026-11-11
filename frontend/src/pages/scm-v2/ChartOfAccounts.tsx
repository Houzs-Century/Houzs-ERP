// ----------------------------------------------------------------------------
// ChartOfAccounts — Finance › Setup › Chart of accounts (/scm/chart-of-accounts),
// in the owner's Claude Design redesign (Finance-1a-Setup, batch 6 §6.1).
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
//
// The redesign re-skins the same calls: section rows and the tree in the
// design's look, the forms (New account, Edit) as centred modals, the asks
// (untick, delete, move, rename) as the app's confirm, English words. The ERP's
// own columns (Needs event, PMS row, Logistics), the new account's company
// ticks (every company, as today — owner question g6) and the active company's
// own list (header ⋯) all stay.
// ----------------------------------------------------------------------------

import { Fragment, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as XLSX from 'xlsx';
import { ChevronDown, ChevronRight, FileSpreadsheet, MoreHorizontal, PenLine, Plus, Search, Upload, X } from 'lucide-react';
import { Button } from '@2990s/design-system';
import {
  useChartUnion, useChartTick, useChartImport,
  useChartRename, useChartUpdate, useChartDelete, useChartCreate, isControlSpecial,
  type ChartRow, type ChartImportRow, type AccountSection,
} from '../../vendor/scm/lib/accounting-queries';
import { useAuth as useHouzsAuth } from '../../auth/AuthContext';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { useToastOptional } from '../../hooks/useToast';
import { PageHeader } from '../../components/Layout';
import { Check, Field, PopMenu, SetupModal, Skeleton, Switch, Tag } from './finance/SetupParts';
import sp from './finance/SetupParts.module.css';
import css from './ChartOfAccounts.module.css';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

/* ── The AutoCount export, parsed (the scan page's discipline) ───────────── */

const CODE_RE = /^(\s*)(\d{3}-[A-Za-z0-9]{4})\s*$/;

/* The section headings → type map is NOT written here: the server hands the
   vocabulary down (GET /accounting/chart `sections`, one home in backend
   lib/account-sections.ts) and the parser takes it as an argument, so the
   import, the page headers and the Section pickers can never disagree. */

/* Company-specific by nature: banks and cash are THIS company's accounts
   (SBK/SCH), and the related-party/director/HP/borrowing series name real
   counterparties of one company. Everything else defaults to shared — the
   tick columns are where a person narrows afterwards. */
const isExclusive = (code: string, special: string): boolean =>
  ['SBK', 'SCH'].includes(special) || /^(350|351|430|450|451|460|406)-/.test(code);

export type ParsedChart = { rows: ChartImportRow[]; sections: string[]; unknownSections: string[] };

export function parseChartXlsx(wb: XLSX.WorkBook, known: ReadonlyArray<AccountSection>): ParsedChart {
  const sheet = wb.Sheets[wb.SheetNames[0]!];
  const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet!, { header: 1, raw: false });
  const typeOf = new Map(known.map((s) => [s.section, s.type]));
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
        if (!typeOf.has(label)) unknownSections.push(label);
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
      accountType: typeOf.get(section) ?? 'EXPENSE',
      section: typeOf.has(section) ? section : null,
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

/* The shelf for a row the server has not sectioned (predates the migration). */
const UNSECTIONED = 'UNSECTIONED';

/** An account code the server takes: NNN-XXXX. */
const ACCOUNT_CODE = /^\d{3}-[A-Za-z0-9]{4}$/;

/** The server's section words in sentence case: CURRENT ASSETS → Current assets. */
const sectionLabel = (section: string): string => (section === UNSECTIONED
  ? 'Not sectioned'
  : (section.charAt(0) + section.slice(1).toLowerCase()).replace(/\ba\/c\b/g, 'A/C'));
/** ASSET → Asset. */
const typeLabel = (type: string): string => type.charAt(0) + type.slice(1).toLowerCase();
const plural = (n: number, one: string, many: string): string => (n === 1 ? `1 ${one}` : `${n} ${many}`);

/* AutoCount's special-account kinds, in the design's words. */
const SPECIAL_TYPES: Array<[string, string]> = [
  ['SBK', 'SBK · bank'], ['SCH', 'SCH · cash'], ['SOP', 'SOP · e-wallet / other'],
  ['SFA', 'SFA · fixed asset, with its depreciation pair'], ['SAD', 'SAD · accumulated depreciation'],
  ['SRE', 'SRE · retained earnings'], ['SDP', 'SDP · deferred'],
  ['SOS', 'SOS · opening stock'], ['SCS', 'SCS · closing stock'],
  ['SDC', 'SDC · debtor control, posted by modules'], ['SCC', 'SCC · creditor control, posted by modules'],
  ['SBS', 'SBS · stock control, posted by modules'],
];

const errText = (e: unknown, fallback: string): string => (e instanceof Error && e.message ? e.message : fallback);

type NewForm = {
  code: string; name: string; section: string; parent: string; special: string; money: boolean;
  depOn: boolean; depCode: string; depName: string; companies: number[]; error: string | null;
};
type EditForm = { row: ChartRow; code: string; name: string; section: string; parent: string; error: string | null };

export const ChartOfAccounts = () => {
  const askConfirm = useConfirm();
  const notify = useNotify();
  const toast = useToastOptional();
  const navigate = useNavigate();
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

  /* Needs event / PMS row (item 4) / Logistics row: one field at a time, a refusal said out loud. */
  const setEventFields = async (code: string, patch: { needsEvent?: boolean; pmsRow?: string | null; logisticsRow?: string | null }) => {
    try { await doUpdate.mutateAsync({ code, ...patch }); } catch (e) {
      void notify({ title: `${code} not saved`, body: errText(e, 'Try again.'), tone: 'error' });
    }
  };

  const companies = useMemo(() => unionQ.data?.companies ?? [], [unionQ.data]);
  const coCode = (id: number): string => companies.find((co) => co.id === id)?.code ?? String(id);
  const accounts = useMemo(() => treeOrder(unionQ.data?.accounts ?? []), [unionQ.data]);
  const byCode = useMemo(() => new Map(accounts.map((a) => [a.code, a])), [accounts]);
  const sections = useMemo(() => unionQ.data?.sections ?? [], [unionQ.data]);
  /* Needs event / PMS row (owner 2026-10-01, payment-request item 4): the rows a
     Finance account can fill on the PMS event page — the server's one list. */
  const pmsRows = useMemo(() => unionQ.data?.pmsRows ?? [], [unionQ.data]);
  /* The Logistics P&L's rows (owner 2026-10-29: the own-lorry tick list moved here —
     「就不能在coa 那边tick？」): each offered on accounts of the type it reads. */
  const logisticsRows = useMemo(() => unionQ.data?.logisticsRows ?? [], [unionQ.data]);
  const kidsOf = useMemo(() => {
    const m = new Map<string, ChartRow[]>();
    for (const a of accounts) {
      if (!a.parentCode) continue;
      const list = m.get(a.parentCode) ?? [];
      list.push(a);
      m.set(a.parentCode, list);
    }
    return m;
  }, [accounts]);
  const kidCount = (code: string): number => kidsOf.get(code)?.length ?? 0;

  /* ── The AutoCount tree (owner 2026-09-06: 每个 account type 的 header):
     one header row per SECTION in the server's order, the accounts of that
     section as a tree beneath it. A row whose section the server does not
     know (older than the migration) trails under UNSECTIONED rather than
     vanishing — a chart that hides an account is worse than one with an
     odd shelf. */
  const sectioned = useMemo(() => {
    const all = unionQ.data?.accounts ?? [];
    const groups = new Map<string, ChartRow[]>();
    const names = new Set(sections.map((s) => s.section));
    for (const a of all) {
      const key = a.section && names.has(a.section) ? a.section : UNSECTIONED;
      const list = groups.get(key) ?? [];
      list.push(a);
      groups.set(key, list);
    }
    const out: Array<{ section: string; type: string; rows: ChartRow[] }> = [];
    for (const s of sections) {
      const rows = groups.get(s.section);
      if (rows && rows.length > 0) out.push({ section: s.section, type: s.type, rows: treeOrder(rows) });
    }
    const rest = groups.get(UNSECTIONED);
    if (rest && rest.length > 0) out.push({ section: UNSECTIONED, type: '', rows: treeOrder(rest) });
    return out;
  }, [unionQ.data, sections]);
  const [foldedSections, setFoldedSections] = useState<Set<string>>(new Set());
  const toggleSection = (section: string) => {
    setFoldedSections((prev) => {
      const next = new Set(prev);
      if (next.has(section)) next.delete(section); else next.add(section);
      return next;
    });
  };
  const [parsed, setParsed] = useState<(ParsedChart & { file: string }) | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  /* Quick mode — session-only, never persisted: every visit starts with the
     confirms back on (see the switch's title). */
  const [quickMode, setQuickMode] = useState(false);
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const [headMenu, setHeadMenu] = useState<{ x: number; y: number } | null>(null);

  /* ── 展开/收缩 (owner point 4): fold a header, its whole subtree hides. ── */
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const parentOf = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const a of accounts) m.set(a.code, a.parentCode);
    return m;
  }, [accounts]);
  /* Depth per code — the indent must STEP with the level (owner 2026-09-04:
     父子account 不清楚; the old indent was a has-parent boolean, so a
     grandchild sat as shallow as its parent). Same 6-level cap as isHidden. */
  const depthOf = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of accounts) {
      let d = 0;
      let cursor = a.parentCode ?? null;
      while (cursor && d < 6) { d += 1; cursor = parentOf.get(cursor) ?? null; }
      m.set(a.code, d);
    }
    return m;
  }, [accounts, parentOf]);
  /* Other income = anything hanging under 700-0000 — the owner's one-header
     split (2026-09-04: other income 我想挂在 700-0000; 就做一个 header 分类).
     DERIVED from the tree, never a second stored flag, so the badge can't
     contradict where the account actually hangs. Not under it = 正常生意
     income, deliberately unlabelled (别乱分类). */
  const OTHER_INCOME_HEADER = '700-0000';
  const isOtherIncome = (code: string): boolean => {
    let cursor: string | null = code;
    for (let d = 0; cursor && d < 7; d += 1) {
      if (cursor === OTHER_INCOME_HEADER) return true;
      cursor = parentOf.get(cursor) ?? null;
    }
    return false;
  };
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
  /* Every descendant still active in one company — what an untick there takes
     with it (the server walks the same way: active children, then theirs). */
  const activeBelow = (code: string, companyId: number): number => {
    let n = 0;
    const walk = (c: string, depth: number) => {
      if (depth > 6) return;
      for (const k of kidsOf.get(c) ?? []) {
        if (k.perCompany[companyId]?.active !== true) continue;
        n += 1;
        walk(k.code, depth + 1);
      }
    };
    walk(code, 0);
    return n;
  };

  /* ── 拖动改父户 (the owner, 2026-09-03: 我希望可以拖动式 put account under
     别的 account). Drop A onto B → confirm → B becomes A's header. The moved
     account keeps its GL (lines hang on its own code); the SERVER holds the
     rule — a target with postings or references refuses (a header never
     books), same type only, no cycles — and its sentence is shown on refusal. */
  const [dragCode, setDragCode] = useState<string | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const endDrag = () => { setDragCode(null); setDropOn(null); };
  const onDropInto = async (target: ChartRow) => {
    const src = dragCode;
    endDrag();
    if (!src || src === target.code) return;
    const srcRow = byCode.get(src);
    if (!srcRow || (srcRow.parentCode ?? '') === target.code) return;
    const ok = await askConfirm({
      title: `Put ${src} ${srcRow.name} under ${target.code} ${target.name}?`,
      body: `${target.code} becomes its header. A header never books, so an account with postings or references cannot become one; the move itself never touches the ledger.`,
      confirmLabel: 'Move',
    });
    if (!ok) return;
    try {
      await doUpdate.mutateAsync({ code: src, parentCode: target.code });
      toast?.success(`${src} is now under ${target.code}`);
    } catch (e) {
      void notify({ title: `${src} not moved`, body: errText(e, 'Something went wrong.'), tone: 'error' });
    }
  };

  /* ── 换节 (the owner, 2026-09-06: 你先帮我分类,然后我自己还能调动 — 用拖拉式).
     Drop a HEADER-level account on a section row → confirm → it and its
     subtree move there; the type follows the section (the server's rule),
     and the reports follow the section. A child is refused with its header
     named — 子户跟着 header 走. */
  const onDropIntoSection = async (section: string) => {
    const src = dragCode;
    endDrag();
    if (!src || section === UNSECTIONED) return;
    const srcRow = byCode.get(src);
    if (!srcRow || srcRow.section === section) return;
    if (srcRow.parentCode) {
      void notify({
        title: `${src} is under ${srcRow.parentCode}`,
        body: `A child moves with its header — drag ${srcRow.parentCode} instead, or take ${src} out from under it first.`,
        tone: 'error',
      });
      return;
    }
    const newType = sections.find((s) => s.section === section)?.type ?? srcRow.type;
    const kids = kidCount(src);
    const label = sectionLabel(section);
    const ok = await askConfirm({
      title: `Move ${src} ${srcRow.name} to ${label}?`,
      body: `It${kids > 0 ? ` and the ${plural(kids, 'account', 'accounts')} under it` : ''} move${kids > 0 ? '' : 's'} to ${label}${newType !== srcRow.type ? ` and take its type, ${typeLabel(newType)}; the statements follow the section` : ''}. The ledger is untouched.`,
      confirmLabel: 'Move',
    });
    if (!ok) return;
    try {
      await doUpdate.mutateAsync({ code: src, section });
      toast?.success(`${src} moved to ${label}`);
    } catch (e) {
      void notify({ title: `${src} not moved`, body: errText(e, 'Something went wrong.'), tone: 'error' });
    }
  };

  /* ── 改码/改名 (owner point 1): Edit is a centred modal. A changed code goes
     through the rename RPC (改码全账跟); name/section/parent ride the update.
     The backdrop does not close it (owner 2026-09-04: a stray click must not
     eat a half-typed rename) — Cancel is the way out. ── */
  const [edit, setEdit] = useState<EditForm | null>(null);
  const openEdit = (row: ChartRow) => setEdit({
    row, code: row.code, name: row.name, section: row.section ?? '', parent: row.parentCode ?? '', error: null,
  });
  const patchEdit = (patch: Partial<EditForm>) => setEdit((f) => (f ? { ...f, error: null, ...patch } : f));
  const saveEdit = async () => {
    if (!edit) return;
    const { row } = edit;
    const code = edit.code.trim();
    const name = edit.name.trim();
    if (!ACCOUNT_CODE.test(code)) { patchEdit({ error: 'The code must look like 305-0010.' }); return; }
    if (code !== row.code && byCode.has(code)) { patchEdit({ error: `${code} is already in the chart.` }); return; }
    if (!name) { patchEdit({ error: 'Name the account.' }); return; }
    const codeChanged = code !== row.code;
    const nameChanged = name !== row.name;
    const sectionChanged = edit.section !== '' && edit.section !== (row.section ?? '');
    const parentChanged = edit.parent.trim() !== (row.parentCode ?? '');
    if (!codeChanged && !nameChanged && !sectionChanged && !parentChanged) { setEdit(null); return; }
    if (codeChanged) {
      const ok = await askConfirm({
        title: `Rename ${row.code} to ${code} everywhere?`,
        body: 'Every journal line, voucher, settlement link and role binding moves to the new code in one step, or none of it does.',
        confirmLabel: 'Rename everywhere',
      });
      if (!ok) return;
    }
    let moved = '';
    let renamed = false;
    try {
      if (codeChanged) {
        const res = await doRename.mutateAsync({ oldCode: row.code, newCode: code });
        renamed = true;
        moved = Object.entries(res.moved).filter(([, n]) => Number(n) > 0)
          .map(([k, n]) => `${k.replace(/_/g, ' ')} ${n}`).join(', ');
      }
      if (nameChanged || sectionChanged || parentChanged) {
        await doUpdate.mutateAsync({
          code: codeChanged ? code : row.code,
          ...(nameChanged ? { name } : {}),
          ...(sectionChanged ? { section: edit.section } : {}),
          ...(parentChanged ? { parentCode: edit.parent.trim() || null } : {}),
        });
      }
      setEdit(null);
      toast?.success(codeChanged ? `${row.code} renamed to ${code} everywhere${moved ? ` · moved ${moved}` : ''}` : `${code} saved`);
    } catch (e) {
      /* A rename that went through stays; the form now stands on the new code. */
      patchEdit({ ...(renamed ? { row: { ...row, code } } : {}), error: errText(e, 'Something went wrong.') });
    }
  };

  /* ── 一个门开户 (owner 2026-09-03: 照理说应该维护 overall chart 罢了):
     the definition is created once, lands in every ticked company, parent
     chain riding along per company. Every company starts ticked (owner
     question g6 — today's default). ── */
  const [form, setForm] = useState<NewForm | null>(null);
  const openAdd = () => setForm({
    code: '', name: '', section: '', parent: '', special: '', money: false,
    depOn: true, depCode: '', depName: '', companies: companies.map((co) => co.id), error: null,
  });
  const patchForm = (patch: Partial<NewForm>) => setForm((f) => (f ? { ...f, error: null, ...patch } : f));
  /* His chart's own SFA/SAD convention: the twin is the asset's code with the
     last digit +5 (201-1000 → 201-1005), named ACCUM. DEPRN. - <asset>. */
  const derivedDep = (assetCode: string, assetName: string): Pick<NewForm, 'depCode' | 'depName'> => {
    const m = /^(\d{3}-\d{3})(\d)$/.exec(assetCode.trim());
    return {
      depCode: m && Number(m[2]) < 5 ? `${m[1]}${Number(m[2]) + 5}` : '',
      depName: assetName.trim() ? `ACCUM. DEPRN. - ${assetName.trim()}` : '',
    };
  };
  const pickSpecial = (special: string) => {
    if (!form) return;
    patchForm({
      special,
      ...(special === 'SBK' || special === 'SCH' ? { money: true } : {}),
      ...(special === 'SFA' ? derivedDep(form.code, form.name) : {}),
    });
  };
  const formParent = form?.parent ? byCode.get(form.parent) : undefined;
  /* A child sits where its header sits — the section follows the parent (a
     parent older than the sections leaves the pick to the form). */
  const parentSection = formParent?.section ?? null;
  const formSection = parentSection ?? form?.section ?? '';
  const saveNew = async () => {
    if (!form) return;
    const code = form.code.trim();
    const name = form.name.trim();
    const special = form.special;
    if (!ACCOUNT_CODE.test(code)) { patchForm({ error: 'The code must look like 305-0010.' }); return; }
    if (byCode.has(code)) { patchForm({ error: `${code} is already in the chart.` }); return; }
    if (!name) { patchForm({ error: 'Name the account.' }); return; }
    if (!formSection) { patchForm({ error: 'Pick a section, or a parent.' }); return; }
    if (form.companies.length === 0) { patchForm({ error: 'Tick at least one company.' }); return; }
    const withDep = special === 'SFA' && form.depOn;
    const depCode = form.depCode.trim();
    const depName = form.depName.trim();
    if (withDep && (!ACCOUNT_CODE.test(depCode) || byCode.has(depCode) || depCode === code)) {
      patchForm({ error: 'Give the depreciation pair its own new code, e.g. 202-0001.' });
      return;
    }
    if (withDep && !depName) { patchForm({ error: 'Name the depreciation account.' }); return; }
    try {
      const res = await doCreate.mutateAsync({
        code,
        name,
        section: formSection,
        parentCode: form.parent.trim() || null,
        accMoney: form.money,
        ...(special ? { specialType: special } : {}),
        ...(withDep ? { depreciation: { code: depCode, name: depName } } : {}),
        companyIds: form.companies,
      });
      setForm(null);
      toast?.success(`Added ${res.code}${res.depreciationCode ? ` and ${res.depreciationCode}` : ''} · ticked for ${res.companies.map(coCode).join(' and ')}`);
    } catch (e) {
      patchForm({ error: errText(e, 'Something went wrong.') });
    }
  };

  /* ── 删除 (owner point 2): only a never-used code dies; the server names
     every holdout otherwise — that sentence goes straight to the dialog. A
     header is refused here already: its children hold it. ── */
  const onDelete = async (row: ChartRow) => {
    if (kidCount(row.code) > 0) {
      const said = `${row.code} cannot be deleted: it has children. Untick it instead.`;
      if (toast) toast.warning(said); else void notify({ title: said, tone: 'error' });
      return;
    }
    /* Quick mode goes straight through — safely: the SERVER's 11-probe guard
       still refuses any account with a record or reference anywhere, so the
       only thing a stray click can delete is a never-used code. */
    if (!quickMode) {
      const ok = await askConfirm({
        title: `Delete ${row.code} ${row.name}?`,
        body: 'Only an account with no transactions and no references anywhere can be deleted. This removes it from every company.',
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!ok) return;
    }
    try {
      await doDelete.mutateAsync(row.code);
      toast?.success(`${row.code} ${row.name} deleted from every company`);
    } catch (e) {
      void notify({ title: `${row.code} cannot be deleted`, body: errText(e, 'Something went wrong.'), tone: 'error' });
    }
  };

  const onTick = async (companyId: number, row: ChartRow, next: boolean) => {
    const co = coCode(companyId);
    if (!next) {
      const below = activeBelow(row.code, companyId);
      /* Quick mode silences the LEAF untick only — a header sweep still
         asks, whatever the switch says (its children do not come back by
         re-ticking the header). */
      if (!quickMode || below > 0) {
        const ok = await askConfirm({
          title: `Untick ${row.code} ${row.name} for ${co}?`,
          body: `${co} stops using it.${below > 0
            ? ` ${below === 1 ? 'Its 1 child is' : `Its ${below} children are`} unticked too, and ticking the header again does not bring ${below === 1 ? 'it' : 'them'} back.`
            : ''} Nothing it already booked changes.`,
          confirmLabel: 'Untick',
          danger: true,
        });
        if (!ok) return;
      }
    }
    setBusyKey(`${companyId}:${row.code}`);
    try {
      const res = (await tick.mutateAsync({ companyId, code: row.code, active: next })) as { instantiated?: string[]; disabled?: string[] } | null;
      if (next) {
        toast?.success(`${row.code} ticked for ${co}${(res?.instantiated?.length ?? 0) > 1 ? ' · its header rides along' : ''}`);
      } else {
        const also = Math.max(0, (res?.disabled?.length ?? 1) - 1);
        toast?.success(`${row.code} unticked for ${co}${also > 0 ? ` · ${plural(also, 'child', 'children')} too` : ''}`);
      }
    } catch (e) {
      void notify({ title: `${row.code} not changed for ${co}`, body: errText(e, 'Something went wrong.'), tone: 'error' });
    } finally {
      setBusyKey(null);
    }
  };

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    try {
      const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' });
      const p = parseChartXlsx(wb, sections);
      if (p.rows.length === 0) {
        void notify({ title: 'Nothing to import', body: 'No account codes were found in the file — is this the AutoCount chart export?', tone: 'error' });
        return;
      }
      setParsed({ ...p, file: f.name });
    } catch (e) {
      void notify({ title: 'Could not read the file', body: errText(e, 'Something went wrong.'), tone: 'error' });
    }
  };

  const runImport = async () => {
    if (!parsed) return;
    try {
      const res = await doImport.mutateAsync({ companyId: 1, rows: parsed.rows });
      setParsed(null);
      toast?.success(`Imported ${plural(res.imported, 'account', 'accounts')}${res.shared > 0 && res.sharedTo.length > 0
        ? ` · ${res.shared} shared with ${res.sharedTo.map(coCode).join(' and ')}` : ''}`);
    } catch (e) {
      void notify({ title: 'Import failed', body: errText(e, 'Something went wrong.'), tone: 'error' });
    }
  };

  const exclusiveRows = parsed?.rows.filter((r) => !r.shared) ?? [];
  const freshRows = parsed?.rows.filter((r) => !byCode.has(r.code)) ?? [];
  const knownCount = (parsed?.rows.length ?? 0) - freshRows.length;

  const hit = (a: ChartRow): boolean => !needle || `${a.code} ${a.name}`.toLowerCase().includes(needle);
  const usesCount = (companyId: number): number => accounts.filter((a) => a.perCompany[companyId]?.active === true).length;
  const countLine = [
    plural(accounts.length, 'account', 'accounts'),
    ...companies.map((co) => `${co.code} uses ${usesCount(co.id)}`),
  ].join(' · ');
  const colCount = 7 + companies.length + (canManage ? 1 : 0);
  let shownRows = 0;

  /* The header row sticks INSIDE the card's own scroll (owner 2026-09-04:
     往下滑时看不到 header / 按 edit 时要跑回上去): solid background + an inset
     shadow instead of a border — a border on the <tr> does not travel with
     sticky cells, the shadow does. */
  const stickyTh = {
    position: 'sticky' as const, top: 0, zIndex: 5, background: 'var(--hz-c-surface-2)', boxShadow: 'inset 0 -1px #e3e6e0',
  };

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Finance · Setup"
        title="Chart of accounts"
        description="Every account any company carries · tick per company"
        actions={
          <span className={css.headActs}>
            {canManage && (
              <>
                <input ref={fileRef} type="file" accept=".xlsx,.xls" hidden aria-label="Upload AutoCount chart"
                  onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ''; }} />
                <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()}>
                  <Upload {...ICON} /> Upload AutoCount chart
                </Button>
                <Button variant="primary" size="sm" onClick={openAdd}>
                  <Plus {...ICON} /> Add account
                </Button>
              </>
            )}
            <button type="button" className={sp.more} aria-label="More for the chart" title="This company's accounts"
              onClick={(e) => setHeadMenu({ x: e.clientX, y: e.clientY })}>
              <MoreHorizontal size={14} />
            </button>
          </span>
        }
      />

      <div className={sp.page}>
        <div className={sp.bar}>
          <label className={sp.search}>
            <Search size={13} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find an account by code or name" aria-label="Find an account" />
          </label>
          {accounts.length > 0 && <span className={sp.count}>{countLine}</span>}
          <span className={sp.grow} />
          {canManage && (
            /* Quick mode (owner 2026-09-04, mid tidy-up: tick 和 untick 的可以
               做到就不要 pop out notice 吗? delete 同理, 就 for 先阶段…过后
               这个 function 还是要有). The switch IS the "afterwards": it
               resets to OFF on every visit (his 默认都是要弹的), so the
               confirms return by themselves. ON skips the confirm for LEAF
               unticks and deletes only; a HEADER untick still asks (it sweeps
               the children, and re-ticking the header does not bring them
               back), and the server's delete guard still refuses any account
               with records. */
            <Switch on={quickMode} danger label="Quick mode · no confirms" onClick={() => setQuickMode((v) => !v)}
              title="Skips the confirm for leaf unticks and deletes. A header untick still asks. Off again on every visit.">
              Quick mode · no confirms
            </Switch>
          )}
        </div>

        {parsed && (
          <section className={`${sp.card} ${css.importCard}`} aria-label="Ready to import">
            <div className={css.importHead}>
              <FileSpreadsheet size={16} className={css.petrol} />
              <span className={css.importTitle}>Ready to import</span>
              <span className={sp.cardSub}>{parsed.file} · {plural(parsed.rows.length, 'account', 'accounts')} read</span>
              <span className={sp.grow} />
              <button type="button" className={sp.btn} onClick={() => setParsed(null)} disabled={doImport.isPending}>Cancel</button>
              <button type="button" className={sp.btnSolid} onClick={() => void runImport()} disabled={doImport.isPending}>
                {doImport.isPending ? 'Importing…' : 'Import'}
              </button>
            </div>
            <div className={css.importBody}>
              <div>
                {freshRows.length} {freshRows.length === 1 ? 'is' : 'are'} new and {knownCount} {knownCount === 1 ? 'is' : 'are'} already
                in the chart{knownCount > 0 ? ` — the file's name, section, parent and special type are written over ${knownCount === 1 ? 'it' : 'those'}, and ${knownCount === 1 ? 'it is' : 'they are'} ticked for ${coCode(1)} again` : ''}.
                {' '}Shared rows go to every company; banks, cash, related-party loans, directors and borrowings stay {coCode(1)}-only
                ({exclusiveRows.length}). Adjust any tick afterwards.
              </div>
              {parsed.unknownSections.length > 0 && (
                <div className={css.warnLine}>
                  Unknown heading{parsed.unknownSections.length === 1 ? '' : 's'} read as an expense account: {parsed.unknownSections.join(', ')} — check {parsed.unknownSections.length === 1 ? 'it' : 'them'} after the import.
                </div>
              )}
              {freshRows.length > 0 && (
                <div className={css.importRows}>
                  {freshRows.map((r) => (
                    <div key={r.code} className={css.importRow}>
                      <span className={css.importMuted}>{r.code}</span>
                      <span>{r.name}</span>
                      <span className={css.importMuted}>{r.section ? sectionLabel(r.section) : 'Unknown heading'}</span>
                      <span className={css.importMuted}>{r.shared ? 'shared' : `${coCode(1)} only`}</span>
                    </div>
                  ))}
                </div>
              )}
              {exclusiveRows.length > 0 && (
                <details className={css.details}>
                  <summary>The {coCode(1)}-only list ({exclusiveRows.length})</summary>
                  <div className={css.importRows}>
                    {exclusiveRows.map((r) => (
                      <div key={r.code} className={css.importRow}>
                        <span className={css.importMuted}>{r.code}</span>
                        <span>{r.name}</span>
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </div>
          </section>
        )}

        <section className={sp.card} aria-label="Every account, every company">
          {/* The LIST scrolls inside the card, not the page (owner 2026-09-04:
              按 edit 时要跑回上去 / 往下滑时看不到 header): its own scroll
              container is what lets the header row stick — .card carries
              overflow:hidden (its rounded corners), which would swallow a
              page-scroll sticky. */}
          <div className={css.scroller} style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: 'calc(100vh - 300px)', padding: 0 }}>
            {unionQ.isLoading && <Skeleton rows={10} label="Loading the chart" />}
            {unionQ.error != null && (
              <div className={sp.problem}>Failed to load the chart. {errText(unionQ.error, '')}</div>
            )}
            {!unionQ.isLoading && unionQ.error == null && accounts.length === 0 && (
              <div className={sp.empty}>No account in the chart yet — Upload AutoCount chart reads the accountant&apos;s file.</div>
            )}
            {accounts.length > 0 && (
              /* borderCollapse SEPARATE, not collapse: Chromium offsets sticky
                 th cells under collapsed borders (the strip the owner called 不好看). */
              <table className={css.tree} style={{ borderCollapse: 'separate', borderSpacing: 0 }}>
                <thead>
                  <tr>
                    <th style={stickyTh} className={css.th} aria-label="fold" />
                    <th style={stickyTh} className={css.th}>Code</th>
                    <th style={stickyTh} className={css.th}>Name</th>
                    <th style={stickyTh} className={css.th}>Type</th>
                    <th style={stickyTh} className={`${css.th} ${css.mid}`} title="A voucher or AP invoice line on this account needs its event before it is approved">Needs event</th>
                    <th style={stickyTh} className={css.th} title="Which row of the PMS event page this account's money fills">PMS row</th>
                    <th style={stickyTh} className={css.th} title="Which row of the Logistics P&L this account's money fills">Logistics</th>
                    {companies.map((co) => (
                      <th key={co.id} style={stickyTh} className={`${css.th} ${css.mid}`}>{co.code}</th>
                    ))}
                    {canManage && <th style={stickyTh} className={css.th} aria-label="actions" />}
                  </tr>
                </thead>
                <tbody>
                  {sectioned.map((grp) => {
                    const rows = grp.rows.filter((a) => hit(a) && (needle !== '' || !isHidden(a.code)));
                    if (needle && rows.length === 0) return null;
                    const sectionFolded = !needle && foldedSections.has(grp.section);
                    const secDrop = dropOn === `section:${grp.section}`;
                    return (
                      <Fragment key={grp.section}>
                        {/* The section row: AutoCount's header line. Fold it, or
                            drop an account on it to re-shelve (换节). */}
                        <tr className={secDrop ? `${css.secRow} ${css.dropOn}` : css.secRow}
                          onDragOver={(e) => {
                            if (!canManage || !dragCode) return;
                            e.preventDefault();
                            if (!secDrop) setDropOn(`section:${grp.section}`);
                          }}
                          onDrop={(e) => { e.preventDefault(); void onDropIntoSection(grp.section); }}>
                          <td colSpan={colCount} data-section={grp.section} className={css.secCell}>
                            <button type="button" className={css.secFold}
                              aria-label={`${sectionFolded ? 'Expand' : 'Collapse'} section ${grp.section}`}
                              onClick={() => toggleSection(grp.section)}>
                              {sectionFolded ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                              <span>{sectionLabel(grp.section)}</span>
                              <span className={css.secSub}>{grp.type ? `${grp.type} · ` : ''}{plural(grp.rows.length, 'account', 'accounts')}</span>
                            </button>
                          </td>
                        </tr>
                        {!sectionFolded && rows.map((a) => {
                          shownRows += 1;
                          const kids = kidCount(a.code);
                          const isParent = kids > 0;
                          const isControl = isControlSpecial(a.special);
                          const depth = depthOf.get(a.code) ?? 0;
                          const indent = { paddingLeft: 10 + depth * 18 };
                          const rowClass = [
                            css.accRow, isParent ? css.parentRow : '', dragCode === a.code ? css.dragging : '',
                            dropOn === `account:${a.code}` ? css.dropOn : '',
                          ].filter(Boolean).join(' ');
                          return (
                            <tr key={a.code} data-code={a.code} className={rowClass}
                              draggable={canManage}
                              onDragStart={(e) => {
                                setDragCode(a.code);
                                try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', a.code); } catch { /* no dataTransfer outside a browser */ }
                              }}
                              onDragOver={(e) => {
                                if (!canManage || !dragCode || dragCode === a.code) return;
                                e.preventDefault();
                                if (dropOn !== `account:${a.code}`) setDropOn(`account:${a.code}`);
                              }}
                              onDrop={(e) => { e.preventDefault(); void onDropInto(a); }}
                              onDragEnd={endDrag}>
                              <td className={css.foldCell}>
                                {isParent && (
                                  <button type="button" className={css.fold}
                                    aria-label={`${folded.has(a.code) ? 'Expand' : 'Collapse'} ${a.code}`}
                                    title={folded.has(a.code) ? `Show its ${plural(kids, 'account', 'accounts')}` : `Fold its ${plural(kids, 'account', 'accounts')}`}
                                    onClick={() => toggleFold(a.code)}>
                                    {folded.has(a.code) ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                                  </button>
                                )}
                              </td>
                              <td className={isParent ? `${css.codeCell} ${css.codeParent}` : css.codeCell} style={indent}
                                title={canManage ? 'Drag onto another account to put it under it, or onto a section' : undefined}>
                                <span className={css.codeInner}>
                                  {depth > 0 && <span className={css.grip} aria-hidden="true" />}
                                  {a.code}
                                </span>
                              </td>
                              <td className={css.nameCell} style={indent}>
                                <span className={css.nameInner}>
                                  <span className={isParent ? `${css.name} ${css.nameParent}` : css.name}>{a.name}</span>
                                  {a.accMoney && <Tag tone="info">money</Tag>}
                                  {isParent && <Tag tone="calm">header</Tag>}
                                  {a.special != null && a.special !== '' && (
                                    <Tag tone="brass">{a.special}{isControl ? ' · control' : ''}</Tag>
                                  )}
                                </span>
                              </td>
                              <td className={css.typeCell}>
                                {typeLabel(a.type)}
                                {a.type === 'INCOME' && isOtherIncome(a.code) && ' · other'}
                              </td>
                              {/* Needs event and the PMS row: a money account a line can debit — not a header. */}
                              <td className={css.mid}>
                                {!isParent && (a.type === 'EXPENSE' || a.type === 'ASSET') && (
                                  <input type="checkbox" className={css.tick} checked={a.needsEvent === true} disabled={!canManage || doUpdate.isPending}
                                    aria-label={`${a.code} needs its event`}
                                    onChange={(e) => { void setEventFields(a.code, { needsEvent: e.target.checked }); }} />
                                )}
                              </td>
                              <td>
                                {!isParent && (a.type === 'EXPENSE' || a.type === 'ASSET') && (
                                  <select value={a.pmsRow ?? ''} disabled={!canManage || doUpdate.isPending} aria-label={`${a.code} PMS row`}
                                    className={`${sp.select} ${sp.compact} ${css.pick}`}
                                    onChange={(e) => { void setEventFields(a.code, { pmsRow: e.target.value || null }); }}>
                                    <option value="">—</option>
                                    {pmsRows.map((r) => <option key={r.row} value={r.row}>{r.label}</option>)}
                                  </select>
                                )}
                              </td>
                              {/* The Logistics row: an account a line can carry — not a header — of the type the row reads. */}
                              <td>
                                {!isParent && logisticsRows.some((r) => r.type === a.type) && (
                                  <select value={a.logisticsRow ?? ''} disabled={!canManage || doUpdate.isPending} aria-label={`${a.code} Logistics row`}
                                    className={`${sp.select} ${sp.compact} ${css.pick}`}
                                    onChange={(e) => { void setEventFields(a.code, { logisticsRow: e.target.value || null }); }}>
                                    <option value="">—</option>
                                    {logisticsRows.filter((r) => r.type === a.type).map((r) => <option key={r.row} value={r.row}>{r.label}</option>)}
                                  </select>
                                )}
                              </td>
                              {companies.map((co) => {
                                const active = a.perCompany[co.id]?.active === true;
                                const key = `${co.id}:${a.code}`;
                                return (
                                  <td key={co.id} className={css.mid}>
                                    <input
                                      type="checkbox"
                                      className={css.tick}
                                      aria-label={`${a.code} for ${co.code}`}
                                      title={active ? `Untick for ${co.code}` : `Tick for ${co.code}`}
                                      checked={active}
                                      disabled={!canManage || busyKey === key || tick.isPending}
                                      onChange={(e) => void onTick(co.id, a, e.target.checked)}
                                    />
                                  </td>
                                );
                              })}
                              {canManage && (
                                <td className={css.actCell}>
                                  <span className={sp.acts}>
                                    <button type="button" className={sp.iconBtn} aria-label={`Edit ${a.code}`} title="Edit" onClick={() => openEdit(a)}>
                                      <PenLine size={13} />
                                    </button>
                                    <button type="button" className={`${sp.iconBtn} ${isParent ? sp.iconOff : sp.iconDanger}`}
                                      aria-label={`Delete ${a.code}`}
                                      title={isParent ? 'Has children · untick instead' : 'Delete'}
                                      disabled={doDelete.isPending}
                                      onClick={() => void onDelete(a)}>
                                      <X size={13} />
                                    </button>
                                  </span>
                                </td>
                              )}
                            </tr>
                          );
                        })}
                      </Fragment>
                    );
                  })}
                  {needle !== '' && shownRows === 0 && (
                    <tr><td colSpan={colCount} className={sp.empty}>No account matches.</td></tr>
                  )}
                </tbody>
              </table>
            )}
          </div>
          <div className={sp.cardFoot}>
            One tree of every account any company carries. A tick means that company uses the account; a new company is a new
            column. Unticking a header unticks its children, and a header never books — its accounts do. An account with
            transactions or references cannot be deleted; untick it instead. Drag an account onto another to put it under it, or
            onto a section to move it there.
          </div>
        </section>
      </div>

      {form && (
        <SetupModal
          title="New account"
          sub={form.companies.length === 0
            ? 'Tick the companies that use it.'
            : `Ticked for ${form.companies.map(coCode).join(' and ')} when it is created; untick a company that does not use it.`}
          okLabel="Add account"
          busyLabel="Adding…"
          busy={doCreate.isPending}
          error={form.error}
          onOk={() => void saveNew()}
          onCancel={() => setForm(null)}
        >
          <Field label="Code (NNN-XXXX)" w="32%">
            <input className={sp.input} value={form.code} placeholder="305-0010" onChange={(e) => patchForm({ code: e.target.value })} />
          </Field>
          <Field label="Name" w="64%">
            <input className={sp.input} value={form.name} onChange={(e) => patchForm({ name: e.target.value })} />
          </Field>
          <Field label="Section · decides the type" hint={parentSection != null ? 'A child follows its header’s section.' : undefined}>
            <select className={sp.select} value={formSection} aria-label="New account section" disabled={parentSection != null}
              onChange={(e) => patchForm({ section: e.target.value })}>
              <option value="">— section —</option>
              {sections.map((s) => <option key={s.section} value={s.section}>{sectionLabel(s.section)} · {typeLabel(s.type)}</option>)}
            </select>
          </Field>
          <Field label="Parent (optional)">
            <select className={sp.select} value={form.parent} aria-label="New account parent" onChange={(e) => patchForm({ parent: e.target.value })}>
              <option value="">— none —</option>
              {accounts.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}
            </select>
          </Field>
          <Field label="Special type" w="100%">
            <select className={sp.select} value={form.special} aria-label="Special type" onChange={(e) => pickSpecial(e.target.value)}>
              <option value="">— none —</option>
              {SPECIAL_TYPES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
            </select>
          </Field>
          <Field label="Money account" w="100%" group>
            <Check checked={form.money} onChange={(money) => patchForm({ money })}>Money — a bank, cash or e-wallet account</Check>
          </Field>
          {form.special === 'SFA' && (
            <>
              <Field label="Depreciation pair" w="100%" group>
                <Check checked={form.depOn} onChange={(depOn) => patchForm({ depOn })}>Also create its accumulated depreciation account</Check>
              </Field>
              {form.depOn && (
                <>
                  <Field label="Depreciation code" w="32%">
                    <input className={sp.input} value={form.depCode} placeholder="202-0001" aria-label="Depreciation code"
                      onChange={(e) => patchForm({ depCode: e.target.value })} />
                  </Field>
                  <Field label="Depreciation name" w="64%"
                    hint={<button type="button" className={sp.link} onClick={() => patchForm(derivedDep(form.code, form.name))}>Fill by convention (+5 · ACCUM. DEPRN.)</button>}>
                    <input className={sp.input} value={form.depName} placeholder="ACCUM. DEPRN. - …" aria-label="Depreciation name"
                      onChange={(e) => patchForm({ depName: e.target.value })} />
                  </Field>
                </>
              )}
            </>
          )}
          <Field label="Companies" w="100%" group>
            <span className={css.companyTicks}>
              {companies.map((co) => (
                <Check key={co.id} label={`new account for ${co.code}`} checked={form.companies.includes(co.id)}
                  onChange={(on) => patchForm({ companies: on ? companies.map((c) => c.id).filter((id) => id === co.id || form.companies.includes(id)) : form.companies.filter((id) => id !== co.id) })}>
                  {co.code}
                </Check>
              ))}
            </span>
          </Field>
        </SetupModal>
      )}

      {edit && (
        <SetupModal
          title={`Edit ${edit.row.code}`}
          sub="A new code moves every journal line, voucher, settlement link and role binding with it."
          okLabel="Save"
          busyLabel="Saving…"
          busy={doRename.isPending || doUpdate.isPending}
          error={edit.error}
          onOk={() => void saveEdit()}
          onCancel={() => setEdit(null)}
        >
          <Field label="Code" w="32%">
            <input className={sp.input} value={edit.code} aria-label="Edit code" onChange={(e) => patchEdit({ code: e.target.value })} />
          </Field>
          <Field label="Name" w="64%">
            <input className={sp.input} value={edit.name} aria-label="Edit name" onChange={(e) => patchEdit({ name: e.target.value })} />
          </Field>
          <Field label="Section" hint={edit.row.parentCode != null ? 'A child follows its header’s section.' : undefined}>
            <select className={sp.select} value={edit.section} aria-label="Edit section" disabled={edit.row.parentCode != null}
              onChange={(e) => patchEdit({ section: e.target.value })}>
              {!edit.section && <option value="">— section —</option>}
              {sections.map((s) => <option key={s.section} value={s.section}>{sectionLabel(s.section)} · {typeLabel(s.type)}</option>)}
            </select>
          </Field>
          <Field label="Parent" hint="None puts it at the top of its section.">
            <select className={sp.select} value={edit.parent} aria-label="Edit parent" onChange={(e) => patchEdit({ parent: e.target.value })}>
              <option value="">— none —</option>
              {accounts.filter((x) => x.code !== edit.row.code && !isBelow(x.code, edit.row.code, parentOf)).map((x) => (
                <option key={x.code} value={x.code}>{x.code} {x.name}</option>
              ))}
            </select>
          </Field>
        </SetupModal>
      )}

      {headMenu && (
        <PopMenu x={headMenu.x} y={headMenu.y} label="Chart menu" onClose={() => setHeadMenu(null)}
          items={[{ label: 'This company’s accounts', onClick: () => navigate('/scm/accounting?tab=coa') }]} />
      )}
    </div>
  );
};

/** Whether `code` hangs anywhere under `ancestor` — a parent may not come from
    its own subtree. */
function isBelow(code: string, ancestor: string, parentOf: Map<string, string | null>): boolean {
  let cursor = parentOf.get(code) ?? null;
  for (let depth = 0; cursor && depth < 7; depth += 1) {
    if (cursor === ancestor) return true;
    cursor = parentOf.get(cursor) ?? null;
  }
  return false;
}
