// ----------------------------------------------------------------------------
// accounting-chart — the Chart of Accounts maintenance surface (roadmap A).
//
// The owner's design (2026-09-02), his words: 我要做选择性公用是因为往后可能会
// 在加公司，所以要可以公用，可能类似recon setup 我tick 后选择这个公司要不要用.
// One master picture of every account any company carries, a tick column per
// company — tick = that company uses the account, untick = it does not — and
// an import door for the accountant's AutoCount export, so a future company
// is a new tick column, never a new spreadsheet exercise.
//
// Three handlers, exported bare for the vitest harness (the supabaseAuth
// bridge cannot run there — same precedent as accountRoles):
//   GET  /accounting/chart         — the union across the caller's companies
//   PUT  /accounting/chart/tick    — enable/disable one code for one company
//   POST /accounting/chart/import  — bulk upsert the accountant's rows
//
// Permission: the same scm.payment_voucher.post key the rest of the chart
// surface uses (POST/PATCH /accounts, the roles window) — one key for "may
// shape the books".
//
// 父户不记账 is enforced at the GL gate (acc/engine rule 3: a header with
// children takes no money); requireLeafAccount here is the EARLY door for
// voucher drafts, so the operator hears the refusal at typing time, not at
// approval time.
// ----------------------------------------------------------------------------

import { hasHouzsPerm } from '../lib/houzs-perms';
import { ACCOUNT_SECTIONS, defaultSectionFor, isAccountSection, sectionType } from '../lib/account-sections';

const requireChartPerm = (c: any): boolean => hasHouzsPerm(c, 'scm.payment_voucher.post');

const ACCOUNT_TYPES = new Set(['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE']);

/* AutoCount's special-account vocabulary, from the accountant's own export
   (column 9). The three CONTROL kinds are the ones whose balances belong to a
   module, not to a hand: SDC debtor control (AR), SCC creditor control (AP +
   customer deposits), SBS balance-sheet stock. The owner's 2026-09-03 call:
   lock them — 由模块自动过账. */
const SPECIAL_RE = /^[A-Z]{2,4}$/;
const CONTROL_SPECIALS = new Set(['SDC', 'SCC', 'SBS']);
const ACCOUNT_CODE_RE = /^\d{3}-[A-Za-z0-9]{4}$/;

type AccountRow = {
  company_id: number;
  account_code: string;
  account_name: string;
  account_type: string;
  parent_code: string | null;
  is_active: boolean;
  acc_money: boolean | null;
  special_type: string | null;
  /** The AutoCount top node the account hangs under — decides account_type
      (lib/account-sections.ts). NULL only on a row older than the migration. */
  section: string | null;
};

/* Every field a definition COPY carries (tick-ON, create chains, re-parent
   instantiation) — one list, so a new column cannot be copied in one walk and
   forgotten in another. */
const DEFINITION_FIELDS = 'account_code, account_name, account_type, parent_code, acc_money, special_type, section';

/** The caller's company allow-list, fail-CLOSED like every scoping helper:
    no resolved list means no cross-company picture. */
const allowedIds = (c: any): number[] => {
  const ids = c.get('allowedCompanyIds') as number[] | undefined;
  if (Array.isArray(ids)) return ids;
  const active = c.get('companyId') as number | undefined;
  return typeof active === 'number' ? [active] : [];
};

/* ── GET /accounting/chart — the union, one row per code ─────────────────── */
export const chartUnionHandler = async (c: any): Promise<Response> => {
  if (!requireChartPerm(c)) {
    return c.json({ error: "You don't have permission to manage the chart of accounts." }, 403);
  }
  const ids = allowedIds(c);
  if (ids.length === 0) return c.json({ error: 'no_companies', message: 'No company grants resolve for this session.' }, 409);
  const sb = c.get('supabase');
  const { data, error } = await sb
    .from('accounts')
    .select(`company_id, is_active, ${DEFINITION_FIELDS}`)
    .in('company_id', ids);
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  /* One row per code. Definition fields prefer the LOWEST company id that
     carries the code (company 1 = the master book where the accountant's
     import lands), so a rename there leads the union. */
  const byCode = new Map<string, { code: string; name: string; type: string; parentCode: string | null; accMoney: boolean; special: string | null; section: string | null; definedBy: number; perCompany: Record<number, { active: boolean }> }>();
  for (const raw of (data ?? []) as AccountRow[]) {
    const cur = byCode.get(raw.account_code);
    if (!cur || raw.company_id < cur.definedBy) {
      byCode.set(raw.account_code, {
        code: raw.account_code,
        name: raw.account_name,
        type: raw.account_type,
        parentCode: raw.parent_code,
        accMoney: raw.acc_money === true,
        special: raw.special_type ?? null,
        section: raw.section ?? null,
        definedBy: raw.company_id,
        perCompany: { ...(cur?.perCompany ?? {}), [raw.company_id]: { active: raw.is_active } },
      });
    } else {
      cur.perCompany[raw.company_id] = { active: raw.is_active };
    }
  }
  const companies = ((c.get('companies') as Array<{ id: number; code: string; name?: string }> | undefined) ?? [])
    .filter((co) => ids.includes(co.id))
    .map((co) => ({ id: co.id, code: co.code }));
  return c.json({
    companies,
    /* The section vocabulary rides along, in render order — the page's
       headers, its Section pickers and the import's heading check all read
       THIS list, never a copy of their own. */
    sections: ACCOUNT_SECTIONS,
    accounts: [...byCode.values()].map(({ definedBy: _d, ...row }) => row),
  });
};

