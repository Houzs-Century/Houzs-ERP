// ----------------------------------------------------------------------------
// accounting-item-groups — the product-group ↔ ledger-account registry
// (GL redesign item 1, owner 2026-09-05).
//
// The ledger is moving to the AutoCount periodic shape: a purchase invoice
// posts Dr <the line's group's purchase account> / Cr supplier, a sales
// invoice will post Cr <the group's sales account>, returns their own two.
// This file owns the registry those rules read:
//
//   • scm.acc_item_groups — one row per product-category label. The nine the
//     mfg_product_category enums already hold are seeded; NEW ones are born
//     only through scm.acc_register_item_group (SECURITY DEFINER — it extends
//     BOTH enums and registers the row in one breath), so the enum and the
//     registry cannot drift.
//   • scm.acc_item_group_accounts — per company, the four bindings. The row's
//     PRESENCE is what "bound" means: an unbound group does not post, it
//     REFUSES by name (owner: 挡下来提醒我去绑,不要静默丢进 OTHERS).
//
// Creating a group REQUIRES the four accounts for the company the owner is
// working in (owner: create 新 group 时让他强制我要绑才能 create) — the other
// company binds on its own page when it first needs the group.
//
// Discounts are deliberately NOT here: 520-0000 DISCOUNT ALLOWED and 610-0001
// DISCOUNT RECEIVED are company-level accounts, not per-group (owner asked;
// answered 2026-09-05).
// ----------------------------------------------------------------------------

import { hasHouzsPerm } from '../lib/houzs-perms';

const requirePerm = (c: any): boolean => hasHouzsPerm(c, 'scm.payment_voucher.post');
const NO_PERM = { error: "You don't have permission to manage the chart of accounts." };

const allowedIds = (c: any): number[] => {
  const ids = c.get('allowedCompanyIds') as number[] | undefined;
  if (Array.isArray(ids)) return ids;
  const active = c.get('companyId') as number | undefined;
  return typeof active === 'number' ? [active] : [];
};

export type GroupBinding = {
  purchase: string;
  sales: string;
  salesReturn: string;
  purchaseReturn: string;
};

const SLOT_LABEL: Record<keyof GroupBinding, string> = {
  purchase: 'Purchase',
  sales: 'Sales',
  salesReturn: 'Sales Return',
  purchaseReturn: 'Purchase Return',
};

/** The four account codes from a request body — every slot present and
    non-blank, or the missing slot named. */
function readBinding(raw: any): { ok: true; binding: GroupBinding } | { ok: false; missing: string } {
  const out: Partial<GroupBinding> = {};
  for (const slot of Object.keys(SLOT_LABEL) as Array<keyof GroupBinding>) {
    const v = String(raw?.[slot] ?? '').trim();
    if (!v) return { ok: false, missing: SLOT_LABEL[slot] };
    out[slot] = v;
  }
  return { ok: true, binding: out as GroupBinding };
}

/**
 * Every bound account must EXIST in this company's chart and be ACTIVE —
 * checked against the company's own rows, not the union, because posting will
 * resolve against exactly these rows. A failure names the slot and the code:
 * "some account was wrong" is not actionable at a maintenance screen.
 */
async function verifyBinding(
  sb: any,
  companyId: number,
  binding: GroupBinding,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const codes = [...new Set(Object.values(binding))];
  const { data, error } = await sb
    .from('accounts')
    .select('account_code, is_active')
    .eq('company_id', companyId)
    .in('account_code', codes);
  if (error) return { ok: false, message: error.message };
  const found = new Map(((data ?? []) as Array<{ account_code: string; is_active: boolean }>)
    .map((r) => [r.account_code, r.is_active]));
  for (const slot of Object.keys(SLOT_LABEL) as Array<keyof GroupBinding>) {
    const code = binding[slot];
    const active = found.get(code);
    if (active === undefined) {
      return { ok: false, message: `${SLOT_LABEL[slot]} account ${code} is not in this company's chart.` };
    }
    if (active !== true) {
      return { ok: false, message: `${SLOT_LABEL[slot]} account ${code} is switched off for this company — tick it on the chart first.` };
    }
  }
  return { ok: true };
}

