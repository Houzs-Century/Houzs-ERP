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
import { matchComboSubset, passesRefinementColumns } from '../shared';
import { supabaseAuth } from '../middleware/auth';
import { activeCompanyId, scopeToCompany } from '../lib/companyScope';
import { resolveCallerStaffId } from '../lib/salesScope';
import type { Env, Variables } from '../env';

type AppCtx = Context<{ Bindings: Env; Variables: Variables }>;

export const pwpCodes = new Hono<{ Bindings: Env; Variables: Variables }>();

pwpCodes.use('*', supabaseAuth);

/* ── Caller identity for OWNERSHIP / ATTRIBUTION ────────────────────────────
   The scm auth bridge (middleware/auth.ts) pins `c.get('user').id` to ONE
   seeded system staff row for EVERY caller: a type shim, not an identity. The
   real person is the mig-0066 staff row linked to the Houzs user, read by
   resolveCallerStaffId. This wrapper adds the ONE distinction the bare resolver
   cannot make, because only its callers can see `user`:

     · resolved → the caller's own staff uuid. Always wins.
     · unresolved, and `user.id` is NOT the pin → a real staff uuid a HEADLESS
       REPLAY already resolved while its request was still authed. Only
       mfg-sales-orders' createDraftSalesOrder does this: it feeds the scan job's
       scan_jobs.salesperson_id in through `user`, and the enqueue-time resolver
       (scan-so.ts resolveScanUploaderStaffId) has an email fallback this one
       lacks. Trust it — dropping it would regress OCR drafts that attribute
       correctly today.
     · unresolved, and `user.id` IS the pin → a human we could not identify.
       Return null and let the CALLER decide: reads answer empty, writes refuse.
       Never hand back the pin — every row stamped with it collapses onto one
       shared identity, which is the pos-cart leak (#633) and the PWP-ownership
       and salesperson_id bugs this change fixes.

   PLACEMENT: this belongs in lib/salesScope.ts beside resolveCallerStaffId, and
   the constant belongs in middleware/auth.ts (which does not export it — hence
   the copy below). It sits here because this module is the only one BOTH
   consumers can reach without an import cycle: mfg-sales-orders.ts already
   imports genCode / inList from here, so the edge exists and only goes one way.
   Move all three together once auth.ts exports the pin. */
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

/* One wording for the refusal, so both writers refuse identically. Mirrors
   pos-cart's PUT (409 staff_unlinked) — same condition, same remedy. The client
   has no ERROR_CODE_MESSAGES entry for this code, so humanApiError falls through
   to `message`; keep it one plain sentence with no internals or it gets filtered
   out and the operator sees the generic 409 instead. */
const STAFF_UNLINKED_PWP: { error: string; message: string } = {
  error: 'staff_unlinked',
  message:
    'Your account is not linked to a sales profile yet, so PWP codes cannot be held for this cart. Ask IT to link your account.',
};

// product_models.id list match: [] = whole category, else the modelId must be in
// the list (null modelId never matches a non-empty list). Mirrors shared/pwp.ts.
export const inList = (modelId: string | null, list: string[]): boolean =>
  list.length === 0 ? true : modelId != null && list.includes(modelId);

// 'PWP-' + 4 digits + 4 uppercase A–Z. ~4.5B combos; retry on the (astronomically
// rare) PK collision. crypto.getRandomValues is available in the Workers runtime.
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

/* ── GET /mine — the caller's RESERVED codes, for the POS cart reconciler +
      the reward configurator's "Apply PWP" toggle (which code is available in
      THIS cart). Keyed by cart_line_key on the client. */
pwpCodes.get('/mine', async (c) => {
  const supabase = c.get('supabase');
  /* OWNER = the caller's REAL staff uuid (resolveOwnerStaffId). It used to be
     `user.id` — the bridge's pin — which is ALSO what /reserve stamped, so every
     row carried the identical value and this filter was a no-op: "my reserved
     codes" returned every salesperson's held promo codes to everybody. The
     dropped `if (!u?.id) 401` above tested that pin, which the bridge always
     sets; it could never fire. The real auth gate is upstream (the global
     /api/* session auth + requireScmAccess). */
  const userId = await resolveOwnerStaffId(supabase, c.get('houzsUser')?.id, c.get('user')?.id);
  // No staff link → this caller owns no codes, and empty is the truthful
  // answer. A read must not break the POS cart reconciler; /reserve reports the
  // problem in plain language the moment they try to hold one (as pos-cart does).
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
  productId:   z.string().min(1),  // mfg_products.id of the trigger SKU
  qty:         z.number().int().min(1).default(1),
  // SOFA trigger (Phase 2) — the build's module codes (cell.moduleId). Matched
  // server-side against a SOFA rule's trigger_combo_ids. Omitted for non-sofa.
  sofaModules: z.array(z.string()).optional(),
  // Promo is ONE-WAY (Loo 2026-06-06): when the line is itself a reward
  // (bought with a PWP/promo code) it must never mint 'promo' codes — a free
  // ARRUS can't fund the next free ARRUS. 'pwp' rules still apply (换购 may
  // chain). The POS reconciler sets this; the order-Confirm backstop in
  // mfg-sales-orders.ts catches anything that slips through.
  rewardLine:  z.boolean().optional(),
});