/* ── PUT /accounting/chart/tick — {companyId, code, active} ──────────────── */
export const chartTickHandler = async (c: any): Promise<Response> => {
  if (!requireChartPerm(c)) {
    return c.json({ error: "You don't have permission to manage the chart of accounts." }, 403);
  }
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const companyId = Number(body.companyId);
  const code = String(body.code ?? '').trim();
  const active = body.active === true;
  const ids = allowedIds(c);
  if (!Number.isInteger(companyId) || !ids.includes(companyId)) {
    return c.json({ error: 'company_not_yours', message: 'That company is not in your grants.' }, 403);
  }
  if (!code) return c.json({ error: 'code_required' }, 400);
  const sb = c.get('supabase');

  if (active) {
    /* Ticking may have to INSTANTIATE the row (and its parent — a child never
       arrives without its header, the tree stays whole) from the master
       definition: the lowest-company row that carries the code. */
    const chain: string[] = [];
    let cursor: string | null = code;
    for (let depth = 0; cursor && depth < 4; depth += 1) {
      chain.unshift(cursor);
      const lookRes: { data: unknown; error: { message: string } | null } = await sb
        .from('accounts')
        .select(`company_id, ${DEFINITION_FIELDS}`)
        .eq('account_code', cursor)
        .order('company_id')
        .limit(1)
        .maybeSingle();
      if (lookRes.error) return c.json({ error: 'load_failed', reason: lookRes.error.message }, 500);
      if (!lookRes.data) return c.json({ error: 'code_unknown', message: `${cursor} exists in no company's chart.` }, 404);
      cursor = (lookRes.data as AccountRow).parent_code;
    }
    for (const step of chain) {
      const defRes = await sb
        .from('accounts')
        .select(DEFINITION_FIELDS)
        .eq('account_code', step)
        .order('company_id')
        .limit(1)
        .maybeSingle();
      if (defRes.error) return c.json({ error: 'load_failed', reason: defRes.error.message }, 500);
      const d = defRes.data as AccountRow;
      const { error: upErr } = await sb.from('accounts').upsert({
        company_id: companyId,
        account_code: d.account_code,
        account_name: d.account_name,
        account_type: d.account_type,
        parent_code: d.parent_code,
        acc_money: d.acc_money === true,
        special_type: d.special_type ?? null,
        section: d.section ?? defaultSectionFor(d.account_type, d.account_code),
        is_active: true,
      }, { onConflict: 'company_id,account_code' });
      if (upErr) return c.json({ error: 'save_failed', reason: upErr.message }, 500);
    }
    return c.json({ ok: true, companyId, code, active: true, instantiated: chain });
  }

  /* Unticking cascades DOWN (owner's rule: untick 父 connects 子 — the
     confirm lives in the UI): the code and every active descendant in THAT
     company go inactive. Depth 2 today (the chart is two tiers), written as
     a loop so a deeper tree tomorrow still drains. */
  const toDisable = [code];
  let frontier = [code];
  for (let depth = 0; frontier.length > 0 && depth < 4; depth += 1) {
    const { data: kids, error: kErr } = await sb
      .from('accounts')
      .select('account_code')
      .eq('company_id', companyId)
      .in('parent_code', frontier)
      .eq('is_active', true);
    if (kErr) return c.json({ error: 'load_failed', reason: kErr.message }, 500);
    frontier = ((kids ?? []) as Array<{ account_code: string }>).map((k) => k.account_code);
    toDisable.push(...frontier);
  }
  const { error: offErr } = await sb
    .from('accounts')
    .update({ is_active: false })
    .eq('company_id', companyId)
    .in('account_code', toDisable);
  if (offErr) return c.json({ error: 'save_failed', reason: offErr.message }, 500);
  return c.json({ ok: true, companyId, code, active: false, disabled: toDisable });
};

