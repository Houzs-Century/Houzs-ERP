// /pwp-codes — PWP (换购) voucher codes (migration 0130, Chairman 2026-06-02).
// Adding a TRIGGER to a cart RESERVES N = rule.qty_per_trigger × qty codes (each
// = one reward redemption); removing the trigger frees them. At order Confirm
// (in mfg-sales-orders) an applied code → USED, an un-applied reserved code →
// AVAILABLE (printed on the SO, redeemable cross-order). This route is the
// reserve / free / validate surface; the consume + mark-used step lives in the
// order route so it shares the order's transaction-like flow.
//
// Any authenticated active staff may reserve/free/validate — a salesperson owns
// their cart's codes, and a cross-order redemption validates another staff's
// AVAILABLE code. RLS (migration 0130) is defence-in-depth.
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { matchComboBuild, passesRefinementColumns } from '../shared';
import { supabaseAuth } from '../middleware/auth';
import { activeCompanyId, scopeToCompany } from '../lib/companyScope';
import { resolveCallerStaffId } from '../lib/salesScope';
import type { Env, Variables } from '../env';
import { pgrestIn } from '../lib/pgrest-in-list';
import { loadLiveCombosByIds } from '../lib/pos-sofa-combos';

type AppCtx = Context<{ Bindings: Env; Variables: Variables }>;

export const pwpCodes = new Hono<{ Bindings: Env; Variables: Variables }>();

pwpCodes.use('*', supabaseAuth);

export const SCM_SYSTEM_STAFF_ID = '00000000-0000-4000-8000-000000000001';

export async function resolveOwnerStaffId(
  sb: any,
  houzsUserId: number | null | undefined,
  bridgeUserId: string | null | undefined,
): Promise<string | null> {
  const own = await resolveCallerStaffId(sb, houzsUserId);
  if (own) return own;
  const preResolved = (bridgeUserId ?? '').trim();
  return preResolved && preResolved !== SCM_SYSTEM_STAFF_ID ? preResolved : null;
}

const STAFF_UNLINKED_PWP: { error: string; message: string } = {
  error: 'staff_unlinked',
  message:
    'Your account is not linked to a sales profile yet, so PWP codes cannot be held for this cart. Ask IT to link your account.',
};

export const inList = (modelId: string | null, list: string[]): boolean =>
  list.length === 0 ? true : modelId != null && list.includes(modelId);

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export function genCode(): string {
  const buf = new Uint32Array(8);
  crypto.getRandomValues(buf);
  let digits = '';
  for (let i = 0; i < 4; i++) digits += String((buf[i] ?? 0) % 10);
  let letters = '';
  for (let i = 0; i < 4; i++) letters += LETTERS[(buf[4 + i] ?? 0) % 26];
  return `PWP-${digits}${letters}`;
}

type CodeRow = {
  code: string;
  rule_id: string | null;
  reward_category: string;
  eligible_reward_model_ids: string[] | null;
  reward_combo_ids: string[] | null;
  status: string;
  owner_staff_id: string | null;
  cart_line_key: string | null;
  trigger_item_code: string | null;
  source_doc_no: string | null;
  redeemed_doc_no: string | null;
  redeemed_item_code: string | null;
  customer_id: string | null;
  type: string | null;
};

const SELECT =
  'code, rule_id, reward_category, eligible_reward_model_ids, reward_combo_ids, status, owner_staff_id, ' +
  'cart_line_key, trigger_item_code, source_doc_no, redeemed_doc_no, redeemed_item_code, customer_id, type';

const toApi = (r: CodeRow) => ({
  code:                    r.code,
  ruleId:                  r.rule_id,
  rewardCategory:          r.reward_category,
  eligibleRewardModelIds:  r.eligible_reward_model_ids ?? [],
  rewardComboIds:          r.reward_combo_ids ?? [],
  type:                    (r.type ?? 'pwp') as 'pwp' | 'promo',
  status:                  r.status,
  cartLineKey:             r.cart_line_key,
  triggerItemCode:         r.trigger_item_code,
  sourceDocNo:             r.source_doc_no,
  customerId:              r.customer_id,
});

