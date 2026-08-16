/**
 * Flat catalog of every permission the app understands.
 * Keep this in sync with the resource boundaries on the worker
 * (one entry per { resource × verb }) and with the frontend
 * permission registry.
 *
 * Special key "*" → grants every permission. Reserved for the
 * Owner role.
 */
export interface PermissionDef {
  key: string;
  resource: string;
  verb: "read" | "create" | "write" | "manage";
  label: string;
  description: string;
}

export const PERMISSIONS: PermissionDef[] = [
  // Operational tabs
  { key: "service_cases.read",   resource: "Service Cases", verb: "read",   label: "View service cases",   description: "See the ASSR / Service Cases tab" },
  { key: "service_cases.create", resource: "Service Cases", verb: "create", label: "Log service cases",     description: "Create a case (but not edit it afterward — for sales who only log complaints)" },
  { key: "service_cases.write",  resource: "Service Cases", verb: "write",  label: "Edit service cases",   description: "Create and update ASSR cases" },
  { key: "service_cases.manage", resource: "Service Cases", verb: "manage", label: "Manage service cases", description: "Triage, assign, schedule logistics for ASSR cases" },
  /* DECLARED 2026-08-13. `routes/assr.ts:2773` has gated POST /:id/approve on
     this key all along, and it was absent from this array — so PERMISSION_KEYS
     never contained it, it could not appear in the roles matrix, and
     requirePermission admitted only holders of the literal string or `*`. In
     practice: cost approval was accidentally Owner/IT-only, and no amount of
     clicking in Team > Positions could change that.

     Declaring it is a ZERO behaviour change today — everyone who could approve
     still can — but the gate becomes grantable instead of silently absolute.
     Its only other declaration was in the dead D1 tree
     (db/migrations/014_qms_roles.sql:40). */
  { key: "service_cases.approve", resource: "Service Cases", verb: "manage", label: "Approve service cost", description: "Approve the quoted cost on an ASSR case (POST /api/assr/:id/approve)" },
  { key: "logs.read",     resource: "Activity Log", verb: "read", label: "View activity log", description: "See the system execution log" },

  // Fleet Maintenance & Compliance (Phase 1) — the lorry master, compliance
  // vault and Fleet Health dashboard (/api/fleet-maintenance). Read is the
  // dashboard + reminders; write covers adding/editing vehicles and appending
  // compliance-document renewals. Owner + IT Admin cover both via "*".
  { key: "fleet.read",  resource: "Fleet Maintenance", verb: "read",  label: "View Fleet Health",   description: "See the Fleet Health dashboard, lorry compliance vault and expiry reminders" },
  { key: "fleet.write", resource: "Fleet Maintenance", verb: "write", label: "Manage fleet vehicles", description: "Add and edit lorries, set out-of-service, and append compliance-document renewals" },

  // Projects (exhibitions, solo events)
  { key: "projects.read",    resource: "Projects", verb: "read",   label: "View projects",     description: "See the Projects tab and open project detail pages" },
  { key: "projects.chat",    resource: "Projects", verb: "write",  label: "Post project chat", description: "Post messages and mark notifications read on projects you can see, without editing project config" },
  { key: "projects.checklist.tick", resource: "Projects", verb: "write", label: "Tick checklist items", description: "Flip the status of (non-gated) checklist items, without editing project config" },
  { key: "projects.write",   resource: "Projects", verb: "write",  label: "Edit projects",     description: "Create and update projects, checklist items, finance" },
  { key: "projects.approve", resource: "Projects", verb: "manage", label: "Approve gated steps", description: "Tick permission-gated checklist items (e.g. 3D final approval)" },
  { key: "stock_transfer.approve", resource: "Projects", verb: "manage", label: "Approve stock OUT transfers", description: "Approve the Stock Out Transfer Record checklist step (owner rule 2026-07-21: HQ + Peter + Kingsley only)" },
  // Owner 2026-07-21: Stock IN got its own key (it used to share
  // projects.approve with the 3D final approval) so its approver set can be
  // narrower — HQ + Peter only.
  { key: "stock_in.approve", resource: "Projects", verb: "manage", label: "Approve stock IN transfers", description: "Approve the Stock In Transfer Record checklist step (owner rule 2026-07-21: HQ + Peter only)" },
  { key: "agreement.approve", resource: "Projects", verb: "manage", label: "Approve agreements", description: "Tick the Agreement / Quotation checklist step (director approval gate)" },
  { key: "projects.manage",  resource: "Projects", verb: "manage", label: "Manage projects",   description: "Archive, change stage, edit templates, backfill CSV" },
  // Granular finance-view (owner 2026-07-23): grants a non-director role the
  // money figures (rental / sales / profit) + the Finances page, WITHOUT the
  // full DIRECTOR tier. Read by pmsAccess.isFinanceViewer. Given to the BD role.
  { key: "projects.finance.view", resource: "Projects", verb: "read", label: "View project finances", description: "See project money figures (rental / sales / profit) and the Finances page without being a director" },

  // Sales entries — rep-facing sales log that later pushes to AutoCount
  { key: "sales.read",   resource: "Sales Entries", verb: "read",   label: "View sales entries",   description: "See the Sales tab; scoped users see only their own entries" },
  { key: "sales.write",  resource: "Sales Entries", verb: "write",  label: "Edit sales entries",   description: "Create and edit own draft sales entries, submit for review" },
  { key: "sales.manage", resource: "Sales Entries", verb: "manage", label: "Manage sales entries", description: "Edit any entry, configure fields, void entries, push to AutoCount" },

  // Supply Chain — ported 2990's furniture SCM (/api/scm). Single coarse
  // gate: holding scm.access (or "*") unlocks every SCM module. Owner +
  // IT Admin already cover it via "*"; this lets non-admin roles in too.
  { key: "scm.access", resource: "Supply Chain", verb: "read", label: "Access Supply Chain", description: "See and use the Supply Chain (furniture SCM) modules" },
  // Granular SCM write gates — replace the inherited 2990 staff_role checks
  // (which trivially pass in Houzs because the SCM bridge pins every caller
  // to one super_admin row). Owner + IT Admin already cover all four via "*";
  // grant individual positions later via the Team > Positions matrix.
  { key: "scm.config.write",        resource: "Supply Chain", verb: "write",  label: "Edit SCM master data",         description: "Edit SCM master data: products, sofa combos, delivery fees, fabric library + tier add-ons, PWP rules, sofa quick picks, special add-ons, Maintenance config, category hero images" },
  { key: "scm.so.price_override",   resource: "Supply Chain", verb: "manage", label: "Override SO line unit price",  description: "Hand-override the unit price on a SCM Sales Order line (audited, admin-level)" },
  { key: "scm.so.view_all",         resource: "Supply Chain", verb: "read",   label: "View all salespersons' SOs",   description: "View every salesperson's My-Orders board (bypass per-rep attribution scoping)" },
  { key: "scm.so.attribute_other",  resource: "Supply Chain", verb: "manage", label: "Attribute SO to another rep",  description: "Create or edit a SCM Sales Order on behalf of another salesperson (stamp a different salesperson_id)" },
  // Port of 2990 gate #717 — clearing an already-set Processing Date pulls the
  // SO back out of the Proceed lane (and, once the day has elapsed, undoes the
  // lock that says "this is what we PO to the supplier"). 2990 restricts it to
  // super_admin; Houzs has no live staff_role (the SCM bridge pins every caller
  // to one super_admin row), so gate on this admin-level key instead. Owner + IT
  // Admin cover it via "*"; grant other positions via the Team > Positions matrix.
  { key: "scm.so.remove_processing_date", resource: "Supply Chain", verb: "manage", label: "Remove SO Processing Date", description: "Clear an already-set Processing Date on a SCM Sales Order (admin-level; pulls the order back out of the Proceed lane)" },
  // SO amendment / revision workflow — TWO-LANE model (owner rework 2026-07-27).
  // A processing-locked SO changes only through an amendment; at submit the
  // request is auto-classified (and, when mixed, SPLIT) into two independent
  // lanes, each with ONE approver signature that applies immediately:
  //   LINES    (product lines: SKU/spec, colour, qty, price, add/remove; the
  //             apply auto-raises a follow-up PO Amendment for purchasing to
  //             confirm)                                  -> approve_lines
  //   DELIVERY (schedule dates, State/Postcode/City — and later the address /
  //             disposal / transport-charge fields; never touches a PO)
  //                                                       -> approve_delivery
  // Owner + IT Admin cover all via "*". The Purchaser / Logistic role grants
  // ride migration 0214 (the Roles UI refuses system-role edits).
  { key: "scm.amendment.create",           resource: "Supply Chain", verb: "manage", label: "Raise SO amendment",          description: "Raise an amendment request against a processing-locked SCM Sales Order (salespeople are additionally admitted for their OWN orders by org field)" },
  { key: "scm.amendment.approve_lines",    resource: "Supply Chain", verb: "manage", label: "Approve SO amendment — product lines", description: "Approve (or reject) the PRODUCT-LINE lane of an SO amendment: SKU/spec, colour/fabric, quantity, price, added/removed lines. Approving applies the SO revision at once and auto-raises the follow-up PO Amendment for purchasing to confirm" },
  { key: "scm.amendment.approve_delivery", resource: "Supply Chain", verb: "manage", label: "Approve SO amendment — delivery",      description: "Approve (or reject) the DELIVERY lane of an SO amendment: schedule dates, State/Postcode/City (and the delivery-info fields as they come under control). Applies the SO revision at once; never touches a Purchase Order" },
  // LEGACY keys — gate only pre-rework amendments still mid-chain (lane IS NULL:
  // supplier-confirm / approve-so / approve-po / send). Not granted to any role;
  // Owner + IT Admin pass via "*". Kept so historical rows stay operable.
  { key: "scm.amendment.supplier_confirm", resource: "Supply Chain", verb: "manage", label: "Confirm SO amendment (supplier) — legacy", description: "LEGACY flow only: record the supplier's confirmation on a pre-rework amendment (REQUESTED -> SUPPLIER_PENDING)" },
  { key: "scm.amendment.approve_so",       resource: "Supply Chain", verb: "manage", label: "Approve SO revision — legacy",         description: "LEGACY flow only: approve the Sales Order revision of a pre-rework amendment (SUPPLIER_PENDING -> SO_APPROVED)" },
  { key: "scm.amendment.approve_po",       resource: "Supply Chain", verb: "manage", label: "Approve/send/reject PO revision — legacy", description: "LEGACY flow only: approve the bound PO revision, mark it sent, or reject a pre-rework amendment (SO_APPROVED -> PO_APPROVED -> SENT, or -> REJECTED)" },
  // PO amendment / revision workflow (Houzs, mig 0192). A standalone amendment
  // that revises a Purchase Order directly (line qty / cost / spec / delivery,
  // add or remove a line, or the header supplier / delivery / notes) through a
  // SIMPLIFIED single-approver gate: REQUESTED -> APPROVED (approve APPLIES the
  // change), or REQUESTED -> REJECTED (reject / withdraw). No supplier-confirm,
  // no two-gate, no send. Owner + IT Admin cover all via "*"; grant purchasing
  // positions via the Team > Positions matrix. po_amendment.approve also gates reject.
  { key: "scm.po_amendment.create",  resource: "Supply Chain", verb: "manage", label: "Raise PO amendment",   description: "Raise an amendment request against a Purchase Order (opens the single-approver PO revision flow)" },
  { key: "scm.po_amendment.approve", resource: "Supply Chain", verb: "manage", label: "Approve/reject PO amendment", description: "Approve a Purchase Order amendment — snapshots the prior version, applies the line + header diffs, bumps the PO revision (REQUESTED -> APPROVED) — or reject it (-> REJECTED)" },

  // Payment Vouchers — standalone AP cash-out document (port of 2990 0189/0202,
  // Phase 1-B MYR). A PV pays a vendor that is NOT a goods invoice (freight
  // forwarder, one-off service) and posts a balanced JE to the GL; a
  // SUPPLIER_PAYMENT PV can also settle one or more Purchase Invoices at face
  // value. Reading the list rides the coarse scm.access + the scm.finance area
  // guard; these flat keys gate the write transitions against the REAL caller
  // (2990's scm.staff.role gates are dead — the SCM bridge pins every caller to
  // one super_admin row). Owner + IT Admin cover all via "*"; grant finance /
  // purchasing positions via the Team > Positions matrix.
  { key: "scm.payment_voucher.create", resource: "Supply Chain", verb: "write",  label: "Create payment voucher",  description: "Create a draft Payment Voucher (pay a non-goods vendor: freight forwarder, one-off service)" },
  { key: "scm.payment_voucher.write",  resource: "Supply Chain", verb: "write",  label: "Edit payment voucher",    description: "Edit a DRAFT Payment Voucher (payee, accounts, lines, PI settlement allocations)" },
  { key: "scm.payment_voucher.post",   resource: "Supply Chain", verb: "manage", label: "Post payment voucher",     description: "Post a Payment Voucher to the General Ledger (DRAFT -> POSTED; settles any linked PIs)" },
  { key: "scm.payment_voucher.cancel", resource: "Supply Chain", verb: "manage", label: "Cancel payment voucher",   description: "Cancel a Payment Voucher (reverses the GL entry + any PI settlement)" },

  // Stock take supervision (owner-approved phase 1, 2026-08-08). A stock take
  // carries an ASSIGNEE (scm.stock_takes.assignee_staff_id — the person
  // responsible for the count); posting is allowed only for that assignee OR a
  // holder of this key. The key additionally gates the two supervisor-only
  // moves: posting a count whose variance exceeds the configured threshold
  // (|qty delta| or line value — see scm/shared/stock-take-threshold.ts), and
  // seeing SYSTEM QTY / VARIANCE on a BLIND take while it is still OPEN.
  // Normal wildcard semantics (NOT in EXPLICIT_APPROVAL_KEYS): Owner + IT
  // Admin pass via "*"; grant warehouse leads via Team > Positions.
  { key: "scm.stock_take.supervise", resource: "Supply Chain", verb: "manage", label: "Supervise stock takes", description: "Post any stock take (not only ones assigned to you), post counts whose variance exceeds the threshold, and reveal system quantities on blind counts" },

  // Currency master — the owner-maintained list of currencies + each one's
  // rate_to_myr (multi-currency FX, migration 0082). Reading the list is open to
  // any authed SCM caller (the GRN/PI/PV currency dropdowns need it); this flat
  // key gates create/edit of a currency + its rate. Owner + IT Admin cover it via
  // "*"; grant finance / purchasing positions via the Team > Positions matrix.
  { key: "scm.currency.manage",        resource: "Supply Chain", verb: "manage", label: "Manage currencies",        description: "Add or edit a currency in the master and set its exchange rate to MYR (used by GRN / PI / Payment Voucher foreign-currency posting)" },

  // HR / Commission (port of 2990 0171 + apps/api/src/routes/hr.ts). Computes
  // commission-only salaries: per-salesperson goods -> % rate + KPI bonuses ->
  // payout. 2990 gates reads on staff.role admin|super_admin|sales_director and
  // writes on admin|super_admin; those gates are DEAD in Houzs (the SCM bridge
  // pins every /api/scm/* caller to one super_admin staff row), so these two
  // flat keys gate the REAL caller instead — the read/write SPLIT is 2990's own
  // (a sales director may see the numbers, not set the rates).
  //
  // These are NEW keys rather than a reuse, deliberately. /hr/commission returns
  // every colleague's SALARY — the most sensitive read in the SCM surface — so
  // it must not ride the coarse scm.access umbrella (see the "READ-ONLY IS NOT
  // THE SAME AS SAFE" incident on scm/index.ts, where reports rode the umbrella
  // and leaked company-wide cost + margin to any Sales Executive). Nor does it
  // borrow canViewScmFinance: that answers "may this caller see cost/margin on a
  // DOCUMENT", and quietly aliasing payroll onto it would mean any later change
  // to the finance tier silently re-permissions salaries.
  //
  // Owner + IT Admin cover both via "*", so the module works on day one; every
  // other position must be granted explicitly via Team > Positions. Payroll
  // failing closed by default is the intended behaviour.
  { key: "scm.hr.read",   resource: "Supply Chain", verb: "read",   label: "View HR commission",   description: "See the HR module: every salesperson's commission, KPI bonuses, salary profiles and the rate settings (read-only)" },
  { key: "scm.hr.manage", resource: "Supply Chain", verb: "manage", label: "Manage HR commission", description: "Set the commission rates and KPI thresholds, assign salesperson tiers/showrooms, and flag item KPIs — changes what people are paid" },
  // Closing a period FREEZES that period's payout against later rate edits, and
  // reopening un-freezes an already-approved figure. They are separate keys and
  // separate from scm.hr.manage on purpose: whoever tunes the rates should not
  // thereby be able to approve a payroll run, and whoever approves one should
  // not thereby be able to reverse an approval nobody else witnessed. Owner + IT
  // Admin hold both via "*" — grant either explicitly and sparingly.
  { key: "scm.hr.close",  resource: "Supply Chain", verb: "manage", label: "Close HR payout period", description: "Freeze a commission period so later rate changes cannot alter what it pays — the payroll approval step" },
  { key: "scm.hr.reopen", resource: "Supply Chain", verb: "manage", label: "Reopen HR payout period", description: "Un-freeze a closed commission period so it recomputes again — reverses an approved payout and is always recorded with a reason" },

  // AutoCount write-back queue (scm.autocount_outbox, mig 0277) — the READ of
  // what the ERP has told the licensed account book and what came back. It is a
  // narrow key rather than a reuse of scm.access because the queue names every
  // document the company pushed and quotes AutoCount's own refusals, and because
  // the owner wanted to be able to hand somebody this page WITHOUT handing them
  // settings.manage, which is the other key the route accepts (whoever may edit
  // the sync connection may obviously read the queue it feeds, and that grant
  // already exists — a key nobody holds is an endpoint nobody can call).
  // Owner + IT Admin cover it via "*".
  { key: "scm.autocount.read", resource: "Supply Chain", verb: "read", label: "View AutoCount sync queue", description: "See every document the ERP pushed to AutoCount, its state (queued / sent / failed / skipped) and the reason it failed or was skipped" },
  /* DECLARED 2026-08-16, when the page grew a per-row "Send again" button.
     The read key above used to end "Read-only: re-sending stays in
     requeue-autocount-skipped.yml"; it does not any more, and the two are
     deliberately SEPARATE keys rather than one. Reading the queue is watching;
     re-sending WRITES A DOCUMENT INTO A LIVE LICENSED ACCOUNT BOOK, where an
     accepted sales order cannot simply be deleted. Whoever is handed the page
     to watch must not thereby be able to push into the book — the same split
     scm.hr.close / scm.hr.reopen is drawn on one section up. The route also
     accepts settings.manage, which already exists and already owns the AutoCount
     connection, so the button works for its real audience on day one. */
  { key: "scm.autocount.requeue", resource: "Supply Chain", verb: "manage", label: "Re-send a refused AutoCount document", description: "Put one failed or skipped document back in the AutoCount queue once its cause is fixed — writes into the live account book, and is refused outright for a document AutoCount has already accepted" },

  // Mail Center — in-ERP shared inbox (/api/mail-center). mail_center.read is the
  // nav/page gate (grant broadly); mail_center.manage gates the alias / access /
  // scope-level admin grids. Owner + IT Admin cover both via "*". Per-thread
  // read/reply/star/label/trash are NOT permission-gated — they gate on mailbox
  // SCOPE ownership (see getMailScope) so an unseeded permission can't 403 a
  // mailbox owner.
  { key: "mail_center.read",   resource: "Mail Center", verb: "read",   label: "View Mail Center", description: "See the Mail Center inbox and work the mailboxes in your scope" },
  { key: "mail_center.manage", resource: "Mail Center", verb: "manage", label: "Manage Mail Center", description: "Create/assign email aliases, the shared-mailbox access matrix, and per-user visibility levels" },

  // Announcements — office posts every logged-in user sees as a top-of-screen
  // banner. announcements.read gates the list page + read-receipt visibility;
  // announcements.write gates create / edit / hide / remind / delete. The
  // banner GET + per-user ack POST live OUTSIDE the permission gate (every
  // authed user can see + ack their own banner). Owner + IT Admin bypass via "*".
  { key: "announcements.read",  resource: "Announcements", verb: "read",  label: "View announcements",  description: "Open the Announcements list page and see read-receipts" },
  { key: "announcements.write", resource: "Announcements", verb: "write", label: "Manage announcements", description: "Post, edit, hide, remind, and delete announcements" },

  // System
  { key: "udf.manage", resource: "Custom Fields", verb: "manage", label: "Manage custom fields", description: "Add or remove user-defined fields on tables" },
  { key: "settings.manage", resource: "Settings", verb: "manage", label: "Manage settings", description: "Edit connection and sync configuration" },

  // Team & roles
  { key: "users.read",   resource: "Team",  verb: "read",   label: "View team",   description: "See team members and pending invitations" },
  { key: "users.manage", resource: "Team",  verb: "manage", label: "Manage team", description: "Invite, change role, disable, or remove users" },
  { key: "roles.read",   resource: "Roles", verb: "read",   label: "View roles",  description: "See the list of roles and their permissions" },
  { key: "roles.manage", resource: "Roles", verb: "manage", label: "Manage roles", description: "Create, edit, and delete custom roles" },
];