/* ── POST /accounting/chart/import — the accountant's export, upserted ───── */
export const chartImportHandler = async (c: any): Promise<Response> => {
  if (!requireChartPerm(c)) {
    return c.json({ error: "You don't have permission to manage the chart of accounts." }, 403);
  }
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const ids = allowedIds(c);
  const targetId = Number(body.companyId ?? 1);
  if (!ids.includes(targetId)) {
    return c.json({ error: 'company_not_yours', message: 'That company is not in your grants.' }, 403);
  }
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (rows.length === 0) return c.json({ error: 'no_rows' }, 400);
  if (rows.length > 1000) return c.json({ error: 'too_many_rows', message: 'At most 1000 accounts per import.' }, 400);

  const clean: Array<{ code: string; name: string; type: string; parent: string | null; money: boolean; special: string | null; section: string; shared: boolean }> = [];
  const seen = new Set<string>();
  for (const [i, r] of rows.entries()) {
    const code = String(r?.code ?? '').trim();
    const name = String(r?.name ?? '').trim();
    /* The section HEADING the file put the row under, when it is one of the
       vocabulary; it decides the type. A row without one (an unknown heading
       — the screen names those) keeps the type it was sent with and takes the
       default shelf for it. */
    const sectionRaw = r?.section != null ? String(r.section).trim().toUpperCase() : '';
    const section = isAccountSection(sectionRaw) ? sectionRaw : null;
    const type = section ? String(sectionType(section)) : String(r?.accountType ?? '').trim().toUpperCase();
    if (!code || !name) return c.json({ error: 'bad_row', message: `Row ${i + 1} is missing code or name.` }, 400);
    if (!ACCOUNT_TYPES.has(type)) return c.json({ error: 'bad_row', message: `Row ${i + 1} (${code}): accountType must be ASSET / LIABILITY / EQUITY / INCOME / EXPENSE.` }, 400);
    if (seen.has(code)) return c.json({ error: 'bad_row', message: `Row ${i + 1}: ${code} appears twice in the file.` }, 400);
    const special = r?.specialType ? String(r.specialType).trim().toUpperCase() : null;
    if (special && !SPECIAL_RE.test(special)) {
      return c.json({ error: 'bad_row', message: `Row ${i + 1} (${code}): specialType ${special} is not a 2-4 letter AutoCount special code.` }, 400);
    }
    seen.add(code);
    clean.push({
      code, name, type,
      parent: r?.parentCode ? String(r.parentCode).trim() : null,
      money: r?.accMoney === true,
      special,
      section: section ?? defaultSectionFor(type, code),
      shared: r?.shared === true,
    });
  }
  /* Parents must be rows of the same file (or already known) — a child that
     points nowhere would orphan the tree. */
  for (const r of clean) {
    if (r.parent && !seen.has(r.parent)) {
      return c.json({ error: 'bad_row', message: `${r.code} names parent ${r.parent}, which is not in the file.` }, 400);
    }
  }

  const sb = c.get('supabase');
  const toUpsert = (companyId: number, subset: typeof clean) => subset.map((r) => ({
    company_id: companyId,
    account_code: r.code,
    account_name: r.name,
    account_type: r.type,
    parent_code: r.parent,
    acc_money: r.money,
    special_type: r.special,
    section: r.section,
    is_active: true,
  }));

  const { error: mainErr } = await sb.from('accounts')
    .upsert(toUpsert(targetId, clean), { onConflict: 'company_id,account_code' });
  if (mainErr) return c.json({ error: 'save_failed', reason: mainErr.message }, 500);

  /* 选择性公用: rows the caller marked shared land in EVERY granted company
     (the classification — skeleton shared, banks/related-party/director
     specific — is decided on the screen, per row, before this call; a parent
     of a shared row rides along even when itself unmarked, the tree stays
     whole). Nothing is ever un-ticked here — the screen's tick column is
     where a person narrows. */
  const sharedCodes = new Set(clean.filter((r) => r.shared).map((r) => r.code));
  for (const r of clean) {
    if (r.shared && r.parent) sharedCodes.add(r.parent);
  }
  const sharedRows = clean.filter((r) => sharedCodes.has(r.code));
  const others = ids.filter((id) => id !== targetId);
  for (const id of others) {
    if (sharedRows.length === 0) break;
    const { error: shErr } = await sb.from('accounts')
      .upsert(toUpsert(id, sharedRows), { onConflict: 'company_id,account_code' });
    if (shErr) return c.json({ error: 'save_failed', reason: `company ${id}: ${shErr.message}` }, 500);
  }

  return c.json({
    ok: true,
    companyId: targetId,
    imported: clean.length,
    sharedTo: sharedRows.length > 0 ? others : [],
    shared: sharedRows.length,
  });
};

/* ── The early leaf door for voucher drafts ──────────────────────────────────
   The GL gate (engine rule 3) refuses a parent at posting; this refuses it at
   TYPING, where the operator can still just pick the child. Two refusals live
   behind the same door: a header with active children (父户不记账) and a
   CONTROL account (SDC/SCC/SBS — AR, AP + deposits, stock), whose balance
   belongs to a module, never to a hand-picked line (owner 2026-09-03: 锁).
   Fails CLOSED on a read error — an unverifiable account does not get onto a
   money document. */