pwpCodes.get('/mine', async (c) => {
  const supabase = c.get('supabase');
  const userId = await resolveOwnerStaffId(supabase, c.get('houzsUser')?.id, c.get('user')?.id);
  if (!userId) return c.json({ codes: [] });
  const { data, error } = await scopeToCompany(
    supabase
      .from('pwp_codes')
      .select(SELECT)
      .eq('owner_staff_id', userId),
    c,
  )
    .eq('status', 'RESERVED');
  if (error) return c.json({ error: 'fetch_failed', reason: error.message }, 500);
  return c.json({ codes: ((data as unknown as CodeRow[]) ?? []).map(toApi) });
});

const reserveSchema = z.object({
  cartLineKey: z.string().min(1),
  productId:   z.string().min(1),
  qty:         z.number().int().min(1).default(1),
  sofaModules: z.array(z.string()).optional(),
  sofaCellIds: z.array(z.string()).optional(),
  sofaAccessories: z.array(z.object({ id: z.string().min(1), modelId: z.string().min(1), cellId: z.string().min(1) })).max(200).optional(),
  // Promo is ONE-WAY (Loo 2026-06-06): when the line is itself a reward
  // (bought with a PWP/promo code) it must never mint 'promo' codes — a free
  // ARRUS can't fund the next free ARRUS. 'pwp' rules still apply (换购 may
  // chain). The POS reconciler sets this; the order-Confirm backstop in
  // mfg-sales-orders.ts catches anything that slips through.
  rewardLine:  z.boolean().optional(),
});