type GroupRow = { code: string; name: string; is_active: boolean };
type BindingRow = {
  company_id: number; group_code: string;
  purchase_account: string; sales_account: string;
  sales_return_account: string; purchase_return_account: string;
};

/* ── GET /accounting/item-groups — every group × every granted company ────── */
export const itemGroupsList = async (c: any): Promise<Response> => {
  if (!requirePerm(c)) return c.json(NO_PERM, 403);
  const ids = allowedIds(c);
  if (ids.length === 0) return c.json({ error: 'no_companies', message: 'No company grants resolve for this session.' }, 409);
  const sb = c.get('supabase');

  const [groupsRes, bindsRes] = await Promise.all([
    sb.from('acc_item_groups').select('code, name, is_active').order('code'),
    sb.from('acc_item_group_accounts')
      .select('company_id, group_code, purchase_account, sales_account, sales_return_account, purchase_return_account')
      .in('company_id', ids),
  ]);
  if (groupsRes.error) return c.json({ error: 'load_failed', reason: groupsRes.error.message }, 500);
  if (bindsRes.error) return c.json({ error: 'load_failed', reason: bindsRes.error.message }, 500);

  const byGroup = new Map<string, Record<number, GroupBinding>>();
  for (const b of (bindsRes.data ?? []) as BindingRow[]) {
    const at = byGroup.get(b.group_code) ?? {};
    at[b.company_id] = {
      purchase: b.purchase_account,
      sales: b.sales_account,
      salesReturn: b.sales_return_account,
      purchaseReturn: b.purchase_return_account,
    };
    byGroup.set(b.group_code, at);
  }

  const companies = ((c.get('companies') as Array<{ id: number; code: string }> | undefined) ?? [])
    .filter((co) => ids.includes(co.id))
    .map((co) => ({ id: co.id, code: co.code }));

  return c.json({
    companies,
    groups: ((groupsRes.data ?? []) as GroupRow[]).map((g) => ({
      code: g.code,
      name: g.name,
      isActive: g.is_active,
      bindings: byGroup.get(g.code) ?? {},
    })),
  });
};

/* ── POST /accounting/item-groups — new group, bound-at-birth ─────────────── */
export const itemGroupCreate = async (c: any): Promise<Response> => {
  if (!requirePerm(c)) return c.json(NO_PERM, 403);
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }

  const code = String(body.code ?? '').trim().toUpperCase();
  const name = String(body.name ?? '').trim();
  const companyId = Number(body.companyId);
  const ids = allowedIds(c);
  if (!/^[A-Z][A-Z0-9_]{1,29}$/.test(code)) {
    return c.json({ error: 'bad_code', message: 'Group code: 2-30 characters, A-Z 0-9 _, starting with a letter.' }, 400);
  }
  if (!name) return c.json({ error: 'name_required', message: 'Give the group a name.' }, 400);
  if (!Number.isInteger(companyId) || !ids.includes(companyId)) {
    return c.json({ error: 'company_not_yours', message: 'That company is not in your grants.' }, 403);
  }
  /* Bound at birth — the owner's own rule. The OTHER company binds on its own
     page when it first needs this group. */
  const bind = readBinding(body.accounts);
  if (!bind.ok) return c.json({ error: 'binding_required', message: `${bind.missing} account is required — a group cannot be created unbound.` }, 400);

  const sb = c.get('supabase');
  const ver = await verifyBinding(sb, companyId, bind.binding);
  if (!ver.ok) return c.json({ error: 'bad_account', message: ver.message }, 400);

  /* The registry function extends BOTH mfg_product_category enums and writes
     the group row, atomically on the server. Everything else about the group
     (bindings) is plain DML from here. */
  const { error: rpcErr } = await sb.rpc('acc_register_item_group', { p_code: code, p_name: name });
  if (rpcErr) return c.json({ error: 'register_failed', reason: rpcErr.message }, 500);

  const user = (c.get('houzsUser') as { name?: string } | undefined)?.name ?? null;
  const { error: upErr } = await sb.from('acc_item_group_accounts').upsert({
    company_id: companyId,
    group_code: code,
    purchase_account: bind.binding.purchase,
    sales_account: bind.binding.sales,
    sales_return_account: bind.binding.salesReturn,
    purchase_return_account: bind.binding.purchaseReturn,
    updated_at: new Date().toISOString(),
    updated_by: user,
  }, { onConflict: 'company_id,group_code' });
  if (upErr) return c.json({ error: 'save_failed', reason: upErr.message }, 500);

  return c.json({ ok: true, code });
};

