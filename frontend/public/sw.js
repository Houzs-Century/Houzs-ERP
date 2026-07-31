/**
 * Service worker — pragmatic v1.
 *
 * Strategy:
 *   • App shell (HTML/JS/CSS): cache-first with network fallback +
 *     background revalidate. Lets the app launch instantly on the
 *     home screen, even with no signal.
 *   • API requests: network-first with a timed fallback to last-good
 *     cached response. Avoids stale data on the happy path while
 *     still showing *something* in a tunnel/lift.
 *   • POST/PUT/PATCH/DELETE: never cached, never replayed by us. Real
 *     background-sync queueing is deferred to a later iteration —
 *     when offline the user just sees the toast error and tries
 *     again on reconnect.
 *
 * Cache version bumps on every deploy via the build hash baked in
 * by Vite (the asset filenames change, so cache hits naturally fall
 * through to network for new builds).
 */

// Bumping this purges old caches in the activate step. v2: HTML is now
// fetched network-first so the stale-on-first-refresh issue from v1 is
// gone; this one-shot bump also clears any v1 shell entry that has the
// pre-fix index.html baked in. v3 (2026-05-12): one-shot purge to
// recover iPhone Safari clients that were stuck on a cached CSS bundle
// after the page-access refactor — old cache-first /assets entries
// were serving pre-rebuild CSS, leaving Tailwind classes unapplied.
// v4 (2026-06-19): one-shot purge to recover staff clients left on a
// stale shell after a burst of same-day deploys (the SCM port). The
// activate step deletes the old v3 caches so every client rebuilds from
// the live build on its next load — no manual hard-refresh needed.
// v5 (2026-06-20): SCM cutover — the 2990-vendored pages replace the
// native SCM (new chunks, system-font rebrand, real document PDFs). Purge
// so every client picks up the new shell + assets on next load.
// v6 (2026-06-21): hotfix — mount PromptProvider in Scm2990Shell so the
// SCM pages that call usePrompt (Sales Order detail, pricing Maintenance
// editor) stop crashing with "usePrompt must be used within PromptProvider".
// v7 (2026-06-21): SCM sidebar re-sectioned 1:1 with 2990 (Sales Order /
// Consignment / Procurement [MRP+Products here] / Transportation / Warehouse);
// added the missing Sales Invoices, Drivers, Adjustments nav items.
// v8 (2026-06-21): 2990-parity batch — restore DataGrid CSV/Excel export, SO
// status-label wording, Products bulk inactive/active, MRP sofa line-order;
// (+ backend /document-flow + /drivers routes, no SW impact).
// v9 (2026-06-21): nav labels aligned 1:1 with 2990 — Consignment items to
// singular + full "Purchase Consignment ..." names; dropped Product Models +
// Fabric Tracking from Procurement (tabs-in-Products in 2990, not nav items).
// v10 (2026-06-21): T12 detail-page re-vendor (PO/PI/GRN/PR/PCO/PC-recv/PC-ret
// now edit product/variants + add lines) + PoLineCard/PcLineCard; dialog
// z-index, SI description2, SofaComboTab bulk/grid, ProductModels SKUs col;
// removed Order Add-ons tab + One-shot badge (Houzs unused). Backend: reports +
// so-dropdown-options routes mounted; 0022 seeds 2990 reference data on deploy.
// v11 (2026-06-21): SCM Venues + Branding now pull from Houzs Project
// Maintenance / PMS (/api/projects/venues + /api/projects/brands) — the single
// source the owner maintains centrally; SCM venue editor is read-only.
// v12 (2026-06-21): Sales Order ICR — photograph a handwritten order slip,
// Claude vision extracts it (temperature 0, catalog-validated, per-rep
// self-evolving rules), review/correct, "Open in New SO" prefills. Needs the
// ANTHROPIC_API_KEY worker secret; degrades to a friendly error without it.
// v13 (2026-06-21): 2990 SCM sync wave 1 — SO/CSO self-scope auth guards
// (6->13), PI/SI credit race-safe paid_centi, GRN over-receipt cap, combo
// cost-edit no longer overwrites selling price, dead-table fix, negative-money
// clamps, SO delivery-fee re-derive, authedFetch timeout, PDF tall-row keep.
// v14 (2026-06-21): 2990 SCM sync wave 2 (features) — RuleTarget special
// delivery fees + per-compartment fabric-tier overrides (migs 0024/0025), PO/PC
// supplier delivery dates 2/3/4 (mig 0026), MRP State column + bind-failure
// keeps dialog open, Assign-supplier on model edit page, effective-dated history
// dialog, cross-tab data sync, new-version banner.
// v15 (2026-06-22): maintenance single-source cleanup — removed the redundant
// so_dropdown_options VENUE editor (SO already uses PMS venues), Brandings tab
// now read-only from PMS /api/projects/brands, and seeded the empty Products
// Maintenance pools into master config (mig 0027): bedframe/mattress sizes,
// 15 sofa compartments, 5 supplier categories.
// v16 (2026-06-22): supplier extra columns — registration_no, nature_of_business,
// exemption_no, phone2 (mig 0028) wired into create/edit forms, ahead of seeding
// the real 36-supplier AutoCount creditor list.
// v17 (2026-06-22): Bedframe/Mattress Sizes "add" row now takes all 3 fields
// (code · label · dimensions) writing sizeLabels; suppliers list view fixed to
// expose the new columns (mig 0029 view); sofaCompartmentMeta descriptions +
// default prices seeded into master config (mig 0029).
// v18 (2026-06-22): removed the "Reopen SO" button — the backend treats a
// cancelled SO as final (so_cancelled_final); the button always 409'd with no
// notice. A cancelled SO is now visibly final; to revive, create a new SO.
// v19 (2026-06-22): Maintenance unified to ONE price — removed the COST RM
// second field across all pools; Specials tab single-price (the one number now
// feeds SO costing — fixes special add-ons contributing 0 cost), green Active,
// click-to-edit rows; Save skips the effective-date prompt when nothing changed;
// One-shot filter chip removed; Fabric single Code (supplier code) + green
// Active. Config data hard-aligned to HOOKKA live values (mig 0030).
// v20 (2026-06-22): SCM access opened to non-Owner roles — new scm.access
// permission; the /api/scm gate + nav + /scm routes now accept ["*","scm.access"]
// (Owner/IT-Admin keep access via *); granted to Purchaser + Storekeeper roles
// (mig 0031).
// v21 (2026-06-22): Specials/Sofa-Specials tabs now have real Edit/Save
// (effective-dated) + History like every other Maintenance pool, single price
// that feeds SO costing (mig 0032 special_addons_history); and the vendored
// Toast shim now uses the non-blocking corner toast instead of a full-screen
// modal — fixes the "select a value and it jumps away" interruption on the
// state->warehouse picker (and everywhere that shim was used).
// v22 (2026-06-22): system-wide dropdown/select auto-sort — a shared natural-sort
// comparator (vendor/scm/lib/sort-options.ts) applied to ~50 SCM picker lists:
// text pickers (warehouse/supplier/product/category/state/driver/branding/...)
// sort case-insensitive alphabetical; numeric pickers (postcode/heights/sizes/
// gaps/leg+divan heights) sort by leading number so "10\"" follows "9\"" not "1".
// Placeholder rows ("— Unassigned —") stay pinned first; editable Maintenance
// lists + document-status workflows left in their deliberate order.
// v23 (2026-06-22): foundation resilience batch. (1) Transient DB errors now
// self-heal end-to-end — one shared TRANSIENT_CONN_RE classifies cold-start /
// pooler-cap / dropped-socket / cross-context errors as a retryable 503, and
// the frontend now retries idempotent GETs on 503 (was: never retried any 5xx,
// so a blip surfaced as "Failed to load"). (2) Two latent SQLite-on-Postgres
// crashes fixed: date(?,..) -> date+int when shifting a project's checklist due
// dates; LIKE -> ILIKE in the two raw project-search fragments (case-insensitive
// search restored). Pairs with the per-request DB isolation fix (PR #102).
// v24 — SP size = made-to-order custom: SIZE_INFO.SP rendered "(CUSTOM)" not a
// fake 220X220 (real dims captured per-order on the SO/PO line); SP added to
// the Mattress/Bedframe Sizes maintenance pools.
// v25 — New SO Venue is manually selectable (was a 2990 locked field; Houzs
// picks venue manually, defaults to the salesperson's venue but changeable).
// v26 — SO fabric picker shows ONLY the fabric code (dropped the supplier-code
// suffix + derived colour; owner: "你只需要显示 Fabric Code 就可以了").
// v27 — variant summary no longer repeats a colour the fabric code already
// ends with ("A201-7-LIGHT BROWN BROWN" → "A201-7-LIGHT BROWN").
// v28 — SO DRAFT flow re-enabled (OCR drafts): "Save as Draft" on New SO
// (primary when from a scan), DRAFT banner + Confirm on detail, DRAFT pill in
// list; backend excludes DRAFT from KPI/MRP/PO/DO/credit. + New-SO form layout
// tidied (roomier grid) + backend variant-summary dedupe.
// v29 — OCR learning + capture (HOOKKA-parity): scan modal only re-learns when
// the operator actually edited the AI result (edit-gate, stops pool pollution),
// changed fields shown with a blue diff mark, the slip photo is kept in R2 and
// shown as "Original Slip" on SO detail, and the per-salesperson rule distill
// now runs weekly (Sun) via the existing cron.
// v30 — OCR payment read correctly + aligned to the Payments panel: a credit
// card via a bank → Merchant + that bank (MBB→Maybank); EPP with no month count
// defaults to 12 months; the parenthesised approval code is captured; the
// extracted payment seeds ONE draft row in the New-SO Payments panel (method /
// bank / installment / approval / deposit) instead of the header shortcut.
// v31 — Payment-receipt OCR (REVERTED in v32).
// v32 — reverted v31's payment-receipt OCR (owner only wants the order-slip
//   "Scan Order" upload to extract everything, incl. payment); also restores the
//   Payments-panel Slip column to a clean single upload control (v31 broke it).
// v33 — payment-receipt OCR re-added, LAYOUT-SAFE: uploading a card-terminal/EPP
//   receipt as a payment-row slip auto-scans it (/scan-payment/extract) and fills
//   method (Installment + months per owner convention) / approval code / amount,
//   fill-blanks-only. In-column UI is ONLY a spinner swapped onto the upload icon
//   (no floating label, Slip column unbroken); success silent, failure via toast.
// v34 — Scan Order dual-image: one scan can carry the handwritten order slip AND
//   a printed card-terminal receipt; the OCR auto-classifies them (order from the
//   handwriting, payment preferentially from the printed receipt), stores both in
//   R2, and SO detail shows "Order Slip" + "Payment Receipt" View-original cards.
// v35 — User Management onboarding fixes: invite is now a real /invite/:token
//   public route (works even when already logged in — fixes "can't set password");
//   accept-invite password check passes the email; Reports-To lists invited members;
//   invite dropdowns refresh after adding a dept/position; the invite form now has a
//   Role dropdown (default Position Preview) so role no longer sticks on BD Exec;
//   warns when the chosen position has no pages enabled.
// v36 — SCM modules are now per-position page keys (scm.sales / procurement /
//   consignment / transportation / warehouse / finance) in the position matrix.
//   Gating is ADDITIVE: scm.access + * still grant everything (no lockout); a
//   position granted only scm.procurement sees only Procurement, etc. Backend
//   /api/scm gate, sidebar, mobile tab bar + all /scm route guards OR the keys in.
// v37 — mobile bottom nav: the dead "Points" (/gamification, removed module) tab
//   is now "SO" → /scm/sales-orders, so staff reach Sales Orders / Scan Order in
//   one tap on the phone.
// v38 — New SO / SO Detail form on PHONE (<=600px) collapses to a SINGLE column:
//   every field on its own full-width row flowing straight down (name, dates, …)
//   instead of cramped multi-column blocks; the span-reset clears the inline
//   gridColumn:'span N' on wide fields so they don't overflow the 1-track grid.
// v39 — OCR speed: catalog prompt-cache kept warm so scans are fast for the whole
//   team (shared cache). Scan modal pre-warms /scan-so/warm on open; a keep-warm
//   runs every 30min in business hours; catalog prefix slimmed (dropped base_model).
//   First scan after a cold gap still pays the vision cost; the rest are fast.
// v40 — SCM page-access matrix now granular to L2 sub-pages: each group's
//   documents toggle separately (Sales Orders / Delivery Orders / Sales Invoices
//   / Delivery Returns; Procurement's 7; Warehouse's 4; Consignment's 6; etc.).
//   L1 Full grants the whole area (inherit); override a child to None to hide it.
//   Additive, no lockout (scm.access + * still grant everything).
// v41 — RECOVERY: production (erp.houzscentury.com) was overwritten ~40min after
//   the v40 deploy by an OLD commit (6f8f8e9 / PR#25, pre-SCM), reverting prod to
//   a very old build with no SCM. Re-deploying the current tree (SCM + this
//   session's OCR/DRAFT/L2/mobile work) to production to restore it.
// v42 — mobile density: header wordmark smaller on phone; SCM form (shared by all
//   57 SCM doc pages) gets a phone-only density pass — smaller section headers /
//   field labels / inputs + tighter padding, matching the Service Case card scale
//   so more fields fit per phone screen.
// v43 — SO OCR now feeds the REAL New-SO dropdown form directly (Scan Order →
//   upload → extract → /scm/sales-orders/new?fromScan=1, no separate free-text
//   review modal). Venue vocabulary UNIFIED: the OCR-matched venue resolves to a
//   real project_venues id (same source as the form's Venue dropdown) and seeds
//   it as a valid selection; no confident match -> left blank, never a wrong pick.
//   Edit-gate learning moved to Save; changed fields show a blue diff.
// v44 — New SO: removed the Venue helper caption ("Defaults to the salesperson's
//   venue…") per owner; the Venue dropdown stands on its own.
// v45 — MOBILE STANDARDIZATION to the Service-module card scale. Root fix: <main>
//   + SCM shell now clamp width (overflow-x-hidden) -> no page-level sideways
//   scroll anywhere. SO detail line-items / totals / payments reflow to stacked
//   label-value cards on phone; SO-list KPI -> 2x2; button rows wrap; SCM menu
//   labels no longer truncate; Project detail header/toolbar/doc-table/crew rows
//   reflow; fonts aligned to the Service label(10.5px/0.18em)+value(12.5px) tokens.
// v46 — fixed the Quality Metrics crash (null inner count -> guarded .toLocaleString
//   on 8 tiles; system-wide scan found no other unguarded ones). SCM phone type
//   scale shrunk ~15-20% (tokens scoped to .scm2990 @<=600px, headers capped at
//   ~14.5px) per owner "整体太大". SO-detail redundant subtitle hidden on phone;
//   maintenance internal slug codes hidden; line-item Description 2 now full-width.
// v47 — module-by-module mobile overflow sweep: MRP filter row + warehouse dropdown
//   + results table contained; SCM list/detail filter rows stack, selects/inputs
//   max-w-100%, ~22 inline KPI grids -> auto-fit wrap, wide tables scroll inside
//   their card. Maintenance: venues no longer show the state twice, remaining
//   internal slugs hidden (event types / lead-time / lookup lists), names -> 13px.
// v48 — SO OCR completeness: salesperson defaults to the logged-in creator (never
//   blank), Customer SO Ref + full address (state/city/postcode, option-validated)
//   extracted, variant/description SKU lines matched against fabrics+options (never
//   invent). 2990 sync: stock-take counts/adjusts per (product_code, variant_key)
//   [mig 0035 applied], SO->PO warehouse-drift detection + rebind guidance.
// v49 — system-wide bug-audit fixes: d1-compat `?N` placeholder mistranslation
//   (broke global search + every project create); 23 NOT-NULL cols got their
//   dropped DEFAULTs restored (Service/ASSR/Projects/Sales creates were 500ing);
//   scm.mfg_so_status enum gained DRAFT (Save-as-Draft was 500ing); /scm/slips
//   route mounted; PO add-item keeps so_item_id; whole Purchase-Consignment family
//   field-name mismatches fixed (blank doc-nos / RM 0.00 totals / broken deletes).
// v50 — foundation hardening: applied migration 0036 (mrp warehouse_id, was a live
//   prod 500); 9 SCM count+1 doc-no generators -> self-healing max+1; stock-transfer
//   partial-failure now compensates + returns 422 (no silent stock loss); MRP lead-time
//   read fails loud instead of zeroing; PostgREST 1000-row truncation killed via a shared
//   paginate helper across catalog/inventory/OCR/reports/reconcile/analytics; frontend
//   binary fetches get timeouts; System Health now sees SCM audit + R2/Anthropic/SCM probes;
//   L2 per-area SCM write authorization (safe no-lockout fallback).
// v51 — first deploy from the UNIFIED main (PR #113): this session's foundation
//   hardening + the other dev's Project-List status-filter / detail-card work,
//   merged. From here on, deploy from main only (Pages -> GitHub auto-deploy).
// v52 — self-heal stale-deploy chunk errors: the ChunkReloadBoundary now also
//   matches Vite's "Unable to preload CSS" message AND purges all caches before
//   the one-shot reload, so a poisoned/empty SW cache (left by the earlier empty
//   Git-integration builds) can't trap a page on "Something went wrong" anymore.
// v53 — POM tidy: 3-method payments (Merchant/Online/Cash), scan-payment receipt
//   OCR (One-Shot when no tenure, paid_at may be past), coupled Processing/Delivery
//   dates (both-or-neither, Processing = max(today, delivery-6wk)), OCR prompt
//   rebranded to Houzs Century, AEON/HSBC banks.
// v54 — Branding config: company name/reg/address/phone/email centralized into one
//   Settings -> Branding editor (app_settings 'branding' key); OCR prompts, PDF
//   letterheads, email, and UI chrome all read it. Edit the company identity once.
// v55 — OCR polish (phone MY default, JM->plain match, receipt-as-slip, payments
//   table scroll, cross-salesperson shared-rules layer) + Mail Center (shared
//   inbox: Inbox/Thread/Compose, Email Alias per member, Gmail IMAP pull inbound).
// v56 — Mail Center: department placeholders switched from Hookka's
//   Support/Finance/HR to Houzs's real departments (Sales/Operation/IT/Management);
//   hello@ mailbox assigned to the owner (seeded) so "New email" unlocks.
// v57 — OCR scan: line chip is now just the short "Slip: …" reference (dropped the
//   verbose AI ambiguity/operator notes); Note no longer carries venue/delivery
//   (each has its own field) — only the genuine standalone remark.
// v62 — SO OCR (scan-so): customerSoRef prefers the printed ZNT#### docket (not a
//   handwritten "SO…"); dropped the verbose "Slip:" line chip; Square Pillow matches
//   its accessory SKU; matched fabric colour (e.g. BO315-22) now reaches the SO line
//   variants; multi-compartment sofa "2R+1R" emits one line per compartment.
// v61 — SCM sofa: compartment art images (PNG + SVG set) vendored from 2990 into
//   /public/sofa-modules — the Maintenance Compartments pool + SKU master now
//   render pictures (were empty 404 boxes). 1S/2S/3S art_filename set.
// v60 — SCM sofa: PO PDF renders a top-down sofa orientation schematic
//   (compartments + LHF/RHF + faces-TV, ported from 2990's PO-PDF). Catalog
//   re-seeded per-MODEL: 8 models -> 97 section SKUs; 1S/2S/3S added to the pool.
// v59 — Mail Center: single flat nav entry (match Hookka) + brass design tokens +
//   department sidebar + inbound alias routing by Delivered-To + member alias on
//   the profile card & as Compose "From". SCM: Draft/Confirmed two-state for
//   SO/DO/SI/PO/GRN/PI (visible tabs + leak guards; migs 0040-0044). Projects:
//   PIC + Sales-Attending list all Sales-dept members (brand-relaxed); Dismantle
//   Time moved above Dismantle crew; OPERATION checklist items default to N/A.
// v58 — Mail Center: admin "Mailboxes" tab in User Management (assign a mailbox to
//   a person or a Houzs department + access matrix + view-level); replies now send
//   FROM the chosen mailbox (hello@). OCR scan: 2nd phone -> Emergency Contact;
//   removed the per-line "scanned · NN%" review chip from the create-SO page.
// v64 — Mail Center per-user FULL isolation (incl. admins): visibility follows
//   mail_user_scope.level for everyone; a mail admin keeps MANAGEMENT rights but
//   no longer auto-sees every mailbox. GET /addresses?manage=1 = the all-list for
//   the Mailboxes admin tab; sidebar + Compose stay scope-bound. Each member sees
//   only their own personal mailbox + shared mailboxes explicitly granted.
// v65 — Mail Center -> Hookka parity: (1) "Auto-sent" folder + Outbox panel +
//   reader modal — view system mail sent from no-reply@ (DO/invoice/CN/PO/invite)
//   via GET /outbox(+/:id); (2) reply/compose attachments now actually delivered
//   (Resend body carries them; were validated then dropped); (3) search box moved
//   from the bottom of the left rail to a top full-width row (Gmail-style).
// v66 — SCM frontend re-sync to 2990 (8-item drift fix): DataGrid row-click
//   multi-select restored; exportValue/exportName + batch-PDF on all doc-list
//   pages (Excel exports real numbers, not text); DateField restored on DO/SI/DR
//   + PaymentsTable (DD/MM/YYYY, kills locale MM/DD); supplier Currency picker
//   re-added; Warehouse master page + form drawer; PO supplier-revised delivery
//   dates wired end-to-end. (Promo refinement UI deferred — Houzs has no PWP
//   editor yet; backend reward_size/compartment columns are live.)
// v160 (2026-07-13) — one-shot purge to move every staff device onto the
//   same-origin /api proxy bundle. Old cached bundles still call the
//   *.workers.dev origin directly, which some MY mobile carriers
//   intermittently block — cases "appeared hours late" because the LIST
//   fetch was blocked on those devices while the data was already in the
//   DB (form intake lands in ~15s). Purging the shell forces the next
//   launch onto the current build, whose API calls ride erp.houzscentury.com.
// v169 (2026-07-14) — service-case mobile redesign: tabbed detail
//   (Overview / Stage / Info / Timeline), Status Cards list, 8-stage
//   workflow (Pending Inspection retired into Under Verification).
//   (v168 was taken by the multicompany/cutover release on main.)
// v185 (2026-07-16) — THE fix for the frequent "Something went wrong loading
//   this page." panel: cacheFirst() answered a hashed /assets/*.js request with
//   the cached index.html whenever its network fetch threw (and cached the SPA
//   catch-all's 200-HTML under the .js key after a deploy). A code request is
//   now never answered with, cached as, or served from HTML — it fails cleanly
//   so ChunkReloadBoundary can self-heal. The one-shot purge this v-bump used
//   to be relied on for is already guaranteed by __SW_BUILD_ID__ below; the
//   bump is documentation, and it does clear any already-poisoned entry.
// Auto-versioned per deploy: the build replaces the __SW_BUILD_ID__ token below
// with a unique build id (vite.config `sw-build-version` plugin), so every deploy
// yields a new VERSION → a new cache namespace → the activate step purges the old
// caches. This removes the manual-bump failure mode — a forgotten bump served a
// stale shell, and parallel branches even collided on the same vNNN (see git log:
// "bump v172 (branch collided with #421's v171)"). The manual `v176` prefix stays
// only as a human-readable baseline; the appended build id is what guarantees
// uniqueness. If the build plugin somehow didn't run the token stays literal —
// still a valid (if non-unique) string, so it degrades gracefully.
//
// v187/v188 (2026-07-17) — NOT feature bumps: both are deploy recoveries for the
// same cause, twice in one session. A burst of merges outruns deploy.yml. It is
// push-only with `concurrency: cancel-in-progress: false`, so the running deploy
// finishes and the queued ones collapse to the newest — the middle ones are
// cancelled before their frontend job exists. dorny/paths-filter then compares
// github.event.before..github.sha on the ONE survivor, sees a backend-only diff,
// and skips the frontend. Every frontend change in a cancelled run never ships,
// and the deploy that ran goes GREEN. v188 recovers 8 files including the whole
// authToken seam — i.e. the owner's view-as flow was fixed, merged, and not live.
// The release gate now fixes the class instead of relying on another bump:
// deploy.yml always rebuilds the latest main frontend after a completed run and
// exposes workflow_dispatch as a one-click recovery. A burst can collapse
// intermediate runs, but the surviving run can no longer skip the latest UI.
// v189 (2026-07-19) — canonical-redirect fix. The pages.dev -> houzscentury.com
// 302 shipped in #855 never reached returning PWA users: THIS worker intercepts
// the navigation, and because navigationNetworkFirst fetches it with redirect
// mode "manual" (all navigation requests are manual-redirect), the edge 302
// comes back as an opaqueredirect (status 0, not `ok`), so the catch below
// serves the cached index.html — the app kept rendering on pages.dev, address
// bar unchanged. Worse, the edge ALSO 302'd /sw.js, and a redirected worker
// script fails the SW update, so no corrected worker could ever install. This
// build fixes both ends: functions/[[path]].ts now redirects only document
// navigations (so /sw.js + assets are served, unblocking this very update), and
// on the legacy host this worker retires itself and stops intercepting so the
// browser's own navigation reaches the edge 302 (see ON_LEGACY_PROD_HOST). The
// one-shot cache purge also drops the stale shell. Installed clients redirect on
// their next navigation / reload.
// v190 (2026-07-31): cacheFirst now retries code requests with cache:"reload"
// when the network answers HTML, healing browsers whose own HTTP cache holds
// an immutable SPA-fallback response under a hashed asset URL. See cacheFirst.
const VERSION = "houzs-erp-v190-__SW_BUILD_ID__";
const SHELL_CACHE = `${VERSION}-shell`;
const API_CACHE = `${VERSION}-api`;

