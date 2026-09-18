// Read-only census: WHO gains (or loses) Service Case access when visibility
// moves from job-title + org-subtree + free-text agent name onto the COMPANY
// grant (owner decision 2026-08-20, docs/SERVICE-CASE-VISIBILITY-DECISION.md).
//
// WHY THIS EXISTS
//
// The decision widens what a Sales user can see, and this repo does not ship an
// access change on reasoning alone. The numbers live only in production, and the
// standing rule forbids pasting a DSN in front of a human for a SELECT — so the
// count runs here, against secrets.DATABASE_URL, and nobody handles the
// credential.
//
// It answers six questions. The third and fourth are the ones that can STOP the
// visibility change; the fifth is a SEPARATE question about the same module,
// added 2026-08-21 because it has the same shape (a rule about who may touch a
// case, whose answer lives only in production) and the same standing constraint
// (never put a DSN in front of a human for a SELECT):
//
//   1. ROUTE ADMITTANCE — how many active users get through /api/assr today
//      (service_cases perm OR isSalesUser OR isDirectorUser) vs after
//      (service_cases perm OR holds the HOUZS company grant OR isDirectorUser).
//   2. ROW VISIBILITY — for every user who is visibility-SCOPED, how many
//      non-archived cases they can see today vs after.
//   3. WHO LOSES ADMITTANCE — a Sales-titled user with no HOUZS grant (e.g. a
//      2990-only rep) is admitted today and would NOT be after. Any non-zero
//      here is a lockout the decision did not ask for.
//   5. THE 2026-07-23 RULING — a Sales rep must not EDIT a case. Only desktop
//      enforces it; mobile mounts the full editable screen. Do reps actually
//      hold `service_cases.write`? YES = a live authorisation hole on the phone;
//      NO = a screen of buttons that all 403. Different bug, different urgency.
//   4. WHO LOSES CASES — the free-text `sales_agent` match is dropped, so a case
//      whose agent TEXT matches a subtree member but whose ERP salesperson is
//      someone else stops being visible. Only possible on ERP-sourced orders;
//      AutoCount-sourced ones become company-open and can only gain.
//   6. MY CASES BY CREATOR — added 2026-08-21 for the owner's ruling that a case
//      a person RAISED is theirs regardless of the agent field. Measures whether
//      `created_by` is populated enough to key the list on, and how many
//      user->case pairs would be lost if the free-text name arm were REPLACED
//      rather than unioned. Same shape, same constraint as the others.
//
// READING, NOT A SETTING. SELECTs only — no DDL, no writes, no transaction.
// Exits 0 for every legitimate answer (the ANSWER is the output; a red job reads
// as "the check broke"). Only an unreachable DB / query error exits non-zero.
//
// RE-RUN: idempotent. It writes nothing, so a second run just re-reads.
import { readFileSync } from "node:fs";
import postgres from "postgres";

// Same resolution order as pg-migrate.mjs: env wins so CI needs no .dev.vars.
function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}

const url = resolveUrl();
if (!url) {
  console.error("DATABASE_URL not set (env var or .dev.vars). Aborting.");
  process.exit(1);
}

const out = [];
const say = (msg) => {
  out.push(msg);
  console.log(msg);
};
const notice = (msg) =>
  console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);

// ── The classifiers, mirrored from the backend ───────────────────────────────
// Each one names the module it mirrors. They are re-stated here rather than
// imported because this script is a dependency-free .mjs running against raw
// rows, not through the Hono context the real gates read. Keep in lockstep:
// a divergence here reports a number about a system we do not run.

/** services/pmsAccess.ts normalisePosition */
const normPos = (n) => (n ?? "").toLowerCase().replace(/\s+/g, " ").trim();
/** services/pmsAccess.ts DIRECTOR_POSITION_NAMES */
const DIRECTOR_POSITIONS = new Set(
  ["Super Admin", "Sales Director", "Finance Manager"].map(normPos),
);
/** services/positionPolicy.ts GOD_POSITIONS */
const GOD_POSITIONS = new Set(["Super Admin", "Owner"].map(normPos));
/** services/pmsAccess.ts SALES_POSITION */
const SALES_POSITION = /^sales/i;

