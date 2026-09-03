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

const requireChartPerm = (c: any): boolean => hasHouzsPerm(c, 'scm.payment_voucher.post');

const ACCOUNT_TYPES = new Set(['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE']);

type AccountRow = {
  company_id: number;
  account_code: string;
  account_name: string;
  account_type: string;
  parent_code: string | null;
  is_active: boolean;
  acc_money: boolean | null;
};

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
    .select('company_id, account_code, account_name, account_type, parent_code, is_active, acc_money')
    .in('company_id', ids);
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  /* One row per code. Definition fields prefer the LOWEST company id that
     carries the code (company 1 = the master book where the accountant's
     import lands), so a rename there leads the union. */
  const byCode = new Map<string, { code: string; name: string; type: string; parentCode: string | null; accMoney: boolean; definedBy: number; perCompany: Record<number, { active: boolean }> }>();
  for (const raw of (data ?? []) as AccountRow[]) {
    const cur = byCode.get(raw.account_code);
    if (!cur || raw.company_id < cur.definedBy) {
      byCode.set(raw.account_code, {
        code: raw.account_code,
        name: raw.account_name,
        type: raw.account_type,
        parentCode: raw.parent_code,
        accMoney: raw.acc_money === true,
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
        .select('company_id, account_code, account_name, account_type, parent_code, acc_money')
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
        .select('account_code, account_name, account_type, parent_code, acc_money')
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

  const clean: Array<{ code: string; name: string; type: string; parent: string | null; money: boolean; shared: boolean }> = [];
  const seen = new Set<string>();
  for (const [i, r] of rows.entries()) {
    const code = String(r?.code ?? '').trim();
    const name = String(r?.name ?? '').trim();
    const type = String(r?.accountType ?? '').trim().toUpperCase();
    if (!code || !name) return c.json({ error: 'bad_row', message: `Row ${i + 1} is missing code or name.` }, 400);
    if (!ACCOUNT_TYPES.has(type)) return c.json({ error: 'bad_row', message: `Row ${i + 1} (${code}): accountType must be ASSET / LIABILITY / EQUITY / INCOME / EXPENSE.` }, 400);
    if (seen.has(code)) return c.json({ error: 'bad_row', message: `Row ${i + 1}: ${code} appears twice in the file.` }, 400);
    seen.add(code);
    clean.push({
      code, name, type,
      parent: r?.parentCode ? String(r.parentCode).trim() : null,
      money: r?.accMoney === true,
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
   TYPING, where the operator can still just pick the child. Fails CLOSED on a
   read error — an unverifiable account does not get onto a money document. */
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
  return null;
};