export const requireLeafAccount = async (
  c: any,
  companyId: number,
  code: string,
): Promise<Response | null> => {
  const sb = c.get('supabase');
  const { data: kids, error } = await sb
    .from('accounts')
    .select('account_code')
    .eq('company_id', companyId)
    .eq('parent_code', code)
    .eq('is_active', true)
    .limit(1);
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  if (((kids ?? []) as unknown[]).length > 0) {
    return c.json({
      error: 'not_a_leaf_account',
      message: `${code} is a header with sub-accounts — 父户不记账: pick the specific sub-account instead.`,
    }, 400);
  }
  const selfRes: { data: unknown; error: { message: string } | null } = await sb
    .from('accounts')
    .select('special_type')
    .eq('company_id', companyId)
    .eq('account_code', code)
    .limit(1)
    .maybeSingle();
  if (selfRes.error) return c.json({ error: 'load_failed', reason: selfRes.error.message }, 500);
  const special = (selfRes.data as { special_type?: string | null } | null)?.special_type ?? null;
  if (special && CONTROL_SPECIALS.has(special)) {
    return c.json({
      error: 'control_account_locked',
      message: `${code} is a control account (${special}) — 由模块自动过账 (AR/AP/stock post through their own flows); pick an ordinary account instead.`,
    }, 400);
  }
  return null;
};

/* ── POST /accounting/chart/account — ONE door to open an account ───────────
   The owner (2026-09-03): 照理说应该维护 overall chart of account 罢了. The
   old Accounting tab created the row in whichever company the caller stood
   in; this creates the DEFINITION once and lands it in every company the
   caller ticks (granted only, parents instantiated per company so the tree
   stays whole everywhere). A code that exists anywhere is refused — turning
   it on elsewhere is the tick column's job, changing it is rename's. */