/** services/permissions.ts parsePermissions + services/auth.ts hydrateAuthUser
 *  (position => '*'). Returns the effective permission Set. */
function effectivePermissions(rolePermissionsJson, positionName) {
  let arr = [];
  try {
    const parsed = JSON.parse(rolePermissionsJson ?? "[]");
    if (Array.isArray(parsed)) arr = parsed.filter((x) => typeof x === "string");
  } catch {
    arr = [];
  }
  const set = new Set(arr);
  if (!set.has("*") && GOD_POSITIONS.has(normPos(positionName))) set.add("*");
  return set;
}

const hasPerm = (set, key) => set.has("*") || set.has(key);
/** services/pmsAccess.ts isSalesUser */
const isSalesUser = (u) =>
  SALES_POSITION.test((u.position_name ?? "").trim()) ||
  (u.department_name ?? "").trim().toLowerCase().includes("sales");
/** services/pmsAccess.ts isDirectorUser */
const isDirectorUser = (u) =>
  u.perms.has("*") || DIRECTOR_POSITIONS.has(normPos(u.position_name));
/** frontend/src/auth/salesAccess.ts isSalesStaff — department FIRST, position
 *  prefix as the fallback. NOT the same test as `isSalesUser` above (that one
 *  is a substring on department); this one is the predicate the DESKTOP route
 *  guard actually reads, so the ruling census must mirror IT. */
const isSalesStaffFe = (u) =>
  (u.department_name ?? "").toLowerCase().includes("sales") ||
  SALES_POSITION.test((u.position_name ?? "").trim());
/** frontend/src/auth/salesAccess.ts isSalesNonDirector — the ONE predicate the
 *  2026-07-23 ruling is enforced with on desktop (App.tsx
 *  SalesRepCaseDetailRoute). `isDirectorUser` here mirrors the server-resolved
 *  `org.director` capability the frontend reads. */
const isSalesNonDirectorFe = (u) => isSalesStaffFe(u) && !isDirectorUser(u);
/** services/assrVisibility.ts assrUnrestricted */
const assrUnrestricted = (u) =>
  hasPerm(u.perms, "*") || hasPerm(u.perms, "service_cases.manage") || isDirectorUser(u);

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