pwpCodes.post('/reserve', async (c) => {
  const supabase = c.get('supabase');
  const userId = await resolveOwnerStaffId(supabase, c.get('houzsUser')?.id, c.get('user')?.id);
  if (!userId) return c.json(STAFF_UNLINKED_PWP, 409);

  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = reserveSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'validation_failed', issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) }, 400);
  }
  const { cartLineKey, productId, qty, rewardLine } = parsed.data;

  const { data: prod } = await supabase
    .from('mfg_products')
    .select('code, category, model_id, base_model, size_code')
    .eq('id', productId)
    .maybeSingle();
  if (!prod) return c.json({ codes: [] });
  const prodCat = String(prod.category).toUpperCase();
  const triggerSizeCode = prod.size_code ? String(prod.size_code).toUpperCase() : null;

  const { data: ruleRows } = await scopeToCompany(
    supabase
      .from('pwp_rules')
      .select('id, trigger_category, trigger_eligible_model_ids, trigger_combo_ids, reward_category, eligible_reward_model_ids, reward_combo_ids, trigger_size_codes, trigger_compartments, reward_size_codes, reward_compartments, qty_per_trigger, type'),
    c,
  ).eq('active', true);
  const rules = (ruleRows ?? []) as Array<{
    id: string; trigger_category: string; trigger_eligible_model_ids: string[] | null;
    trigger_combo_ids: string[] | null; reward_category: string;
    eligible_reward_model_ids: string[] | null; reward_combo_ids: string[] | null; qty_per_trigger: number;
    trigger_size_codes: string[] | null; trigger_compartments: string[] | null;
    reward_size_codes: string[] | null; reward_compartments: string[] | null;
    type: string | null;
  }>;

  let matching: typeof rules;
  if (prodCat === 'SOFA') {
    const sofaModules = (parsed.data.sofaModules ?? []).map((s) => s.trim()).filter(Boolean);
    const byModelRules = rules.filter((r) =>
      r.trigger_category === 'SOFA'
      && (r.trigger_combo_ids ?? []).length === 0
      && (r.trigger_eligible_model_ids ?? []).length > 0
      && inList(prod.model_id ?? null, r.trigger_eligible_model_ids ?? [])
      && passesRefinementColumns(
        { category: 'SOFA', modelId: prod.model_id ?? null, sizeCode: null, builtCompartments: sofaModules },
        r.trigger_size_codes, r.trigger_compartments,
      ),
    );
    let byComboRules: typeof rules = [];
    if (sofaModules.length > 0) {
      const sofaRules = rules.filter((r) => r.trigger_category === 'SOFA' && (r.trigger_combo_ids ?? []).length > 0);
      const comboIds = [...new Set(sofaRules.flatMap((r) => r.trigger_combo_ids ?? []))];
      const combosById = await loadLiveCombosByIds(supabase, comboIds);
      byComboRules = sofaRules.filter((r) => (r.trigger_combo_ids ?? []).some((cid) => {
        const combo = combosById.get(cid);
        return !!combo && (!prod.base_model || combo.base_model === prod.base_model)
          && matchComboBuild({ modules: sofaModules }, combo) != null;
      }));
    }
    matching = [...byComboRules, ...byModelRules];
  } else {
    matching = rules.filter((r) =>
      r.trigger_category === prodCat
      && inList(prod.model_id ?? null, r.trigger_eligible_model_ids ?? [])
      && passesRefinementColumns(
        { category: prodCat, modelId: prod.model_id ?? null, sizeCode: triggerSizeCode, builtCompartments: [] },
        r.trigger_size_codes, r.trigger_compartments,
      ),
    );
  }

  if (rewardLine) {
    matching = matching.filter((r) => String(r.type ?? 'pwp') !== 'promo');
  }

  const { data: existingRows } = await scopeToCompany(
    supabase
      .from('pwp_codes')
      .select(SELECT)
      .eq('cart_line_key', cartLineKey)
      .eq('owner_staff_id', userId),
    c,
  ).eq('status', 'RESERVED');
  const existing = (existingRows as CodeRow[] | null) ?? [];

  for (const rule of matching) {
    const target = Math.max(0, Math.floor((Number(rule.qty_per_trigger) || 1) * qty));
    const mine = existing.filter((e) => e.rule_id === rule.id);
    if (mine.length < target) {
      for (let i = 0; i < target - mine.length; i++) {
        for (let attempt = 0; attempt < 5; attempt++) {
          const { error } = await supabase.from('pwp_codes').insert({
            company_id:                activeCompanyId(c),
            code:                      genCode(),
            rule_id:                   rule.id,
            reward_category:           rule.reward_category,
            eligible_reward_model_ids: rule.eligible_reward_model_ids ?? [],
            reward_combo_ids:          rule.reward_combo_ids ?? [],
            reward_size_codes:         rule.reward_size_codes ?? [],
            reward_compartments:       rule.reward_compartments ?? [],
            type:                      rule.type ?? 'pwp',
            status:                    'RESERVED',
            owner_staff_id:            userId,
            cart_line_key:             cartLineKey,
            trigger_item_code:         prod.code,
          });
          if (!error) break;
          if (attempt === 4) return c.json({ error: 'reserve_failed', reason: error.message }, 500);
        }
      }
    } else if (mine.length > target) {
      const surplus = mine.slice(target).map((e) => e.code);
      if (surplus.length > 0) {
        await scopeToCompany(
          pgrestIn(supabase.from('pwp_codes').delete(), 'code', surplus).eq('owner_staff_id', userId),
          c,
        ).eq('status', 'RESERVED');
      }
    }
  }

  {
    const matchingIds = new Set(matching.map((r) => r.id));
    const strays = existing
      .filter((e) => !e.rule_id || !matchingIds.has(e.rule_id))
      .map((e) => e.code);
    if (strays.length > 0) {
      await scopeToCompany(
        pgrestIn(supabase.from('pwp_codes').delete(), 'code', strays).eq('owner_staff_id', userId),
        c,
      ).eq('status', 'RESERVED');
    }
  }

  const { data: finalRows } = await scopeToCompany(
    supabase
      .from('pwp_codes')
      .select(SELECT)
      .eq('cart_line_key', cartLineKey)
      .eq('owner_staff_id', userId),
    c,
  ).eq('status', 'RESERVED');
  return c.json({ codes: ((finalRows as CodeRow[] | null) ?? []).map(toApi) });
});