export const chartCreateHandler = async (c: any): Promise<Response> => {
  if (!requireChartPerm(c)) {
    return c.json({ error: "You don't have permission to manage the chart of accounts." }, 403);
  }
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const ids = allowedIds(c);
  if (ids.length === 0) return c.json({ error: 'no_companies', message: 'No company grants resolve for this session.' }, 409);
  const code = String(body.code ?? '').trim();
  const name = String(body.name ?? '').trim();
  /* The SECTION decides the type (CAPITAL is EQUITY, COST OF GOODS SOLD is
     EXPENSE — lib/account-sections.ts); a caller naming only a type lands on
     that type's default shelf, the way the migration seeded the old rows. */
  const sectionRaw = body.section != null ? String(body.section).trim().toUpperCase() : '';
  const sectionShown = sectionRaw;
  if (sectionRaw && !isAccountSection(sectionRaw)) {
    return c.json({ error: 'bad_section', message: `${sectionShown} is not a section of the chart — pick one of ${ACCOUNT_SECTIONS.map((s) => s.section).join(' / ')}.` }, 400);
  }
  const type = sectionRaw ? String(sectionType(sectionRaw)) : String(body.accountType ?? '').trim().toUpperCase();
  const parent = body.parentCode ? String(body.parentCode).trim() : null;
  const special = body.specialType ? String(body.specialType).trim().toUpperCase() : null;
  const targets: number[] = Array.isArray(body.companyIds) && body.companyIds.length > 0
    ? body.companyIds.map(Number) : ids;
  if (!ACCOUNT_CODE_RE.test(code)) {
    return c.json({ error: 'bad_code', message: `${code || '(empty)'} is not in the NNN-XXXX account-code shape.` }, 400);
  }
  if (!name) return c.json({ error: 'bad_name', message: 'The account name cannot be empty.' }, 400);
  if (!ACCOUNT_TYPES.has(type)) {
    return c.json({ error: 'bad_type', message: 'accountType must be ASSET / LIABILITY / EQUITY / INCOME / EXPENSE.' }, 400);
  }
  const section = sectionRaw || defaultSectionFor(type, code);
  if (special && !SPECIAL_RE.test(special)) {
    return c.json({ error: 'bad_special', message: `${special} is not a 2-4 letter AutoCount special code.` }, 400);
  }
  if (parent === code) return c.json({ error: 'bad_parent', message: 'An account cannot be its own parent.' }, 400);
  for (const t of targets) {
    if (!Number.isInteger(t) || !ids.includes(t)) {
      return c.json({ error: 'company_not_yours', message: `Company ${t} is not in your grants.` }, 403);
    }
  }

  /* 固定资产带折旧 (the owner, 2026-09-03, the SFA/SAD pairs in hand: create
     new fixed assets 时照理就需要 create depreciation account): an SFA may
     bring its SAD twin in the SAME call — both validated up front, both
     created into the same companies, so a fixed asset never lands without
     somewhere for its depreciation to accumulate. */
  let dep: { code: string; name: string } | null = null;
  if (body.depreciation != null) {
    if (special !== 'SFA') {
      return c.json({ error: 'bad_depreciation', message: 'A depreciation twin rides only on an SFA (fixed asset) account.' }, 400);
    }
    const dCode = String(body.depreciation.code ?? '').trim();
    const dName = String(body.depreciation.name ?? '').trim();
    if (!ACCOUNT_CODE_RE.test(dCode)) {
      return c.json({ error: 'bad_code', message: `${dCode || '(empty)'} is not in the NNN-XXXX account-code shape.` }, 400);
    }
    if (!dName) return c.json({ error: 'bad_name', message: 'The depreciation account name cannot be empty.' }, 400);
    if (dCode === code) return c.json({ error: 'bad_depreciation', message: 'The depreciation account needs its own code.' }, 400);
    dep = { code: dCode, name: dName };
  }

  const sb = c.get('supabase');
  for (const candidate of dep ? [code, dep.code] : [code]) {
    const { data: exists, error: exErr } = await sb
      .from('accounts').select('company_id').eq('account_code', candidate).limit(1);
    if (exErr) return c.json({ error: 'load_failed', reason: exErr.message }, 500);
    if (((exists ?? []) as unknown[]).length > 0) {
      return c.json({
        error: 'code_exists',
        message: `${candidate} already exists — tick it on for a company instead, or rename it if the number is wrong.`,
      }, 409);
    }
  }

  /* The parent chain, from the master definition (lowest company carrying
     each code) — same walk as tick-ON, so a child never lands without its
     header in ANY company that receives it. */
  const chain: AccountRow[] = [];
  let cursor: string | null = parent;
  for (let depth = 0; cursor && depth < 4; depth += 1) {
    const lookRes: { data: unknown; error: { message: string } | null } = await sb
      .from('accounts')
      .select(DEFINITION_FIELDS)
      .eq('account_code', cursor)
      .order('company_id')
      .limit(1)
      .maybeSingle();
    if (lookRes.error) return c.json({ error: 'load_failed', reason: lookRes.error.message }, 500);
    if (!lookRes.data) return c.json({ error: 'parent_unknown', message: `Parent ${cursor} exists in no company's chart.` }, 400);
    chain.unshift(lookRes.data as AccountRow);
    cursor = (lookRes.data as AccountRow).parent_code;
  }
  /* A child sits where its header sits — a parent in another section would
     split the tree across two headers on the page. */
  const header = chain.length > 0 ? chain[chain.length - 1] : undefined;
  if (header?.section && header.section !== section) {
    return c.json({ error: 'section_mismatch', message: `${parent} sits under ${header.section} — a child takes its header's section (子户跟着 header 走).` }, 400);
  }

  /* SBK/SCH ARE money — the import applies the same equivalence; a manual
     create must not be able to disagree with the vocabulary. */
  const money = special === 'SBK' || special === 'SCH' ? true : body.accMoney === true;

  for (const companyId of targets) {
    for (const d of chain) {
      const { error: upErr } = await sb.from('accounts').upsert({
        company_id: companyId,
        account_code: d.account_code,
        account_name: d.account_name,
        account_type: d.account_type,
        parent_code: d.parent_code,
        acc_money: d.acc_money === true,
        special_type: d.special_type ?? null,
        section: d.section ?? defaultSectionFor(d.account_type, d.account_code),
        is_active: true,
      }, { onConflict: 'company_id,account_code' });
      if (upErr) return c.json({ error: 'save_failed', reason: upErr.message }, 500);
    }
    const { error: insErr } = await sb.from('accounts').upsert({
      company_id: companyId,
      account_code: code,
      account_name: name,
      account_type: type,
      parent_code: parent,
      acc_money: money,
      special_type: special,
      section,
      is_active: true,
    }, { onConflict: 'company_id,account_code' });
    if (insErr) return c.json({ error: 'save_failed', reason: insErr.message }, 500);
    if (dep) {
      /* The twin lives beside the asset — same parent, same type, SAD. */
      const { error: depErr } = await sb.from('accounts').upsert({
        company_id: companyId,
        account_code: dep.code,
        account_name: dep.name,
        account_type: type,
        parent_code: parent,
        acc_money: false,
        special_type: 'SAD',
        section,
        is_active: true,
      }, { onConflict: 'company_id,account_code' });
      if (depErr) return c.json({ error: 'save_failed', reason: depErr.message }, 500);
    }
  }
  return c.json({ ok: true, code, companies: targets, ...(dep ? { depreciationCode: dep.code } : {}) });
};

/* ── PUT /accounting/chart/rename — {oldCode, newCode}, 改码全账跟 ──────────
   One call to scm.acc_rename_account (migration 0347): the accounts rows of
   every company, children's parent_code, and all nine reference homes move in
   ONE transaction — or none of them do. The function refuses a collision (it
   would merge two books) and an unknown or malformed code; those surface here
   as 400s with the database's own sentence. */