const PERMISSION_KEYS = new Set(PERMISSIONS.map((p) => p.key));

export function isValidPermission(key: string): boolean {
  return key === "*" || PERMISSION_KEYS.has(key);
}

/**
 * Decide if a granted permission set covers a required permission.
 * "*" wildcards grant everything. Accepts either a string array
 * (legacy / test fixtures) or a Set (the fast path used by every
 * authed request — populated by `services/auth.ts::hydrateAuthUser`).
 */
/**
 * Owner approval matrix (2026-07-21): the checklist APPROVAL keys are granted
 * EXPLICITLY only — the `*` wildcard does NOT confer them. Admins / the
 * developer / anyone whose position injects `*` must not silently become an
 * approver; the Owner role carries the keys explicitly instead. Any other
 * required_perm keeps normal wildcard semantics.
 */
export const EXPLICIT_APPROVAL_KEYS: ReadonlySet<string> = new Set([
  "agreement.approve",
  "stock_transfer.approve",
  "stock_in.approve",
  "projects.approve",
]);

export function holdsChecklistApproval(
  granted: ReadonlyArray<string> | ReadonlySet<string>,
  required: string,
): boolean {
  const holdsKey = Array.isArray(granted)
    ? granted.includes(required)
    : (granted as ReadonlySet<string>).has(required);
  if (EXPLICIT_APPROVAL_KEYS.has(required)) return holdsKey;
  return holdsKey || hasPermission(granted, "*");
}

export function hasPermission(
  granted: ReadonlyArray<string> | ReadonlySet<string>,
  required: string,
): boolean {
  if (Array.isArray(granted)) {
    return granted.includes("*") || granted.includes(required);
  }
  // Narrowed to ReadonlySet<string> in the else branch — assert to
  // satisfy TS's union-narrowing limitation here.
  const set = granted as ReadonlySet<string>;
  return set.has("*") || set.has(required);
}

export function parsePermissions(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is string => typeof x === "string" && isValidPermission(x));
  } catch {
    return [];
  }
}