pwpCodes.delete('/reserve', async (c) => {
  const supabase = c.get('supabase');
  const cartLineKey = c.req.query('cartLineKey');
  if (!cartLineKey) return c.json({ error: 'cart_line_key_required' }, 400);
  const userId = await resolveOwnerStaffId(supabase, c.get('houzsUser')?.id, c.get('user')?.id);
  if (!userId) return c.json({ ok: true, freed: 0 });
  const { error } = await scopeToCompany(
    supabase
      .from('pwp_codes')
      .delete()
      .eq('cart_line_key', cartLineKey)
      .eq('owner_staff_id', userId),
    c,
  ).eq('status', 'RESERVED');
  if (error) return c.json({ error: 'free_failed', reason: error.message }, 500);
  return c.json({ ok: true });
});

pwpCodes.get('/by-so/:docNo', async (c) => {
  const supabase = c.get('supabase');
  const docNo = c.req.param('docNo');
  const { data, error } = await scopeToCompany(
    supabase
      .from('pwp_codes')
      .select(SELECT)
      .eq('source_doc_no', docNo),
    c,
  )
    .in('status', ['USED', 'AVAILABLE']);
  if (error) return c.json({ error: 'fetch_failed', reason: error.message }, 500);
  return c.json({ codes: ((data as unknown as CodeRow[]) ?? []).map(toApi) });
});

pwpCodes.get('/:code', async (c) => {
  const supabase = c.get('supabase');
  const userId = await resolveOwnerStaffId(supabase, c.get('houzsUser')?.id, c.get('user')?.id);
  const code = c.req.param('code');
  const rewardCategory = (c.req.query('rewardCategory') ?? '').toUpperCase();
  const rewardModelId = c.req.query('rewardModelId') ?? '';
  const rewardComboId = c.req.query('rewardComboId') ?? '';
  const customerId = c.req.query('customerId') ?? '';

  const { data: row } = await scopeToCompany(supabase.from('pwp_codes').select(SELECT).eq('code', code), c).maybeSingle();
  if (!row) return c.json({ valid: false, reason: 'not_found' });
  const r = row as unknown as CodeRow;

  const redeemable =
    r.status === 'AVAILABLE' ||
    (r.status === 'RESERVED' && userId != null && r.owner_staff_id === userId);
  if (!redeemable) return c.json({
    valid: false,
    reason: r.status === 'USED' ? 'already_used' : 'not_redeemable',
    rewardCategory: r.reward_category,
    eligibleRewardModelIds: r.eligible_reward_model_ids ?? [],
    type: (r.type ?? 'pwp') as 'pwp' | 'promo',
  });

  if (rewardCategory && rewardCategory !== String(r.reward_category).toUpperCase()) {
    return c.json({ valid: false, reason: 'reward_category_mismatch' });
  }
  if (String(r.reward_category).toUpperCase() === 'SOFA') {
    const combos = r.reward_combo_ids ?? [];
    if (!rewardComboId || !combos.includes(rewardComboId)) {
      return c.json({ valid: false, reason: 'reward_combo_ineligible' });
    }
  } else if (!inList(rewardModelId || null, r.eligible_reward_model_ids ?? [])) {
    return c.json({ valid: false, reason: 'reward_model_ineligible' });
  }

  let customerMatches = true;
  if (r.status === 'AVAILABLE' && r.customer_id) {
    customerMatches = customerId !== '' ? customerId === r.customer_id : true;
  }

  return c.json({ valid: true, rewardCategory: r.reward_category, eligibleRewardModelIds: r.eligible_reward_model_ids ?? [], customerMatches, status: r.status, type: (r.type ?? 'pwp') as 'pwp' | 'promo' });
});