export const chartRenameHandler = async (c: any): Promise<Response> => {
  if (!requireChartPerm(c)) {
    return c.json({ error: "You don't have permission to manage the chart of accounts." }, 403);
  }
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const oldCode = String(body.oldCode ?? '').trim();
  const newCode = String(body.newCode ?? '').trim();
  if (!oldCode || !newCode) return c.json({ error: 'codes_required', message: 'Both oldCode and newCode are required.' }, 400);
  if (!ACCOUNT_CODE_RE.test(newCode)) {
    return c.json({ error: 'bad_code', message: `${newCode} is not in the NNN-XXXX account-code shape.` }, 400);
  }
  const sb = c.get('supabase');
  const { data, error } = await sb.rpc('acc_rename_account', { p_old: oldCode, p_new: newCode });
  if (error) {
    const msg = String(error.message ?? '');
    const refused = /already exists|does not exist|account-code shape|two different codes/.test(msg);
    return c.json({ error: refused ? 'rename_refused' : 'rename_failed', message: msg }, refused ? 400 : 500);
  }
  return c.json({ ok: true, oldCode, newCode, moved: data ?? {} });
};

/* ── PUT /accounting/chart/update — {code, name?, accountType?, accMoney?} ──
   Definition edits that DON'T change identity: they apply to the code in
   EVERY company carrying it, because the union screen shows one definition
   per code and two companies disagreeing about what 310-0010 is called would
   be a lie in both books. */