/* ── POST /reserve — reserve codes for a trigger cart line. Idempotent per
      cart_line_key: re-reserving the same line tops up / trims to the current
      qty rather than double-generating. Returns the line's full RESERVED set.
      No rule matches → []. */
pwpCodes.post('/reserve', async (c) => {
  const supabase = c.get('supabase');
  /* OWNER = the caller's REAL staff uuid (resolveOwnerStaffId), not the bridge's
     pin every row used to carry. Fail SAFE when it will not resolve: stamping
     the shared system row hands this cart's held codes to every other
     salesperson and shows theirs here, so a reservation nobody owns is worse
     than no reservation. (The dropped `if (!u?.id) 401` tested the pin, which is
     always set — see /mine.) */
  const userId = await resolveOwnerStaffId(supabase, c.get('houzsUser')?.id, c.get('user')?.id);
  if (!userId) return c.json(STAFF_UNLINKED_PWP, 409);

  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = reserveSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'validation_failed', issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) }, 400);
  }
  const { cartLineKey, productId, qty, rewardLine } = parsed.data;

  // 1. The trigger product (category + model + base_model for sofa combos).
  const { data: prod } = await supabase
    .from('mfg_products')
    .select('code, category, model_id, base_model, size_code')
    .eq('id', productId)
    .maybeSingle();
  if (!prod) return c.json({ codes: [] });  // unknown product → nothing to reserve
  const prodCat = String(prod.category).toUpperCase();
  const triggerSizeCode = prod.size_code ? String(prod.size_code).toUpperCase() : null;

  // 2. Active rules.
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

  // 2b. Rules whose trigger matches this line. SOFA can be matched two ways:
  //     · BY COMBO  — the build's modules subset-match a rule's trigger_combo_ids
  //                   (Phase 2). Needs the build modules.
  //     · BY MODEL  — combo ids empty + model ids non-empty → ANY build of an
  //                   eligible sofa Model qualifies (2990 2026-06-20, restored
  //                   here 2026-07-27: the cutover port kept only the by-Combo
  //                   half, so the live model-based SOFA→BEDFRAME rule minted
  //                   NOTHING for any sofa — SO-2607-024). Matched on the build's
  //                   model_id, so it works even for a non-modular sofa (no build
  //                   modules). NEVER matches "any sofa": the model-id list must
  //                   be non-empty (the /pwp-rules XOR enforces it).
  //     Other categories → model match.
  let matching: typeof rules;
  if (prodCat === 'SOFA') {
    const sofaModules = (parsed.data.sofaModules ?? []).map((s) => s.trim()).filter(Boolean);
    const byModelRules = rules.filter((r) =>
      r.trigger_category === 'SOFA'
      && (r.trigger_combo_ids ?? []).length === 0
      && (r.trigger_eligible_model_ids ?? []).length > 0
      && inList(prod.model_id ?? null, r.trigger_eligible_model_ids ?? [])
      // Compartment refinement (0182/0051): an any-build sofa trigger may require a module.
      && passesRefinementColumns(
        { category: 'SOFA', modelId: prod.model_id ?? null, sizeCode: null, builtCompartments: sofaModules },
        r.trigger_size_codes, r.trigger_compartments,
      ),
    );
    let byComboRules: typeof rules = [];
    if (sofaModules.length > 0) {
      const sofaRules = rules.filter((r) => r.trigger_category === 'SOFA' && (r.trigger_combo_ids ?? []).length > 0);
      const comboIds = [...new Set(sofaRules.flatMap((r) => r.trigger_combo_ids ?? []))];
      const combosById = new Map<string, { base_model: string; modules: string[][] }>();
      if (comboIds.length > 0) {
        const { data: comboRows } = await supabase
          .from('sofa_combo_pricing')
          .select('id, base_model, modules, deleted_at')
          .in('id', comboIds);
        for (const cr of (comboRows ?? []) as Array<{ id: string; base_model: string; modules: string[][]; deleted_at: string | null }>) {
          if (!cr.deleted_at) combosById.set(cr.id, { base_model: cr.base_model, modules: cr.modules ?? [] });
        }
      }
      byComboRules = sofaRules.filter((r) => (r.trigger_combo_ids ?? []).some((cid) => {
        const combo = combosById.get(cid);
        return !!combo && (!prod.base_model || combo.base_model === prod.base_model) && matchComboSubset(sofaModules, combo.modules) != null;
      }));
    }
    matching = [...byComboRules, ...byModelRules];
  } else {
    matching = rules.filter((r) =>
      r.trigger_category === prodCat
      && inList(prod.model_id ?? null, r.trigger_eligible_model_ids ?? [])
      // Size refinement (0182): a mattress/bedframe trigger may require a size.
      && passesRefinementColumns(
        { category: prodCat, modelId: prod.model_id ?? null, sizeCode: triggerSizeCode, builtCompartments: [] },
        r.trigger_size_codes, r.trigger_compartments,
      ),
    );
  }

  // 2c. Promo is one-way (Loo 2026-06-06) — a reward line never mints 'promo'
  //     codes; only full-price purchases fund a free reward. 'pwp' rules stay.
  if (rewardLine) {
    matching = matching.filter((r) => String(r.type ?? 'pwp') !== 'promo');
  }

  /* 3. Existing RESERVED codes for THIS caller's cart line, grouped by rule.
        cart_line_key is POS-client-supplied and carries no authority — its
        entropy is a client-side contract this repo cannot verify — so it must
        never be the only predicate on a read that drives the DELETEs below.
        Scope by the ACTIVE company (mirroring the stamp the inserts use, as
        DELETE /reserve does) AND by the owner, so a colliding key from another
        salesperson's cart can neither be counted here nor trimmed there. */
  const { data: existingRows } = await scopeToCompany(
    supabase
      .from('pwp_codes')
      .select(SELECT)
      .eq('cart_line_key', cartLineKey)
      .eq('owner_staff_id', userId),
    c,
  ).eq('status', 'RESERVED');
  const existing = (existingRows as CodeRow[] | null) ?? [];

  // 4. Reconcile each matching rule to target = qty_per_trigger × qty.
  for (const rule of matching) {
    const target = Math.max(0, Math.floor((Number(rule.qty_per_trigger) || 1) * qty));
    const mine = existing.filter((e) => e.rule_id === rule.id);
    if (mine.length < target) {
      // Top up — insert (target − have) fresh codes, retrying on PK collision.
      for (let i = 0; i < target - mine.length; i++) {
        for (let attempt = 0; attempt < 5; attempt++) {
          const { error } = await supabase.from('pwp_codes').insert({
            company_id:                activeCompanyId(c),
            code:                      genCode(),
            rule_id:                   rule.id,
            reward_category:           rule.reward_category,
            eligible_reward_model_ids: rule.eligible_reward_model_ids ?? [],
            reward_combo_ids:          rule.reward_combo_ids ?? [],
            // Snapshot the reward refinement (0182) so a claim enforces it later.
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
          // else: likely a code-collision (23505) → regenerate and retry.
        }
      }
    } else if (mine.length > target) {
      // Qty reduced — trim the surplus RESERVED codes for this line+rule.
      const surplus = mine.slice(target).map((e) => e.code);
      if (surplus.length > 0) {
        // `surplus` already comes from the company+owner-scoped read above; the
        // predicate is repeated here as defence in depth, so a future widening
        // of that read cannot turn this into a cross-company/-owner delete.
        await scopeToCompany(
          supabase.from('pwp_codes').delete().in('code', surplus).eq('owner_staff_id', userId),
          c,
        ).eq('status', 'RESERVED');
      }
    }
  }

  // 4b. Trim RESERVED codes whose rule no longer matches this line at all —
  //     the line's model was edited away from a rule's trigger list, or the
  //     line became a reward and promo rules dropped out of `matching` (2c).
  //     Without this they'd ride to AVAILABLE at order Confirm as phantom
  //     vouchers the customer never legitimately earned.
  {
    const matchingIds = new Set(matching.map((r) => r.id));
    const strays = existing
      .filter((e) => !e.rule_id || !matchingIds.has(e.rule_id))
      .map((e) => e.code);
    if (strays.length > 0) {
      // Same defence-in-depth predicate as the surplus trim above.
      await scopeToCompany(
        supabase.from('pwp_codes').delete().in('code', strays).eq('owner_staff_id', userId),
        c,
      ).eq('status', 'RESERVED');
    }
  }

  // 5. Return the line's current RESERVED set — the CALLER's, scoped exactly
  //    like the step-3 read (cart_line_key alone is not a boundary).
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

/* ── DELETE /reserve?cartLineKey=… — free a trigger line's RESERVED codes
      (trigger removed from cart / cart cleared / quote deleted). Never touches
      USED / AVAILABLE. */
pwpCodes.delete('/reserve', async (c) => {
  const supabase = c.get('supabase');
  const cartLineKey = c.req.query('cartLineKey');
  if (!cartLineKey) return c.json({ error: 'cart_line_key_required' }, 400);
  // cart_line_key is POS-client-supplied and carries no authority; the client is
  // service-role, so this ACTIVE-company filter — mirroring the stamp /reserve
  // inserts with — is the only thing keeping one company's cart from destroying
  // the other's RESERVED codes. Freeing stays idempotent (a cart cleared twice,
  // a key from the other company): nothing matches, still ok.
  const { error } = await scopeToCompany(
    supabase
      .from('pwp_codes')
      .delete()
      .eq('cart_line_key', cartLineKey),
    c,
  ).eq('status', 'RESERVED');
  if (error) return c.json({ error: 'free_failed', reason: error.message }, 500);
  return c.json({ ok: true });
});

/* ── GET /by-so/:docNo — the PWP codes a Sales Order earned / spent (by
      source_doc_no). USED codes were applied on that order; AVAILABLE codes are
      vouchers the customer can redeem next time. Drives the SO/receipt display. */
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

/* ── GET /:code?rewardCategory=…&rewardModelId=…&customerId=… — validate /
      redeem-preview for the "Insert PWP Code" cross-order field + the handover
      customer-match gate. Eligibility is checked by the reward's category +
      model (the configurator has both); the per-SKU price authority stays at
      order Confirm (server uses pwp_price_sen). Marks nothing used. */
pwpCodes.get('/:code', async (c) => {
  const supabase = c.get('supabase');
  /* OWNER = the caller's REAL staff uuid (resolveOwnerStaffId). On the bridge's
     pin — which every reserve also stamped — the RESERVED branch below was true
     for ANY caller, so one salesperson's held code read as owned by whoever
     asked. null → the caller owns nothing, so only an AVAILABLE (cross-order)
     code can validate. (The dropped `if (!u?.id) 401` tested the pin — see /mine.) */
  const userId = await resolveOwnerStaffId(supabase, c.get('houzsUser')?.id, c.get('user')?.id);
  const code = c.req.param('code');
  const rewardCategory = (c.req.query('rewardCategory') ?? '').toUpperCase();
  const rewardModelId = c.req.query('rewardModelId') ?? '';
  const rewardComboId = c.req.query('rewardComboId') ?? '';  // SOFA reward (Phase 2)
  const customerId = c.req.query('customerId') ?? '';

  const { data: row } = await scopeToCompany(supabase.from('pwp_codes').select(SELECT).eq('code', code), c).maybeSingle();
  if (!row) return c.json({ valid: false, reason: 'not_found' });
  const r = row as unknown as CodeRow;

  // Redeemable iff AVAILABLE (cross-order voucher) or RESERVED-owned-by-caller
  // (same-cart). USED → spent. The `userId != null` guard is load-bearing: an
  // unidentified caller must not match a RESERVED row that happens to carry a
  // NULL owner (null === null) and thereby redeem someone else's hold.
  const redeemable =
    r.status === 'AVAILABLE' ||
    (r.status === 'RESERVED' && userId != null && r.owner_staff_id === userId);
  // Return the reward RANGE even on a USED / non-redeemable code — the POS reads
  // rewardCategory/type/eligibleRewardModelIds on EVERY found response to build the
  // swap context; without them a placed (USED-voucher) reward line falls to `locked`.
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
  // Eligibility — SOFA matches by combo id (Phase 2); other categories by model.
  if (String(r.reward_category).toUpperCase() === 'SOFA') {
    const combos = r.reward_combo_ids ?? [];
    if (!rewardComboId || !combos.includes(rewardComboId)) {
      return c.json({ valid: false, reason: 'reward_combo_ineligible' });
    }
  } else if (!inList(rewardModelId || null, r.eligible_reward_model_ids ?? [])) {
    return c.json({ valid: false, reason: 'reward_model_ineligible' });
  }

  // Customer binding (§8.8) — an AVAILABLE code is bound to its earning customer.
  // RESERVED (same-cart) codes have no binding yet. When no customerId is passed
  // (cart-stage optimistic Apply) → matches (the handover gate re-checks).
  let customerMatches = true;
  if (r.status === 'AVAILABLE' && r.customer_id) {
    customerMatches = customerId !== '' ? customerId === r.customer_id : true;
  }

  return c.json({ valid: true, rewardCategory: r.reward_category, eligibleRewardModelIds: r.eligible_reward_model_ids ?? [], customerMatches, status: r.status, type: (r.type ?? 'pwp') as 'pwp' | 'promo' });
});
