## Cross-company holes on the sales-pricing side: PWP voucher burn, consignment price-override, sofa-combo edit [high]

<!-- area: Sales orders + pricing -->

**白话.** 三个跨公司的漏洞，都因为我们的数据库连线是「服务角色」——它会绕过数据库
自己的公司隔离，所以每一条写入必须自己带上「哪一间公司」这个条件，否则就会写到另一
间公司的资料上。(1) 开销售单用换购券(PWP)时，认券/烧券/回滚都只认券号，不认公司；
换购券的券号在两间公司之间可能撞号，于是可能烧掉、或写坏另一间公司的券。(2) 寄卖单
(Consignment)改单价这个「会动钱」的动作，只挡了业务员范围，却没检查「改价权限」
(`scm.so.price_override`)——只有看单权限的人也能改价；销售单那边本来就有挡。(3) 沙发
套装价(Sofa Combo)用 id 改价时，先读来源那一行没有带公司条件，可能把另一间公司的
套装价复制成本公司的新价。

**Symptom.** Three service-role writes on the sales/pricing side carried no
`company_id` predicate, so a caller in company A could reach company B's rows.
Found by a targeted cross-tenant audit (2026-08-19), all traced on `origin/main`.

**Root cause (traced, PROVEN by reading the handlers).** The SCM supabase client
is service-role and bypasses RLS (mig 0061 enabled RLS with no policies), so the
hand-written `company_id` predicate IS the entire tenant boundary.
- **PWP burn** (`mfg-sales-orders.ts`, SO create loop ~L3675/L3808/L3838): mig 0188
  re-keyed `pwp_codes` on `(company_id, code)`, but the prefetch `.in('code', …)`,
  the atomic `.update({status:'USED'}).eq('code', code)` and the rollback
  `.update(patch).eq('code', code).eq('status','USED')` all keyed on the
  caller-supplied `code` alone. Two swap-line reads (~L9146/L9713) read
  `pwp_codes` by `.eq('code', …)` unscoped too. The already-safe siblings are
  `pwp-claim-single.ts` (scopes by company_id) and the add-line path (~L3828,
  refuses on unresolved company).
- **Consignment price override** (`consignment-orders.ts`, POST
  `/:docNo/items/:itemId/override`): re-prices a line ("WRITES MONEY") but only
  checked `selfScopedConsignmentBlocked`; never `scm.so.price_override`, while the
  SO twin (`mfg-sales-orders.ts:6205`, `isPriceOverrideCaller`) does.
- **Sofa combo edit** (`sofa-combos.ts`, PUT `/:id`): the edit-by-id alias read the
  source combo `.eq('id', id)` on per-company `sofa_combo_pricing` (company_id NOT
  NULL since mig 0083) with no scope, then inserted a new effective row for the
  active company — cloning another company's price. The sibling DELETE `/:id` was
  scoped 2026-08-13.

**Fix.** PWP: resolve `pwpCompanyId = activeCompanyId(c)` once, refuse
`company_unresolved` (409) when null while codes are present, and add
`.eq('company_id', pwpCompanyId)` to the prefetch, the burn and the rollback; the
two swap reads now go through `scopeToCompany(...)`. Consignment override: add the
`scm.so.price_override` gate (403 `price_override_admin_only`) before the self-scope
and row reads. Sofa combo PUT: wrap the source read in `scopeToCompany(...)` so a
foreign id resolves to nothing (404). Handlers exported for the test. Coverage in
`tests/crossTenantUncoveredLeaks.test.ts` (both directions; proven red before fix).

**Ref.** this PR, 2026-08-19.