export const chartUpdateHandler = async (c: any): Promise<Response> => {
  if (!requireChartPerm(c)) {
    return c.json({ error: "You don't have permission to manage the chart of accounts." }, 403);
  }
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const code = String(body.code ?? '').trim();
  if (!code) return c.json({ error: 'code_required' }, 400);
  const patch: Record<string, unknown> = {};
  if (body.name !== undefined) {
    const name = String(body.name ?? '').trim();
    if (!name) return c.json({ error: 'bad_name', message: 'The account name cannot be empty.' }, 400);
    patch.account_name = name;
  }
  if (body.accountType !== undefined) {
    const type = String(body.accountType ?? '').trim().toUpperCase();
    if (!ACCOUNT_TYPES.has(type)) {
      return c.json({ error: 'bad_type', message: 'accountType must be ASSET / LIABILITY / EQUITY / INCOME / EXPENSE.' }, 400);
    }
    patch.account_type = type;
  }
  if (body.accMoney !== undefined) patch.acc_money = body.accMoney === true;

  const sb = c.get('supabase');

  /* ── 换节 (the owner, 2026-09-06: 你先帮我分类,然后我自己还能调动 — 用拖拉式).
     Dropping an account on a section header moves it there, its TYPE follows
     the section (CAPITAL is EQUITY — the section decides), and its whole
     subtree rides along so a header and its children never straddle two
     sections. A CHILD does not move on its own: drag its header instead —
     the tree, not the row, is the unit (子户跟着 header 走). Every company
     carrying the code moves at once: the section is part of the definition. */
  let sectionCodes: string[] | null = null;
  if (body.section !== undefined) {
    const section = String(body.section ?? '').trim().toUpperCase();
    const shown = section || '(empty)';
    if (!isAccountSection(section)) {
      return c.json({ error: 'bad_section', message: `${shown} is not a section of the chart — pick one of ${ACCOUNT_SECTIONS.map((s) => s.section).join(' / ')}.` }, 400);
    }
    const { data: allRows, error: allErr } = await sb.from('accounts').select('account_code, parent_code, section');
    if (allErr) return c.json({ error: 'load_failed', reason: allErr.message }, 500);
    const rows = (allRows ?? []) as Array<{ account_code: string; parent_code: string | null; section: string | null }>;
    const self = rows.find((r) => r.account_code === code);
    if (!self) return c.json({ error: 'code_unknown', message: `${code} exists in no company's chart.` }, 404);
    if (self.parent_code && (body.parentCode === undefined || body.parentCode)) {
      return c.json({ error: 'section_child', message: `${code} sits under ${self.parent_code} — drag its header instead (子户跟着 header 走), or move it to the root first.` }, 400);
    }
    /* The subtree: every code whose parent chain reaches this one. */
    const kidsOf = new Map<string, string[]>();
    for (const r of rows) {
      if (!r.parent_code) continue;
      const list = kidsOf.get(r.parent_code) ?? [];
      if (!list.includes(r.account_code)) list.push(r.account_code);
      kidsOf.set(r.parent_code, list);
    }
    const subtree = [code];
    for (let i = 0; i < subtree.length && i < 5000; i += 1) {
      for (const k of kidsOf.get(subtree[i]!) ?? []) if (!subtree.includes(k)) subtree.push(k);
    }
    sectionCodes = subtree;
    patch.section = section;
    patch.account_type = sectionType(section);
  }

  /* ── 改父户 (the owner, 2026-09-03: 我希望可以拖动式 put account under 别的
     account 前提是那个 account 没有 transaction). The moved account keeps its
     own GL — lines hang on ITS code, the tree is presentation — so IT may
     carry history freely. The constraint sits on the TARGET: 父户不记账, so
     an account that has postings (or any reference) cannot BECOME a header.
     A target that already IS a header (active children) passes as-is. */
  let newParent: string | null | undefined;
  if (body.parentCode !== undefined) {
    const parent = body.parentCode == null ? '' : String(body.parentCode).trim();
    if (parent === '') {
      newParent = null; // move to root
    } else {
      if (parent === code) return c.json({ error: 'bad_parent', message: 'An account cannot be its own parent.' }, 400);
      const { data: pRow, error: pErr } = await sb.from('accounts')
        .select('account_code, account_type, parent_code')
        .eq('account_code', parent).order('company_id').limit(1).maybeSingle();
      if (pErr) return c.json({ error: 'load_failed', reason: pErr.message }, 500);
      if (!pRow) return c.json({ error: 'parent_unknown', message: `Parent ${parent} exists in no company's chart.` }, 404);
      const { data: selfRow, error: sErr } = await sb.from('accounts')
        .select('account_type').eq('account_code', code).order('company_id').limit(1).maybeSingle();
      if (sErr) return c.json({ error: 'load_failed', reason: sErr.message }, 500);
      if (!selfRow) return c.json({ error: 'code_unknown', message: `${code} exists in no company's chart.` }, 404);
      const selfType = patch.account_type ?? (selfRow as { account_type: string }).account_type;
      if ((pRow as { account_type: string }).account_type !== selfType) {
        return c.json({ error: 'bad_parent', message: `A parent shares the child's type — ${parent} is ${(pRow as { account_type: string }).account_type}, ${code} is ${String(selfType)}.` }, 400);
      }
      /* No cycles: the target may not sit anywhere BELOW the moved code. */
      let cursor: string | null = (pRow as { parent_code: string | null }).parent_code;
      for (let depth = 0; cursor && depth < 6; depth += 1) {
        if (cursor === code) return c.json({ error: 'bad_parent', message: `${parent} sits under ${code} — that loop would swallow the tree.` }, 400);
        const { data: up, error: upErr } = await sb.from('accounts')
          .select('parent_code').eq('account_code', cursor).order('company_id').limit(1).maybeSingle();
        if (upErr) return c.json({ error: 'load_failed', reason: upErr.message }, 500);
        cursor = (up as { parent_code: string | null } | null)?.parent_code ?? null;
      }
      /* Already a header? Then it already takes no postings — pass. */
      const { data: kids, error: kErr } = await sb.from('accounts')
        .select('account_code').eq('parent_code', parent).eq('is_active', true).limit(1);
      if (kErr) return c.json({ error: 'load_failed', reason: kErr.message }, 500);
      if (((kids ?? []) as unknown[]).length === 0) {
        const probes: Array<{ table: string; column: string; label: string }> = [
          { table: 'journal_entry_lines', column: 'account_code', label: 'GL journal lines' },
          { table: 'payment_vouchers', column: 'credit_account_code', label: 'payment vouchers (credit side)' },
          { table: 'payment_voucher_lines', column: 'debit_account_code', label: 'payment voucher lines' },
          { table: 'acc_vendor_memory', column: 'debit_account_code', label: 'vendor memory' },
          { table: 'acc_company_acquirers', column: 'transit_account_code', label: 'acquirer transit link' },
          { table: 'acc_company_acquirers', column: 'fee_account_code', label: 'acquirer fee link' },
          { table: 'acc_company_acquirers', column: 'bank_account_code', label: 'acquirer bank link' },
          { table: 'acc_bank_statement_config', column: 'account_code', label: 'bank statement setup' },
          { table: 'acc_bank_statements', column: 'account_code', label: 'imported bank statements' },
          { table: 'acc_account_roles', column: 'account_code', label: 'system role bindings' },
        ];
        const used: string[] = [];
        for (const p of probes) {
          const { data: hit, error: hErr } = await sb.from(p.table).select(p.column).eq(p.column, parent).limit(1);
          if (hErr) return c.json({ error: 'load_failed', reason: `${p.table}: ${hErr.message}` }, 500);
          if (((hit ?? []) as unknown[]).length > 0 && !used.includes(p.label)) used.push(p.label);
        }
        if (used.length > 0) {
          return c.json({
            error: 'parent_has_postings',
            message: `${parent} cannot become a header — 父户不记账, and it is referenced by: ${used.join(', ')}.`,
            used,
          }, 409);
        }
      }
      newParent = parent;
    }
    patch.parent_code = newParent;
  }

  if (Object.keys(patch).length === 0) return c.json({ error: 'nothing_to_change' }, 400);

  /* A section move carries the subtree: the children take ONLY the section
     and the type it decides — their names, parents and flags are their own. */
  if (sectionCodes && sectionCodes.length > 1) {
    const { error: subErr } = await sb
      .from('accounts')
      .update({ section: patch.section, account_type: patch.account_type })
      .in('account_code', sectionCodes.slice(1));
    if (subErr) return c.json({ error: 'save_failed', reason: subErr.message }, 500);
  }

  const { data, error } = await sb
    .from('accounts')
    .update(patch)
    .eq('account_code', code)
    .select('company_id');
  if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  const touched = ((data ?? []) as Array<{ company_id: number }>);
  if (touched.length === 0) return c.json({ error: 'code_unknown', message: `${code} exists in no company's chart.` }, 404);

  /* A re-parented child must find its header in EVERY company it lives in —
     instantiate the parent chain from the master definition where missing
     (the tick-ON walk, reused in spirit). */
  if (typeof newParent === 'string') {
    for (const t of touched) {
      const chain: string[] = [];
      let cur: string | null = newParent;
      for (let depth = 0; cur && depth < 4; depth += 1) {
        chain.unshift(cur);
        const walkRes: { data: unknown; error: { message: string } | null } = await sb.from('accounts')
          .select('parent_code').eq('account_code', cur).order('company_id').limit(1).maybeSingle();
        if (walkRes.error) return c.json({ error: 'load_failed', reason: walkRes.error.message }, 500);
        cur = (walkRes.data as { parent_code: string | null } | null)?.parent_code ?? null;
      }
      for (const step of chain) {
        const { data: def, error: dErr } = await sb.from('accounts')
          .select(DEFINITION_FIELDS)
          .eq('account_code', step).order('company_id').limit(1).maybeSingle();
        if (dErr) return c.json({ error: 'load_failed', reason: dErr.message }, 500);
        if (!def) continue;
        const d = def as AccountRow;
        const { error: upErr } = await sb.from('accounts').upsert({
          company_id: t.company_id,
          account_code: d.account_code,
          account_name: d.account_name,
          account_type: d.account_type,
          parent_code: d.parent_code,
          acc_money: d.acc_money === true,
          special_type: d.special_type ?? null,
          section: d.section ?? defaultSectionFor(d.account_type, d.account_code),
          is_active: true,
        }, { onConflict: 'company_id,account_code' });
        if (upErr) return c.json({ error: 'save_failed', reason: upErr.message }, 500);
      }
    }
  }
  return c.json({ ok: true, code, companies: touched.length });
};