// Pre-cache the bare-minimum shell so the app is launchable offline.
// Hashed assets (built JS/CSS) are picked up lazily on first fetch.
//
// The two brand logos USED to be listed here, and they were the cause of the
// "spins forever, works after Reload" reports that followed every deploy.
// install fetches this list with `cache: "no-store"` inside `waitUntil`, so
// each new SW forced a fresh 433 KB download (logo-mark 110 KB +
// logo-wordmark 323 KB) over the same connection the app's API calls were
// using — and `networkFirst` aborts those at 4s (fetchWithTimeout below),
// then answers the app with a synthetic 503 `{offline:true}` because a
// just-deployed API_CACHE is empty. Net effect on a phone: real requests
// cancelled at exactly 4.00s, error page, reload, fine (logos now cached).
// Measured 2026-07-17 on prod: logo-wordmark 21.28s, logo-mark 10.74s, with
// /delivery-orders and /my-cases cancelled at 4.01s alongside.
//
// Nothing is lost by omitting them: the fetch handler routes every
// non-navigation request (logos included) to cacheFirst, so they are cached
// on first render and offline-available from then on. The only uncovered case
// is a cold FIRST launch with no network, which cannot reach the login screen
// anyway. Keep this list to what the shell cannot boot without; an image is
// never that. Weigh bytes before adding anything here.
const SHELL_URLS = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      // addAll fails the install if any one URL 404s — tolerant
      // version using individual put-on-success keeps the SW alive
      // when one shell asset goes missing temporarily.
      Promise.allSettled(
        SHELL_URLS.map(async (url) => {
          try {
            const r = await fetch(url, { cache: "no-store" });
            if (r.ok) await cache.put(url, r.clone());
          } catch {}
        })
      )
    )
  );
  // Take over from the previous SW immediately on first install so
  // users don't need to close every tab.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => !k.startsWith(VERSION))
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

