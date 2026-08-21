## A 2990 Sales Order PDF printed Houzs's Zanotti logo [high]

**Symptom.** 老板自己看到的：一张 2990 HOME SDN. BHD. 的销货单（`2990-SO-2607-026`，
公司注册号 202501060667），抬头是 2990 的公司名，印出来的商标却是 **Zanotti** ——
Zanotti 是 Houzs 的沙发牌子，不是 2990 的。**这是给客人的正式单据，上面写着是别家
公司的牌子。** 生产环境查到 **69 张 2990 的销货单现在都是这个状态**（read-only run
32455140536）。

**Root cause (traced).** Two independent causes in one block,
`backend/src/scm/routes/mfg-sales-orders.ts:2755-2793` (`GET /:docNo`, the read the
SO PDF is built from). Either one alone reproduces it:

1. the brand pool was read with **no company predicate** —
   `SELECT name, logo_r2_key FROM project_brands WHERE active = 1` — so a 2990
   request got HOUZS's brands too;
2. the SOFA branch **hardcoded the name** `'ZANOTTI'`:
   `brands.find((b) => b.name.toUpperCase() === 'ZANOTTI' && b.logoKey)`.

The rule was never missing. The owner wrote it on 2026-08-18 and
`backend/src/scm/shared/so-branding-label.ts` has implemented it for the grid
LABEL ever since — *SOFA → the COMPANY's house sofa brand ("ZANOTTI" for Houzs,
"2990s Sofa" for 2990; the line's own text is not consulted)*. The PDF **LOGO**
is a separate code path that only ever implemented the Houzs half. The split is
the lesson: a shared rule module does not cover a surface that never called it.

**Two premises this bug was reported under were REFUTED against production**
(same run), and both would have led to a needless irreversible migration:

- `project_brands` was said to have no company column. It has had
  `company_id` — `NOT NULL`, FK, indexed — since **migration 0093**.
  `0000_baseline.sql:237` is 93 migrations out of date, and `db/schema.pg.ts:184`
  (the drizzle model) still omits it.
- The baseline's global `UNIQUE(name)` was said to make per-company scoping
  impossible. Production carries **only `project_brands_pkey (id)`** — that
  unique is not there, and two names ("bedframe", "service") already exist under
  both companies. **No schema change was needed for this fix.**

**Fix.** The resolver moved out of the 11.9k-line router into
`backend/src/scm/lib/brand-letterhead.ts` (extract, not raise a ceiling) and now
resolves the **company's** house sofa brand via a new
`houseSofaBrandName(companyCode)` exported from the shared rule module — one
source of truth for both the label and the letterhead. The read carries
`activeCompanySql(c)`. `houseSofaBrandName` returns **null** for an
unidentifiable company where `brandingLabel` keeps its 2990 default: a wrong word
in a grid cell is recoverable, a wrong mark on a customer's legal document is not.

Fail-soft is preserved and is the *correct* outcome here: `"2990s Sofa"` exists
as a 2990 brand row (id=33, active) with **no** `logo_r2_key`, so a 2990 sofa
order now falls back to the 2990 company letterhead. Nothing was inserted to make
that prettier — the missing logo is the finding, and the owner can upload one.

`backend/src/scm/lib/brand-letterhead.test.ts` pins it, and was proved **RED on
the unfixed tree** — the resolver was extracted verbatim first, and 3 of 9 tests
failed against it, including *"2990 WOULD print its own sofa brand the day that
row gets a logo"* (expected the 2990 key, received `null`) and *"still refuses
Zanotti even if the pool leaks Houzs rows"* (received Houzs's Zanotti key). The
Houzs-keeps-Zanotti case is asserted so the other half cannot regress.

**Ref.** `fix/brand-letterhead-company-scope`, 2026-08-21.