/* ── DELETE /accounting/chart/account?code=… — only a NEVER-USED code dies ──
   The owner's rule (2026-09-03): 零交易零引用的才可以真删；有交易的不给删.
   Every reference home is checked — one hit anywhere and the answer is a 409
   naming the holdouts, with deactivation (the tick column) as the offered
   path. A delete removes the code from EVERY company: the code is one
   identity, half-deleting it would fork the union. */
export const chartDeleteHandler = async (c: any): Promise<Response> => {
  if (!requireChartPerm(c)) {
    return c.json({ error: "You don't have permission to manage the chart of accounts." }, 403);
  }
  const code = String(c.req.query('code') ?? '').trim();
  if (!code) return c.json({ error: 'code_required' }, 400);
  const sb = c.get('supabase');

  const used: string[] = [];
  const probes: Array<{ table: string; column: string; label: string }> = [
    { table: 'journal_entry_lines', column: 'account_code', label: 'GL journal lines' },
    { table: 'payment_vouchers', column: 'credit_account_code', label: 'payment vouchers (credit side)' },
    { table: 'payment_voucher_lines', column: 'debit_account_code', label: 'payment voucher lines' },
    { table: 'acc_vendor_memory', column: 'debit_account_code', label: 'vendor memory' },
    { table: 'acc_company_acquirers', column: 'transit_account_code', label: 'acquirer transit link' },
    { table: 'acc_company_acquirers', column: 'fee_account_code', label: 'acquirer fee link' },
    { table: 'acc_company_acquirers', column: 'bank_account_code', label: 'acquirer bank link' },
    { table: 'acc_bank_statement_config', column: 'account_code', label: 'bank statement setup' },
    { table: 'acc_bank_statements', column: 'account_code', label: 'imported bank statements' },
    { table: 'acc_account_roles', column: 'account_code', label: 'system role bindings' },
    { table: 'accounts', column: 'parent_code', label: 'sub-accounts under it' },
  ];
  for (const p of probes) {
    const { data, error } = await sb.from(p.table).select(p.column).eq(p.column, code).limit(1);
    if (error) return c.json({ error: 'load_failed', reason: `${p.table}: ${error.message}` }, 500);
    if (((data ?? []) as unknown[]).length > 0 && !used.includes(p.label)) used.push(p.label);
  }
  if (used.length > 0) {
    return c.json({
      error: 'account_in_use',
      message: `${code} cannot be deleted — it is referenced by: ${used.join(', ')}. Untick it instead to hide it.`,
      used,
    }, 409);
  }

  const { data: gone, error: delErr } = await sb
    .from('accounts')
    .delete()
    .eq('account_code', code)
    .select('company_id');
  if (delErr) return c.json({ error: 'delete_failed', reason: delErr.message }, 500);
  const removed = ((gone ?? []) as unknown[]).length;
  if (removed === 0) return c.json({ error: 'code_unknown', message: `${code} exists in no company's chart.` }, 404);
  return c.json({ ok: true, code, companies: removed });
};