const IS_LOCAL_DEV =
  self.location.hostname === "localhost" ||
  self.location.hostname === "127.0.0.1";

// The Cloudflare Pages default host for PRODUCTION. A worker installed here
// before the canonical-domain redirect existed keeps serving the cached shell
// for navigations, which is why the #855 redirect never reached returning PWA
// users. On this host the worker gets out of the way (retires + stops
// intercepting) so the browser's navigation reaches the edge 302 to the
// canonical domain — the browser carries the original #fragment across the hop.
// EXACT host only: staging (houzs-erp-staging.pages.dev), previews
// (<hash>.houzs-erp.pages.dev), erp.2990shome.com, the canonical domain and
// localhost all keep the normal worker (their hostname !== this constant).
const LEGACY_PROD_HOST = "houzs-erp.pages.dev";
const ON_LEGACY_PROD_HOST = self.location.hostname === LEGACY_PROD_HOST;
let legacyHostRetired = false;

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Legacy production host (houzs-erp.pages.dev): step aside. Do NOT intercept —
  // returning without respondWith() hands the request back to the browser, whose
  // navigation then reaches the edge and follows its 302 to erp.houzscentury.com
  // (fragment preserved). Serving the cached shell here is exactly what kept the
  // app on pages.dev. Also retire this worker + purge its caches (once) so it
  // stops controlling the origin entirely on the next visit.
  if (ON_LEGACY_PROD_HOST) {
    if (!legacyHostRetired) {
      legacyHostRetired = true;
      self.registration.unregister().catch(() => {});
      caches
        .keys()
        .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
        .catch(() => {});
    }
    return;
  }

  // Local dev (vite): never intercept. Caching the module graph cache-first
  // shadows HMR — edits don't show until the SW is cleared. Belt-and-suspenders
  // with pwa.ts, which unregisters the SW entirely in dev.
  if (IS_LOCAL_DEV) return;

  // Never intercept cross-origin (fonts CDN, Google APIs, etc.).
  // The browser handles these — caching them ourselves invites
  // CORS surprises on offline retry.
  if (url.origin !== self.location.origin) return;

  // Mutating requests bypass the SW entirely. We don't queue them
  // yet; the page handles failure via toast + manual retry.
  if (req.method !== "GET") return;

  // API requests: passthrough — do NOT intercept. Same-origin /api/* is
  // proxied to the Worker by the Pages Function (functions/api/[[path]].ts);
  // the api client has its own 27s timeout + retry ladder, and the SW's 4s
  // networkFirst cutoff would fail cold-DB requests that would otherwise
  // succeed. (Before the proxy the API was cross-origin, so the SW never
  // saw these requests — this keeps that exact behavior.)
  if (url.pathname.startsWith("/api/")) return;

  // HTML / SPA navigation requests must always try the network first so a
  // fresh deploy is picked up on the very next refresh. Falls back to the
  // cached index.html only when offline. Without this, cache-first served
  // a stale index.html for one extra refresh after every deploy.
  const isNavigation =
    req.mode === "navigate" ||
    url.pathname === "/" ||
    url.pathname === "/index.html";
  if (isNavigation) {
    event.respondWith(navigationNetworkFirst(req));
    return;
  }

  // Everything else (hashed /assets/*, manifest, logos): cache-first with
  // background refresh. Hashed asset filenames change on every build, so
  // serving them from cache is always correct for the corresponding HTML.
  event.respondWith(cacheFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(API_CACHE);
  try {
    // 4-second timeout: don't make the user wait forever if the
    // network is "present but broken" (captive portal, lift, etc.).
    const fresh = await fetchWithTimeout(req, 4000);
    if (fresh && fresh.ok) {
      cache.put(req, fresh.clone()).catch(() => {});
      return fresh;
    }
    throw new Error("network response not ok");
  } catch {
    const cached = await cache.match(req);
    if (cached) return cached;
    // Truly nothing — return a synthetic 503 so the app's error
    // path renders instead of throwing an unhandled rejection.
    return new Response(
      JSON.stringify({ error: "offline", offline: true }),
      {
        status: 503,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}

// Navigation = the SPA's index.html shell. Always try network first so a
// new deploy lands on the next refresh; cache fallback only kicks in when
// the user is offline (lift, tunnel, no signal at venue).
async function navigationNetworkFirst(req) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const fresh = await fetchWithTimeout(req, 4000);
    if (fresh && fresh.ok) {
      // Mirror the shell into cache under both the requested URL and
      // /index.html so the offline fallback below finds it for a deep link
      // (/scm/sales-orders/SO-...) that was never cached under its own URL.
      cache.put(req, fresh.clone()).catch(() => {});
      cache.put("/index.html", fresh.clone()).catch(() => {});
      return fresh;
    }
    throw new Error("network response not ok");
  } catch {
    const cached =
      (await cache.match(req)) || (await cache.match("/index.html"));
    if (cached) return cached;
    return new Response("Offline", { status: 503 });
  }
}

// INVARIANT (do not weaken): a request for CODE is never answered with — or
// served from — the HTML app shell. The browser strict-MIME-checks module
// scripts, so an index.html body under an /assets/*.js URL fails the import
// with "Failed to fetch dynamically imported module: <url>", which surfaces as
// the route's "Something went wrong loading this page." panel. Two real
// sources of an HTML body on a .js URL:
//   • a transient network failure — we used to hand back the cached shell;
//   • Cloudflare Pages' SPA catch-all, which answers ANY unrecognised path
//     with 200 + index.html, including an /assets/<name>-<hash>.js whose hash
//     died in a redeploy (an open tab on the old shell still asks for it).
// Both must fail honestly instead: a clean error lets ChunkReloadBoundary
// self-heal onto the live build, and — critically — is never cached.
function isCodeRequest(req) {
  if (req.destination === "script" || req.destination === "style") return true;
  // destination is empty for some preloads/older engines — fall back to path.
  return /\.(?:js|mjs|css)$/i.test(new URL(req.url).pathname);
}

function isHtml(res) {
  return (res.headers.get("content-type") || "").includes("text/html");
}

// An honest failure: no body, never cached. import() rejects with the
// stale-chunk message the boundary already recognises; an <img>/manifest just
// fails as it would have with an HTML body anyway.
function notAvailable() {
  return new Response("", {
    status: 504,
    headers: { "Cache-Control": "no-store" },
  });
}

async function cacheFirst(req) {
  const cache = await caches.open(SHELL_CACHE);
  const code = isCodeRequest(req);
  const cached = await cache.match(req);
  // Ignore (don't serve) a poisoned entry — HTML stored under a .js/.css key
  // by a pre-fix build. The VERSION purge clears these on the next deploy
  // anyway; this makes the cache-hit path unable to return HTML for code even
  // if one survives.
  if (cached && !(code && isHtml(cached))) {
    // Background revalidate — keep the shell fresh for next time.
    fetch(req)
      .then((r) => {
        // A dead-hash SPA-catch-all 200 is `ok` — without this check the
        // revalidate would OVERWRITE good cached JS with the HTML shell and
        // brick the asset for every later load.
        if (r && r.ok && !(code && isHtml(r))) cache.put(req, r.clone()).catch(() => {});
      })
      .catch(() => {});
    return cached;
  }
  try {
    let r = await fetch(req);
    // HTML for a code URL means SOMETHING upstream answered with the SPA
    // fallback. Before giving up, RETRY bypassing the browser HTTP cache
    // (owner outage 2026-07-31): during a deploy race the CDN served
    // index.html under hashed /assets/*.js URLs carrying the year-long
    // immutable header, so every browser stored HTML in its OWN HTTP cache
    // under those URLs. `fetch(req)` reads that cache, so this branch fired
    // forever after and the Projects / ASSR routes never loaded — a 504 that
    // no reload, cache purge, SW VERSION bump or asset-namespace change could
    // clear, because the poison was client-side and immutable for a year.
    // cache:"reload" refetches from the network and REPLACES the poisoned HTTP
    // cache entry, so the next plain fetch is clean too: self-healing, no user
    // action. Only for code requests, only when HTML came back.
    if (code && r && isHtml(r)) {
      try {
        r = await fetch(req.url, { cache: "reload", credentials: "same-origin" });
      } catch {
        return notAvailable();
      }
      if (!r || !r.ok || isHtml(r)) return notAvailable();
    }
    if (r && r.ok) cache.put(req, r.clone()).catch(() => {});
    return r;
  } catch {
    // Network failed. Every request reaching cacheFirst is a SUBRESOURCE — the
    // fetch handler routes navigations to navigationNetworkFirst above and
    // returns before this — so the old "SPA fallback: return index.html" here
    // could only ever mis-answer a script/style/image. Fail cleanly instead.
    return notAvailable();
  }
}

function fetchWithTimeout(req, ms) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), ms);
    fetch(req, { signal: controller.signal })
      .then((r) => {
        clearTimeout(t);
        resolve(r);
      })
      .catch((e) => {
        clearTimeout(t);
        reject(e);
      });
  });
}