try {
  // ── Masters ────────────────────────────────────────────────────────────────
  const companies = await pg`
    SELECT id, code FROM public.companies WHERE is_active = 1 ORDER BY id`;
  const activeCompanyIds = companies.map((r) => Number(r.id));
  const houzsId = companies.find((r) => String(r.code) === "HOUZS")?.id;
  const multiCompany = companies.length > 1;

  const userRows = await pg`
    SELECT u.id, u.name, u.status, u.manager_id,
           r.permissions AS role_permissions,
           r.name        AS role_name,
           p.name        AS position_name,
           d.name        AS department_name
      FROM public.users u
      JOIN public.roles r        ON r.id = u.role_id
      LEFT JOIN public.positions p   ON p.id = u.position_id
      LEFT JOIN public.departments d ON d.id = u.department_id`;

  const grantRows = await pg`
    SELECT user_id, company_id FROM public.user_companies`;
  const grantsByUser = new Map();
  for (const g of grantRows) {
    const uid = Number(g.user_id);
    if (!grantsByUser.has(uid)) grantsByUser.set(uid, []);
    grantsByUser.get(uid).push(Number(g.company_id));
  }

  const users = userRows.map((u) => ({
    id: Number(u.id),
    name: (u.name ?? "").trim(),
    status: u.status,
    manager_id: u.manager_id == null ? null : Number(u.manager_id),
    role_name: (u.role_name ?? "").trim(),
    position_name: u.position_name,
    department_name: u.department_name,
    perms: effectivePermissions(u.role_permissions, u.position_name),
  }));
  const byId = new Map(users.map((u) => [u.id, u]));
  const activeUsers = users.filter((u) => u.status === "active");

  // middleware/companyContext.ts: pre-activation (<=1 company) the grant table
  // is never consulted and allowedCompanyIds stays UNSET (undefined). With
  // multi-company live, >=1 grant narrows to the granted ∩ active set and ZERO
  // grants fails CLOSED to []. `undefined` is returned as null here.
  function allowedCompanies(u) {
    if (!multiCompany) return null; // unresolved -> no predicate
    const granted = grantsByUser.get(u.id) ?? [];
    if (granted.length === 0) return []; // fail closed (§6.1)
    const set = new Set(granted);
    return activeCompanyIds.filter((id) => set.has(id));
  }
  /** The gate SHIPPED on 2026-08-20: holds the HOUZS company grant. `undefined`
   *  (unresolved company context) degrades to the legacy single-company yes. */
  function holdsHouzsGrant(u) {
    const allowed = allowedCompanies(u);
    if (allowed === null) return true;
    if (houzsId == null) return false;
    return allowed.includes(Number(houzsId));
  }
  /** The gate the CURRENT change installs: holds ANY company grant. The ruling
   *  replaced a job TITLE with a company GRANT; the HOUZS literal that shipped
   *  with it is narrower than the rule, which is the cohort §1 below already
   *  named in advance. */
  function holdsAnyGrant(u) {
    const allowed = allowedCompanies(u);
    if (allowed === null) return true;
    return allowed.length > 0;
  }

  // ── Reporting subtree (services/orgScope.ts subtreeUserIds) ────────────────
  const childrenOf = new Map();
  for (const u of users) {
    if (u.manager_id == null) continue;
    if (!childrenOf.has(u.manager_id)) childrenOf.set(u.manager_id, []);
    childrenOf.get(u.manager_id).push(u.id);
  }
  const MAX_CHAIN_DEPTH = 10;
  function subtree(rootId) {
    const seen = new Set([rootId]);
    let frontier = [rootId];
    for (let d = 0; d < MAX_CHAIN_DEPTH && frontier.length; d++) {
      const next = [];
      for (const id of frontier) {
        for (const kid of childrenOf.get(id) ?? []) {
          if (!seen.has(kid)) {
            seen.add(kid);
            next.push(kid);
          }
        }
      }
      frontier = next;
    }
    return seen;
  }

  // ── Cases + the ERP-order binding ─────────────────────────────────────────
  const cases = await pg`
    SELECT id, doc_no, created_by, assigned_to, assigned_to_2, sales_agent,
           company_id, archived_at
      FROM public.assr_cases`;

  // ERP-native orders: doc_no -> the salesperson resolved to a public.users id
  // via scm.staff.user_id (mig 0066). This is the "real binding" the decision
  // says to scope on. Cancelled/draft orders are excluded exactly as
  // services/assr.ts fetchScmSoContext excludes them.
  const erpRows = await pg`
    SELECT LOWER(o.doc_no) AS doc_key, sp.user_id
      FROM scm."mfg_sales_orders" o
      LEFT JOIN scm.staff sp ON sp.id = o.salesperson_id
     WHERE o.status <> 'DRAFT' AND o.status <> 'CANCELLED'`;
  const erpSalespersonByDoc = new Map();
  for (const r of erpRows) {
    // First writer wins only when it carries a user; a later row with a real
    // salesperson must not be masked by an earlier NULL.
    const key = r.doc_key;
    const uid = r.user_id == null ? null : Number(r.user_id);
    if (!erpSalespersonByDoc.has(key) || erpSalespersonByDoc.get(key) == null) {
      erpSalespersonByDoc.set(key, uid);
    }
  }

  const liveCases = cases.filter((c) => c.archived_at == null);
  const docKey = (c) => (c.doc_no ?? "").trim().toLowerCase();
  const isErpSourced = (c) => {
    const k = docKey(c);
    return k !== "" && erpSalespersonByDoc.has(k);
  };

  // ── §0 Shape of the data behind the decision ──────────────────────────────
  const erpCases = liveCases.filter(isErpSourced).length;
  const nonErpCases = liveCases.length - erpCases;
  const noDoc = liveCases.filter((c) => docKey(c) === "").length;
  const erpNoSalesperson = liveCases.filter(
    (c) => isErpSourced(c) && erpSalespersonByDoc.get(docKey(c)) == null,
  ).length;

  say("== §0  Case population ==");
  say(`companies(active)=${companies.length} houzs_company_id=${houzsId ?? "UNRESOLVED"}`);
  say(`assr_cases total=${cases.length} non_archived=${liveCases.length}`);
  say(
    `  ERP-sourced (doc resolves in scm.mfg_sales_orders) = ${erpCases}` +
      `  |  AutoCount-sourced or unresolvable = ${nonErpCases} (of which no doc_no = ${noDoc})`,
  );
  say(
    `  ERP-sourced cases whose order has NO resolvable salesperson user = ${erpNoSalesperson}` +
      ` (these stay visible only via created_by / assigned_to)`,
  );

  // ── §1 + §3 Route admittance ──────────────────────────────────────────────
  const admitToday = [];
  const admitAfter = [];
  for (const u of activeUsers) {
    const permOk = hasPerm(u.perms, "service_cases.read");
    /* TODAY is what production runs: the 2026-08-20 HOUZS literal. AFTER is the
       current change, ANY company grant. The isSalesUser comparison this
       section shipped with is history — it measured the 2026-08-20 change and
       would now report a difference nobody is proposing. */
    const today = permOk || holdsHouzsGrant(u) || isDirectorUser(u);
    const after = permOk || holdsAnyGrant(u) || isDirectorUser(u);
    if (today) admitToday.push(u);
    if (after) admitAfter.push(u);
  }
  const admitTodaySet = new Set(admitToday.map((u) => u.id));
  const admitAfterSet = new Set(admitAfter.map((u) => u.id));
  const gainedAdmit = admitAfter.filter((u) => !admitTodaySet.has(u.id));
  const lostAdmit = admitToday.filter((u) => !admitAfterSet.has(u.id));

  say("");
  say("== §1  Route admittance (GET /api/assr) ==");
  say(`active users = ${activeUsers.length}`);
  say(`admitted today = ${admitToday.length}   admitted after = ${admitAfter.length}`);
  say(`GAINED admittance = ${gainedAdmit.length}`);
  for (const u of gainedAdmit) {
    say(`   + #${u.id} ${u.name} [pos=${u.position_name ?? "-"} dept=${u.department_name ?? "-"}]`);
  }
  say(`LOST admittance = ${lostAdmit.length}${lostAdmit.length ? "   <-- BLOCKER, see §3" : ""}`);
  for (const u of lostAdmit) {
    const allowed = allowedCompanies(u);
    say(
      `   - #${u.id} ${u.name} [pos=${u.position_name ?? "-"} dept=${u.department_name ?? "-"}]` +
        ` granted_companies=${allowed === null ? "unresolved" : JSON.stringify(allowed)}`,
    );
  }

  /* THE COHORT THIS SECTION NAMED IN ADVANCE AND THE LITERAL SHIPPED ANYWAY.
     Now widened from "Sales-titled" to EVERY active user holding a grant with
     no HOUZS in it — the title is not the point and never was. These are the
     people the current change admits. */
  const noHouzsGrant = activeUsers.filter((u) => !holdsHouzsGrant(u) && holdsAnyGrant(u));
  say(
    `active users holding a grant but NOT the HOUZS one = ${noHouzsGrant.length}` +
      ` (the cohort the literal rule stranded)`,
  );
  for (const u of noHouzsGrant) {
    say(`   · #${u.id} ${u.name} granted=${JSON.stringify(allowedCompanies(u))}` +
        ` [pos=${u.position_name ?? "-"} dept=${u.department_name ?? "-"}]`);
  }

  // ── §2 + §4 Row visibility ────────────────────────────────────────────────
  // Only SCOPED callers change: assrUnrestricted keeps seeing everything, which
  // the decision requires ("要不然 office 的帮不到 sales 处理东西了").
  const scoped = admitAfter.filter((u) => !assrUnrestricted(u));

  let usersGaining = 0;
  let usersLosing = 0;
  let usersZeroToSome = 0;
  let totalGained = 0;
  let totalLost = 0;
  let maxGained = 0;
  const losers = [];

  for (const u of scoped) {
    const sub = subtree(u.id);
    const subNames = [...sub]
      .map((id) => (byId.get(id)?.name ?? "").trim().toLowerCase())
      .filter(Boolean);
    const allowed = allowedCompanies(u);
    const inCompany = (c) => {
      if (allowed === null) return true; // unresolved -> no predicate
      const co = c.company_id == null ? NaN : Number(c.company_id);
      if (!Number.isFinite(co)) return true; // NULL company_id is not excluded
      return allowed.includes(co);
    };
    const idMatch = (c) =>
      (c.created_by != null && sub.has(Number(c.created_by))) ||
      (c.assigned_to != null && sub.has(Number(c.assigned_to))) ||
      (c.assigned_to_2 != null && sub.has(Number(c.assigned_to_2)));

    let today = 0;
    let after = 0;
    let lost = 0;
    for (const c of liveCases) {
      if (!inCompany(c)) continue;
      const agent = (c.sales_agent ?? "").trim().toLowerCase();
      const nameMatch = agent !== "" && subNames.some((n) => agent.includes(n));
      const visibleToday = idMatch(c) || nameMatch;

      let visibleAfter;
      if (idMatch(c)) {
        visibleAfter = true;
      } else if (!isErpSourced(c)) {
        visibleAfter = true; // AutoCount-sourced -> company-open
      } else {
        const spUser = erpSalespersonByDoc.get(docKey(c));
        visibleAfter = spUser != null && sub.has(spUser);
      }

      if (visibleToday) today++;
      if (visibleAfter) after++;
      if (visibleToday && !visibleAfter) lost++;
    }

    const delta = after - today;
    if (delta > 0) usersGaining++;
    if (lost > 0) {
      usersLosing++;
      losers.push({ u, lost, today, after });
    }
    if (today === 0 && after > 0) usersZeroToSome++;
    totalGained += Math.max(0, delta);
    totalLost += lost;
    if (delta > maxGained) maxGained = delta;
  }

  say("");
  say("== §2  Row visibility for VISIBILITY-SCOPED users (non-archived cases) ==");
  say(`scoped users in scope of this change = ${scoped.length}`);
  say(`users who GAIN at least one case = ${usersGaining}   (largest single gain = ${maxGained})`);
  say(`users who go from ZERO visible cases to some = ${usersZeroToSome}  <-- the reported outage`);
  say(`total user->case visibility grants ADDED = ${totalGained}`);
  say("");
  say("== §4  Cases a scoped user LOSES (dropped free-text sales_agent match) ==");
  say(`users losing at least one case = ${usersLosing}   total user->case pairs lost = ${totalLost}`);
  for (const l of losers) {
    say(
      `   - #${l.u.id} ${l.u.name}: today=${l.today} after=${l.after} lost=${l.lost}` +
        ` (ERP-sourced cases matched only by agent TEXT, whose order salesperson is someone else)`,
    );
  }

  // -- 5 THE 2026-07-23 RULING -----------------------------------------------
  // Owner: "sales agent 不应该有 edit case 功能". Desktop enforces it by
  // redirecting a non-director Sales rep off the editable /assr/:id. The BACKEND
  // never enforced it -- every write route is requirePermission("service_cases.write"),
  // a flat matrix key that knows nothing about the Sales cohort.
  //
  // So there are exactly two possible live states and they need different fixes:
  //   HOLE   - reps DO hold the key -> the phone is performing unauthorised
  //            edits today, and desktop's redirect is the only thing that has
  //            ever stopped them.
  //   BUTTONS- reps do NOT hold it -> every mobile control 403s; a broken
  //            screen, not an access breach.
  // Reading which, not setting it. A rep with no row here IS the finding.
  const reps = activeUsers.filter(isSalesNonDirectorFe);
  const repsWithWrite = reps.filter((u) => hasPerm(u.perms, "service_cases.write"));
  const repsWithManage = reps.filter((u) => hasPerm(u.perms, "service_cases.manage"));
  // Which ROLE carries the grant — a permission change is made on the role, so
  // name it rather than only counting people.
  const byRole = new Map();
  for (const u of repsWithWrite) {
    const key = u.role_name || "(unnamed role)";
    if (!byRole.has(key)) byRole.set(key, []);
    byRole.get(key).push(u);
  }

  say("");
  say("== §5  The 2026-07-23 ruling: can a Sales rep WRITE a service case? ==");
  say(`active non-director Sales staff (frontend isSalesNonDirector) = ${reps.length}`);
  for (const u of reps) {
    const keys = [
      hasPerm(u.perms, "*") ? "*" : null,
      u.perms.has("service_cases.read") ? "read" : null,
      u.perms.has("service_cases.write") ? "write" : null,
      u.perms.has("service_cases.manage") ? "manage" : null,
    ].filter(Boolean);
    say(
      `   · #${u.id} ${u.name} [role=${u.role_name || "-"} pos=${u.position_name ?? "-"}` +
        ` dept=${u.department_name ?? "-"}] service_cases keys=${keys.length ? keys.join(",") : "NONE"}`,
    );
  }
  say(`reps holding service_cases.write  = ${repsWithWrite.length}`);
  say(`reps holding service_cases.manage = ${repsWithManage.length}`);
  for (const [role, us] of byRole) {
    say(`   ! role "${role}" grants service_cases.write to ${us.length} rep(s): ${us.map((u) => u.name).join(", ")}`);
  }
  const ruling =
    reps.length === 0
      ? "NO REPS: no active non-director Sales staff exist, so neither failure mode is live today. The mobile gate is still required before one is hired."
      : repsWithWrite.length > 0
        ? `LIVE AUTHORISATION HOLE: ${repsWithWrite.length} of ${reps.length} rep(s) hold service_cases.write, so the mobile Service screen is performing edits the owner forbade on 2026-07-23. Desktop's redirect is the ONLY enforcement that has ever existed.`
        : `BROKEN BUTTONS: 0 of ${reps.length} rep(s) hold service_cases.write, so every mobile stage/advance/close/archive control 403s. No unauthorised edit is possible; the defect is a screen of dead buttons.`;
  say(ruling);

  // -- 6 MY CASES: creator vs free-text agent name (owner ruling 2026-08-21) ----
  // Owner: 「如果是他开的 就算不是他as agent它也可以看啊 ... 那就是他submit就代表
  // 他认领这个case了啊」 — a case a person RAISED is theirs, agent field or not,
  // because AutoCount's agent data is unreliable and AutoCount-sourced orders are
  // open to every Houzs staff member to raise a case on. So submitting IS
  // claiming.
  //
  // GET /api/assr/my-cases today keys ONLY on `LOWER(sales_agent) LIKE
  // '%<subtree member name>%'` — the same free-text mechanism the ACCESS gate
  // already moved off (2 above). This section measures, BEFORE the change:
  //   a. how many cases even HAVE a created_by to key on;
  //   b. how many are reachable ONLY by the name arm (i.e. would vanish if the
  //      name arm were replaced rather than unioned) — the number that decides
  //      whether the name arm has to stay;
  //   c. how many user->case pairs the creator arm ADDS.
  // READING, NOT A SETTING. A zero here is an answer, never something to fix.
  const withCreator = liveCases.filter((c) => c.created_by != null).length;
  const withAgentText = liveCases.filter(
    (c) => (c.sales_agent ?? "").trim() !== "",
  ).length;
  const agentOnly = liveCases.filter(
    (c) => c.created_by == null && (c.sales_agent ?? "").trim() !== "",
  ).length;
  const neither = liveCases.filter(
    (c) => c.created_by == null && (c.sales_agent ?? "").trim() === "",
  ).length;
  // The cohort the ruling is ABOUT: someone raised it, and the agent text names
  // a different person (or nobody). Today these are invisible in the creator's
  // My Cases.
  const creatorNotAgent = liveCases.filter((c) => {
    if (c.created_by == null) return false;
    const agent = (c.sales_agent ?? "").trim().toLowerCase();
    const creator = (byId.get(Number(c.created_by))?.name ?? "").trim().toLowerCase();
    if (creator === "") return true; // creator not resolvable to a name at all
    return agent === "" || !agent.includes(creator);
  }).length;

  // Company split — the HC transaction data was wiped on 2026-08-21, so a
  // population that is entirely one company must SAY so: it bounds what the
  // measurement proves.
  const byCompany = new Map();
  for (const c of liveCases) {
    const key = c.company_id == null ? "NULL" : String(c.company_id);
    byCompany.set(key, (byCompany.get(key) ?? 0) + 1);
  }
  const codeById = new Map(companies.map((r) => [String(r.id), String(r.code)]));

  say("");
  say("== §6  My Cases: creator vs free-text agent name (ruling 2026-08-21) ==");
  say(`non-archived cases = ${liveCases.length}`);
  say(`  created_by NOT NULL                       = ${withCreator}`);
  say(`  sales_agent non-empty                     = ${withAgentText}`);
  say(`  created_by NULL but sales_agent non-empty = ${agentOnly}  <-- reachable ONLY by the name arm`);
  say(`  neither created_by nor sales_agent        = ${neither}  (unreachable by either arm)`);
  say(`  raised by someone the agent TEXT does not name = ${creatorNotAgent}  <-- what the ruling makes visible`);
  say(
    `  by company: ` +
      [...byCompany.entries()]
        .map(([id, n]) => `${codeById.get(id) ?? `company_id=${id}`}:${n}`)
        .join("  "),
  );

  // Per-user My Cases delta. The audience is every ACTIVE user the route gate
  // admits (canAccessServiceCases) — my-cases has no visibility tier of its own,
  // it is a self-scoped list, so an unrestricted director is measured too.
  let myGained = 0;
  let myLostIfReplaced = 0;
  let usersMyGaining = 0;
  const usersMyLosing = [];
  for (const u of admitAfter) {
    const sub = subtree(u.id);
    const subNames = [...sub]
      .map((id) => (byId.get(id)?.name ?? "").trim().toLowerCase())
      .filter(Boolean);
    const allowed = allowedCompanies(u);
    const inCompany = (c) => {
      if (allowed === null) return true;
      const co = c.company_id == null ? NaN : Number(c.company_id);
      if (!Number.isFinite(co)) return true;
      return allowed.includes(co);
    };
    let today = 0;
    let creatorArm = 0;
    let lost = 0;
    let gained = 0;
    for (const c of liveCases) {
      if (!inCompany(c)) continue;
      const agent = (c.sales_agent ?? "").trim().toLowerCase();
      const nameHit = agent !== "" && subNames.some((n) => agent.includes(n));
      const creatorHit = c.created_by != null && sub.has(Number(c.created_by));
      if (nameHit) today++;
      if (creatorHit) creatorArm++;
      if (nameHit && !creatorHit) lost++; // lost ONLY if the name arm is REPLACED
      if (creatorHit && !nameHit) gained++;
    }
    myGained += gained;
    myLostIfReplaced += lost;
    if (gained > 0) usersMyGaining++;
    if (lost > 0) usersMyLosing.push({ u, lost, today, creatorArm });
  }

  say("");
  say(`my-cases audience (route-admitted active users) = ${admitAfter.length}`);
  say(`user->case pairs the CREATOR arm ADDS = ${myGained}   (users gaining = ${usersMyGaining})`);
  say(
    `user->case pairs that would be LOST if the name arm were REPLACED = ${myLostIfReplaced}` +
      `   (users affected = ${usersMyLosing.length})`,
  );
  for (const l of usersMyLosing) {
    say(
      `   - #${l.u.id} ${l.u.name}: name_arm=${l.today} creator_arm=${l.creatorArm} lost_if_replaced=${l.lost}`,
    );
  }
  const myCasesVerdict =
    myLostIfReplaced === 0
      ? `NAME ARM DROPPABLE: 0 user->case pairs are reachable only by the free-text name, so keying My Cases on created_by + downline ids loses nothing.`
      : `KEEP THE NAME ARM: ${myLostIfReplaced} user->case pair(s) across ${usersMyLosing.length} user(s) are reachable ONLY by the free-text agent name. Union, never replace.`;
  say(myCasesVerdict);

  const verdict =
    lostAdmit.length === 0 && totalLost === 0
      ? `SAFE: +${gainedAdmit.length} users admitted, +${totalGained} case grants, 0 admittance lost, 0 cases lost.`
      : `REVIEW: ${lostAdmit.length} users would LOSE admittance and ${totalLost} user->case pairs would be lost. Do not ship without an owner ruling.`;
  say("");
  notice(verdict);
  notice(`§5 ruling: ${ruling}`);
  notice(`§6 my-cases: ${myCasesVerdict}`);
  process.exit(0);
} catch (e) {
  console.error(
    `Query failed (DB unreachable or schema drift): ${e instanceof Error ? e.message : String(e)}`,
  );
  process.exit(1);
} finally {
  await pg.end({ timeout: 5 });
}
