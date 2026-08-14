# 2990 → Houzs Cutover — HAND-OFF

> **The cutover is LIVE.** 2990 POS runs entirely on Houzs company_2 as of 2026-07-21.
> Read `../archive/2990-cutover/CUTOVER-PLAN.md`, `../archive/2990-cutover/DATA-FLOW.md`
> and `../archive/2990-cutover/FLIP-RUNBOOK.md` for background — all three were
> archived 2026-08-13 because the flip they plan happened; this file is the outcome.
> Last updated: 2026-07-23 (branding backfill + GL import + multi-company scaling doc).

## TL;DR

- ✅ **FLIP DONE 2026-07-21.** `HOUZS_OWNS_2990=true` on the Houzs Worker; POS `VITE_BACKEND_TARGET=houzs` baked into the deployed bundle. 2990's own API/backend no longer receives writes from the POS.
- ✅ **Data / API / POS UI / SSO / owner-rule alignment: DONE.** Every P0 + P1 surfaced by the flip-day bug sweep is fixed + deployed.
- ✅ **GL imported 2026-07-23** (PR #1134). 2990's 31-account chart (200-0000 Fixed Assets, 300-0000 Trade Debtor, 310-0000 Inventory, …) imported into `scm.accounts` under `company_id=2`. Post-import verified: company_2 now has **43** accounts (31 imported + **12 pre-existing**, most likely from the P&L-by-company split backfill; their codes are distinct from the 31, which is why the pre-import collision check was clean). company_1 (HOUZS) = 12. The chart is per-company in code (`accounts.company_id NOT NULL` + `/accounts`,`/journal-entries`,`/gl` scopeToCompany). The old "accounts GL hole" is CLOSED. OPEN: owner to eyeball whether the 12 pre-existing company_2 accounts overlap in meaning with the imported chart (codes don't collide; a semantic dedup may be wanted).
- ✅ **Branding backfilled 2026-07-23** (PR #1133). 235 company_2 rows rewritten to the maintained dropdown (main-category casing/suffix fixes + service/accessory → category brand). Houzs untouched (0 changes — its dropdown has no Accessories/Service brand). See §5.
- 🧭 **Multi-company scaling answered** (PR #1135, `docs/MULTICOMPANY-SCALING.md`): doc-number tables safe via per-company series prefix; the real landmines before company 3 are 4 natural-key masters (`accounts`, `product_models`, `product_dept_configs`, `pwp_codes`) needing `UNIQUE(company_id, key)`.
- **What to do next:** watch prod for a few clean days on Houzs, then retire 2990's own `apps/api` + `apps/backend`. See §4. Before onboarding company 3, land the 4 per-company-constraint migrations.

---

## Coordinates (systems + keys)

| Thing | Value |
|---|---|
| Houzs backend repo | `hello-houzs/Houzs-ERP` — LIVE on prod (`erp.houzscentury.com`) |
| POS repo | `wenwei4046/2990s` — LIVE on prod (`2990s-pos.pages.dev`) |
| Houzs prod DB (Supabase) | project `anogrigyjbduyzclzjgn`; worker `autocount-sync-api` |
| Houzs staging | project `minnapsemfzjmtvnnvdd` |
| 2990 source DB (Supabase) | project `dolvxrchzbnqvahocwsu` (frozen; still has 2990's own `apps/api` running until retired) |
| 2990 live API (photo fetch only, retire-with-2990) | `https://api.2990shome.com` |
| Houzs R2 bucket | `houzs-erp` |
| Company id | HOUZS = 1, **2990 = 2** (`companies.code='2990'`) |
| Flip switches | Houzs env `HOUZS_OWNS_2990=true` + POS build `VITE_BACKEND_TARGET=houzs` (BOTH LIVE) |
| POS SSO endpoint | `POST /api/pos/exchange-web-session` — POS token → fresh desktop session for the same user |
| Import script | `backend/scripts/migrate-2990-into-houzs.mjs` (+ `cleanup-2990-import-strays.mjs`, `diag-2990-import.mjs`) |

---

## 1. What's live

### Backend (Houzs)
- Cutover flip **PR #966 merged 2026-07-21** — `HOUZS_OWNS_2990=true` on prod. All 4 mirror-guard families (SO readonly, SO create-block, `loadAmendmentForWrite`, `assertNotMirrored`) lift correctly.
- POS-facing surface: `/api/scm/pos-pools/*` (cost-stripped combos/pools), `/api/pos/{pin-login, sales-staff, sales-stats, set-pin, verify-pin, exchange-web-session}`, `/api/scm/mfg-sales-orders/*` (POS is now the primary writer), `/api/scm/slips/*` (Worker-proxy upload), `/api/scm/categories`, `/api/scm/pos-pools/size-library`, `/api/scm/addons`.
- New endpoint `POST /api/pos/exchange-web-session` (PR #979) — mints a fresh no-origin desktop session for the same user; underlies the POS Houzs SSO menu.

### POS front-end
- **Bundle points at `erp.houzscentury.com/api/scm` (PR #733).** Every catalog / configurator / order / payment / slip / KPI call goes to Houzs company_2.
- **Topbar Houzs SSO menu (PR #738).** 3 items — Manual Sales Order (`/scm/sales-orders/new`), Service Case (`/assr`), My Service Cases (`/my-cases`) — each opens the Houzs backend page in a new tab, SSO-logged-in.
- **Post-flip alignment sweep (PRs #735 #736 #737 #739 #740 #741 #742):** categories/size_library prefix-strip, sofa legHeight rule aligned, TbcLineEditor Custom/other read+edit, address CONTROLLED-fields locked past processing_date, addons prefix REVERT (was breaking Dispose/Lift booking silently), Processing-Date threshold 50%→30%, `editablePlaced` includes `processingPassed`, slip Zod schema aligned to Houzs proxy-upload, 6 owner-rule error codes now have friendly copy in the handover path.

### Data in Houzs company_2 (prod)

Sales core + catalog + configurator + pricing **100%** and kept fresh (SO live-mirror still runs but no longer feeds new orders — POS writes directly now).

**ERP tail** caught up 2026-07-21 via the workflow:

| Table | Rows | Status |
|---|---|---|
| mfg_sales_orders / items / payments | 68 / 202 / 62 | ✅ live, POS writes here now |
| purchase_orders / items | 42 / 86 | ✅ imported |
| grns / items | 20 / 44 | ✅ |
| purchase_invoices / items | 15 / 34 | ✅ |
| delivery_orders / items | 16 / 40 | ✅ |
| inventory_movements / lots / consumptions | 80 / 52 / 27 | ✅ |
| pwp_codes / rules / analysis_customer_targets | 59 / 3 / 1 | ✅ |
| drivers / currencies / app_config | 3 / 4 / 2 | ✅ |
| categories / size_library / addons | 9 / 7 / 11 | ✅ (all `2990-`-prefixed at DB, POS normalises where safe) |
| product_size_variants | 132 | ✅ (was 264 pre-cleanup — 132 dangling rows deleted, importer DANGLING_GUARD added) |
| GL (scm.accounts) | 0 or 12 | ⏸️ waiting on Ecount decision |
| lorries | 0 | ✅ deliberately excluded per owner rule |

### Bugs found + fixed on flip day (2026-07-21 / 22)

| PR | Sev | Bug |
|---|---|---|
| Houzs #966 | — | THE FLIP: `HOUZS_OWNS_2990=true` |
| Houzs #976 | **P0** | `upsert_customer_by_name_phone` cross-company binding — POS SO for a repeat customer whose name+phone matched a HOUZS customer was rewiring to the wrong company's row. Mig 0164. |
| POS #735 | P0 | Catalog empty — POS `useCategoriesAll` didn't strip `2990-` prefix; sidebar id `2990-mattress` never matched product bucket `mattress` |
| POS #736 | P1 | size_library prefix strip + addons strip + `lead-times.ts` `SOFA_CATS.has()` normalise — mattress SIZE picker + 0-day lead-time bugs |
| POS #737 | P1 | Sofa legHeight rule aligned to Houzs (`required:false`); TbcLineEditor gained Custom/other read+edit |
| POS #738 + Houzs #979 | feature | POS topbar Houzs SSO menu (3 buttons) + backend exchange endpoint |
| Houzs #985 | P1 | State change on unlocked SO now 409s when a line's warehouse would drift — prevents supplier shipping to the wrong warehouse |
| POS #739 | P1 | POS UI mirrors Houzs address lock — state/city/postcode read-only past processing_date |
| POS #740 | P0 | REVERT POS #736's addons prefix strip — was silently dropping Dispose/Lift service line (customer not charged) |
| POS #741 | P1 | Processing-Date threshold 50%→30% + `editablePlaced` includes `processingPassed` |
| POS #742 | P1 | Slip Zod schema aligned to Houzs proxy-upload; describePosHandoffError gained 6 owner-rule branches |

---

## 2. Post-flip verification (all green as of 2026-07-22)

Live-probed via Chrome MCP with a real Bernard PIN session:
- PIN login mints a POS session (`origin='pos'`)
- Catalog spine returns 267 pos_active company_2 mfg_products; sidebar buckets: Sofa 178 / Bedframe 38 / Mattress 32 / Accessory 19
- Mattress detail page's SIZE picker renders sizes (Queen / King with correct prices)
- `/api/scm/mfg-sales-orders/mine` returns Scarlett's 28 historical SOs; detail read + no-op PATCH both 200
- `/api/pos/exchange-web-session` mints a fresh desktop session; opening `#sso=<token>&next=/scm/sales-orders/new` lands on the Houzs New SO form logged in as Bernard
- POS bundle grep: `erp.houzscentury.com/api/scm` present; `2990-` prefix regex baked

---

## 3. What is NOT yet done / open items

1. **`accounts` (GL)** — 31 rows in 2990. Owner ran Route A on 2026-07-21 (copy HOUZS chart with `2990-` prefix, 12 accounts) OR is waiting on the Ecount export for Route B (owner's own Ecount chart). Confirm via `SELECT company_id, count(*) FROM scm.accounts GROUP BY 1`. Seed SQL template is in this session's scratchpad.
2. **SO line-item photos** (`mfg_sales_order_items.photo_urls`) — private 2990 R2 bucket `2990s-so-item-photos`; not backfilled. Needs 2990 R2 S3 creds if the owner wants them; otherwise retire with 2990.
3. **Manager visibility for Bernard** — `sales_executive` position, so `mine?scope=all` is capped to his own SOs and `/sales-analysis` returns 403. Owner deferred ("do later").
4. **Sales `scm.so.remove_processing_date` permission** — owner ruled NOT granting it; sales stay routed through the amendment workflow (like Houzs's own rule) for post-processing-date changes.
5. **Pricing-recompute parity pass** — Houzs `mfg-pricing-recompute.ts` + its 55-case test remain the authority (drift gate lives there, not in `packages/shared`). Any future 2990-side price-math change must be ported deliberately.
6. **Sofa HEADREST module data setup** (from the rule-alignment audit) — POS side has HEADREST in its shared `SOFA_MODULES`; Houzs doesn't. If a sofa Model's `allowed_options.compartments` doesn't include HEADREST + a `{model_code}-HEADREST` SKU isn't seeded, a POS sofa with a HEADREST cell 400s at checkout. Not a code fix — needs commander to seed missing SKUs OR POS to hide the HEADREST tile per-Model.
7. **hr-commission.ts** — POS bundle carries the v1 engine; Houzs is on v2 (chain override + DRAFT/CANCELLED/ON_HOLD exclusion). POS commission previews may overstate. Port scope ~400 lines.
8. **Installment as L1 payment method** — POS still shows 4 method cards (Merchant / Online / Cash / Installment); Houzs converged to 3 (Installment is a plan under Merchant). Not urgent — Houzs accepts POS's Installment legacy shape.

---

## 4. Retire 2990 backend (§D — future)

Prerequisites (all currently GREEN):
- POS writes only Houzs (confirmed via bundle grep) ✅
- Mirror-guards lifted ✅
- Amendments raised in Houzs (`/scm/amendments` desktop) not on 2990 ✅
- Every daily-workflow page has a Houzs equivalent ✅ (per the feature-parity audit)

Blockers before turning 2990 off:
- Photo pipeline: 2990 `api.2990shome.com/product-models/:id/photo/:key` is the ONLY public source for the original R2 blobs. Houzs's R2 has been populated (48 model heroes copied), so retiring 2990's R2 is safe. Any SO-item photos (private bucket) still on 2990-only.
- 2990 backend UI: the coordinator/finance staff must move to Houzs `/scm/*` for daily work. Confirm no bookmarks / muscle-memory still hit `admin.2990shome.com`.
- 2 wrangler crons on 2990 side (slip reaper `*/10`, weekly rule distillation `SUN 0 20`) — harmless post-flip (slips POS no longer creates on 2990); can be left running or turned off during retirement.

Recommended: soak 1–2 weeks of clean prod on Houzs, verify GL month-end reconciles, then formally decommission 2990's Cloudflare Workers + freeze the Supabase project as a read-only backup.