/* ── PUT /accounting/item-groups/:code/accounts — (re)bind one company ────── */
export const itemGroupBind = async (c: any): Promise<Response> => {
  if (!requirePerm(c)) return c.json(NO_PERM, 403);
  const code = String(c.req.param('code') ?? '').trim().toUpperCase();
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const companyId = Number(body.companyId);
  const ids = allowedIds(c);
  if (!Number.isInteger(companyId) || !ids.includes(companyId)) {
    return c.json({ error: 'company_not_yours', message: 'That company is not in your grants.' }, 403);
  }
  const bind = readBinding(body.accounts);
  if (!bind.ok) return c.json({ error: 'binding_required', message: `${bind.missing} account is required.` }, 400);

  const sb = c.get('supabase');
  const { data: g, error: gErr } = await sb.from('acc_item_groups').select('code').eq('code', code).maybeSingle();
  if (gErr) return c.json({ error: 'load_failed', reason: gErr.message }, 500);
  if (!g) return c.json({ error: 'group_unknown', message: `${code} is not a registered group.` }, 404);

  const ver = await verifyBinding(sb, companyId, bind.binding);
  if (!ver.ok) return c.json({ error: 'bad_account', message: ver.message }, 400);

  const user = (c.get('houzsUser') as { name?: string } | undefined)?.name ?? null;
  const { error: upErr } = await sb.from('acc_item_group_accounts').upsert({
    company_id: companyId,
    group_code: code,
    purchase_account: bind.binding.purchase,
    sales_account: bind.binding.sales,
    sales_return_account: bind.binding.salesReturn,
    purchase_return_account: bind.binding.purchaseReturn,
    updated_at: new Date().toISOString(),
    updated_by: user,
  }, { onConflict: 'company_id,group_code' });
  if (upErr) return c.json({ error: 'save_failed', reason: upErr.message }, 500);
  return c.json({ ok: true });
};

/* ── PATCH /accounting/item-groups/:code — rename / de-list from NEW products ─ */
export const itemGroupPatch = async (c: any): Promise<Response> => {
  if (!requirePerm(c)) return c.json(NO_PERM, 403);
  const code = String(c.req.param('code') ?? '').trim().toUpperCase();
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.name !== undefined) {
    const name = String(body.name ?? '').trim();
    if (!name) return c.json({ error: 'name_required', message: 'A group cannot be nameless.' }, 400);
    patch.name = name;
  }
  /* De-activating only hides the group from NEW products; existing products
     keep their category value and every posting rule still resolves it. */
  if (body.isActive !== undefined) patch.is_active = body.isActive === true;

  const sb = c.get('supabase');
  const { data: g, error: gErr } = await sb.from('acc_item_groups').select('code').eq('code', code).maybeSingle();
  if (gErr) return c.json({ error: 'load_failed', reason: gErr.message }, 500);
  if (!g) return c.json({ error: 'group_unknown', message: `${code} is not a registered group.` }, 404);

  const { error } = await sb.from('acc_item_groups').update(patch).eq('code', code);
  if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  return c.json({ ok: true });
};
