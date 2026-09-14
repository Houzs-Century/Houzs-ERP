// check-staff-issues-27-31-32-33 — READ-ONLY. Four staff questions, one run.
//
// 27. "I cannot see the PO Chasing tab" — does scm.v_po_outstanding_lines exist
//     and hold company-1 rows; who resolves `scm.finance.outstanding` (the area
//     key that gates /scm/outstanding in App.tsx and /outstanding/* in
//     scm/index.ts); and what the users named like "Sim" resolve to.
//     The key is a PAGE-ACCESS level, not a flat role permission, so "which
//     roles hold it" is answered the way login answers it (services/auth.ts
//     hydrateAuthUser): `*` -> full; positioned -> resolvePositionPolicy +
//     position_page_overrides; positionless -> role_page_access matrix. The
//     REAL resolver functions are imported from src/, not re-implemented.
// 31. "PO outstanding list only shows POs from 4/9" — company-1 POs in the
//     list's Outstanding bucket (scm/lib/po-status-buckets.ts) split by po_date
//     vs 2026-09-04, how many of the older ones are migrated (po_number is
//     "HC-" + linked_ac_docno — import-ac-outstanding-po.mjs), and what page 1
//     of the list (default pageSize 50, sort po_date desc, po_number desc) shows.
// 32. The amendments on the named SOs, header + lines, with the lane the
//     classifier (scm/shared/amendment-lane.ts) gives each line TODAY.
// 33. HC4681 — which documents carry that number, SO lines vs DO lines joined on
//     so_item_id, its amendments, and whether the DO is a migrated one.
//
// READ-ONLY. SELECTs only; the session is set READ ONLY. No DDL, no writes.
// Exit 0 for every legitimate answer; non-zero only when the DB is unreachable.
// Prints role / position / department names and user display names only —
// never an email, password hash or token.
//
// RE-RUN: read-only and idempotent — every run re-reads the live rows.
//
// ENUM TRAP: status columns are enums — `::text` before comparing.
//
// Usage: npx tsx scripts/check-staff-issues-27-31-32-33.mjs
//   COMPANY=1 USER_LIKE=sim SPLIT_DATE=2026-09-04 AMEND_SOS="HC-SO-009093,HC-SO-004928" DOC_4681=4681
import postgres from "postgres";
import { resolvePositionPolicy, positionGrantsWildcard } from "../src/services/positionPolicy.ts";
import { loadPageAccessForRole, fullAccessMap } from "../src/services/pageAccess.ts";
import { applyPageOverrides, isValidOverrideKey, isValidOverrideLevel } from "../src/services/positionPageOverrides.ts";
import { applySalesJdOverride, salesJdDenial } from "../src/services/salesJdAccess.ts";
import { parsePermissions } from "../src/services/permissions.ts";
import { classifyLine } from "../src/scm/shared/amendment-lane.ts";
import { PO_STATUS_BUCKETS } from "../src/scm/lib/po-status-buckets.ts";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("DATABASE_URL missing"); process.exit(2); }
const COMPANY = Number(process.env.COMPANY || 1);
const USER_LIKE = String(process.env.USER_LIKE || "sim");
const SPLIT_DATE = String(process.env.SPLIT_DATE || "2026-09-04");
const AMEND_SOS = String(process.env.AMEND_SOS || "HC-SO-009093,HC-SO-004928").split(",").map((s) => s.trim()).filter(Boolean);
const DOC_4681 = String(process.env.DOC_4681 || "4681").trim();
const AREA = "scm.finance.outstanding";

const GH = !!process.env.GITHUB_ACTIONS;
const notice = (m) => console.log(GH ? `::notice::${m}` : m);
const warn = (m) => console.log(GH ? `::warning::${m}` : `WARNING: ${m}`);
const say = (m = "") => console.log(m);
const pad = (s, n) => String(s ?? "").slice(0, n).padEnd(n);
const j = (v) => (v == null ? "∅" : typeof v === "string" ? v : JSON.stringify(v));
const section = (t) => { say(""); say("=".repeat(100)); notice(t); say("=".repeat(100)); };

const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1, idle_timeout: 20, connect_timeout: 60 });

/* env.DB shim for the one loader that takes a D1-shaped env (pageAccess.ts
   loadPageAccessForRole): prepare(sql).bind(...).all() over postgres, `?` -> $n. */
const envShim = {
  DB: {
    prepare(q) {
      let i = 0;
      const text = q.replace(/\?/g, () => `$${++i}`);
      let args = [];
      const api = {
        bind(...a) { args = a; return api; },
        async all() { return { results: await sql.unsafe(text, args) }; },
        async first() { return (await sql.unsafe(text, args))[0] ?? null; },
      };
      return api;
    },
  },
};

async function cols(schema, table) {
  const r = await sql`SELECT column_name FROM information_schema.columns WHERE table_schema = ${schema} AND table_name = ${table}`;
  return new Set(r.map((x) => x.column_name));
}

/* ── 27 ─────────────────────────────────────────────────────────────────── */
async function resolveUser(u, overridesByPos) {
  const permissions = parsePermissions(u.role_permissions);
  const set = new Set(permissions);
  if (!set.has("*") && positionGrantsWildcard(u.position_name ?? null)) { permissions.push("*"); set.add("*"); }
  const meta = { explicitScm: false };
  let pageAccess; let source; let cohort = "-";
  if (set.has("*")) { pageAccess = fullAccessMap(); source = "wildcard *"; }
  else if (u.position_id != null) {
    const pol = resolvePositionPolicy({ position_name: u.position_name ?? null, department_name: u.department_name ?? null });
    pageAccess = pol.pageAccess; meta.explicitScm = pol.scmConfigured; cohort = pol.cohort; source = "position policy";
  } else {
    pageAccess = await loadPageAccessForRole(envShim, u.role_id, set, meta); source = "role matrix (positionless)";
  }
  const overrides = (u.position_id != null && !set.has("*")) ? (overridesByPos.get(u.position_id) ?? []) : [];
  const finalMap = applyPageOverrides(
    applySalesJdOverride(pageAccess, { permissions: set, position_name: u.position_name ?? null, department_name: u.department_name ?? null }),
    overrides,
  );
  const l2 = meta.explicitScm || overrides.length > 0;
  const level = finalMap[AREA] ?? "none";
  const jd = salesJdDenial({ permissions, permissions_set: set, position_name: u.position_name ?? null, department_name: u.department_name ?? null }, AREA);
  const scmAccess = set.has("*") || set.has("scm.access");
  // FE: <Guard perm="scm.access" anyAccess={[area]}> passes on either; BE GET: `*` ok; JD deny 403;
  // not L2-configured -> falls through (umbrella); L2-configured -> needs >= view.
  const feOpens = scmAccess || level !== "none";
  const beRead = set.has("*") ? true : jd ? false : !l2 ? true : level !== "none";
  return { source, cohort, level, l2, scmAccess, jd, feOpens, beRead, overrides: overrides.filter((o) => o.page_key.startsWith("scm")) };
}

async function q27() {
  section(`27. PO Chasing tab — view, ${AREA} holders, users like '%${USER_LIKE}%'`);
  const [mig] = await sql`SELECT count(*)::int AS n FROM _pg_migrations WHERE filename LIKE '20260912T1000%'`;
  const [reg] = await sql`SELECT to_regclass('scm.v_po_outstanding_lines')::text AS reg`;
  say(`migration 20260912T1000_scm_po_outstanding_lines_view applied rows: ${mig.n}`);
  say(`to_regclass('scm.v_po_outstanding_lines') = ${reg.reg ?? "NULL (view does NOT exist)"}`);
  if (reg.reg) {
    const [c] = await sql`
      SELECT count(*)::int AS all_rows,
             count(*) FILTER (WHERE is_outstanding)::int AS outstanding,
             count(*) FILTER (WHERE is_outstanding AND po_date >= (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date - 365)::int AS outstanding_last_365d,
             (min(po_date) FILTER (WHERE is_outstanding))::text AS oldest, (max(po_date) FILTER (WHERE is_outstanding))::text AS newest
        FROM scm.v_po_outstanding_lines WHERE company_id = ${COMPANY}`;
    say(`company ${COMPANY}: rows=${c.all_rows} outstanding=${c.outstanding} outstanding_in_default_365d_window=${c.outstanding_last_365d} po_date ${c.oldest}..${c.newest}`);
    const g = await sql`SELECT grantee, privilege_type FROM information_schema.role_table_grants WHERE table_schema='scm' AND table_name='v_po_outstanding_lines'`;
    say(`grants: ${g.map((x) => `${x.grantee}:${x.privilege_type}`).join(", ") || "(none visible)"}`);
  }

  const overrideRows = await sql`SELECT position_id, page_key, level FROM position_page_overrides ORDER BY position_id, page_key`;
  const overridesByPos = new Map();
  for (const o of overrideRows) {
    if (!isValidOverrideKey(o.page_key) || !isValidOverrideLevel(o.level)) continue;
    if (!overridesByPos.has(o.position_id)) overridesByPos.set(o.position_id, []);
    overridesByPos.get(o.position_id).push({ page_key: o.page_key, level: o.level });
  }

  say("");
  say(`-- ROLES (as a POSITIONLESS user on that role resolves it — role_page_access matrix + backfill) --`);
  const roles = await sql`SELECT r.id, r.name, r.permissions,
      (SELECT count(*)::int FROM users u WHERE u.role_id = r.id AND u.status = 'active') AS active_users
    FROM roles r ORDER BY r.id`;
  const rpa = await sql`SELECT role_id, page_key, level FROM role_page_access WHERE page_key IN ('scm', 'scm.finance', ${AREA}) ORDER BY role_id, page_key`;
  say(`  ${pad("role", 28)} ${pad("users", 6)} ${pad("*", 2)} ${pad("scm.access", 11)} ${pad("level", 8)} explicit rows (scm / scm.finance / ${AREA})`);
  for (const r of roles) {
    const u = { role_id: r.id, role_permissions: r.permissions, position_id: null, position_name: null, department_name: null };
    const res = await resolveUser(u, overridesByPos);
    const perms = new Set(parsePermissions(r.permissions));
    const rows = rpa.filter((x) => x.role_id === r.id).map((x) => `${x.page_key}=${x.level}`).join(" ") || "-";
    say(`  ${pad(r.name, 28)} ${pad(r.active_users, 6)} ${pad(perms.has("*") ? "Y" : "-", 2)} ${pad(perms.has("scm.access") ? "Y" : "-", 11)} ${pad(res.level, 8)} ${rows}`);
  }

  say("");
  say(`-- POSITIONS (positioned users resolve via the position policy + overrides; role matrix is NOT read) --`);
  const positions = await sql`SELECT p.id, p.name, d.name AS department_name,
      (SELECT count(*)::int FROM users u WHERE u.position_id = p.id AND u.status = 'active') AS active_users
    FROM positions p LEFT JOIN departments d ON d.id = p.department_id ORDER BY d.name NULLS LAST, p.name`;
  say(`  ${pad("position", 30)} ${pad("department", 18)} ${pad("users", 6)} ${pad("cohort", 11)} ${pad("level", 8)} ${pad("L2cfg", 6)} scm overrides`);
  for (const p of positions) {
    const res = await resolveUser({ role_id: -1, role_permissions: "[]", position_id: p.id, position_name: p.name, department_name: p.department_name }, overridesByPos);
    say(`  ${pad(p.name, 30)} ${pad(p.department_name ?? "-", 18)} ${pad(p.active_users, 6)} ${pad(res.cohort, 11)} ${pad(res.level, 8)} ${pad(res.l2 ? "Y" : "-", 6)} ${res.overrides.map((o) => `${o.page_key}=${o.level}`).join(" ") || "-"}`);
  }
  say("  (position rows above assume a role WITHOUT `*`/scm.access; a user's own role can still add scm.access / `*` — see the per-user block)");

  say("");
  say(`-- USERS with name ILIKE '%${USER_LIKE}%' (display name + org fields only) --`);
  const users = await sql`
    SELECT u.id, u.name, u.status, u.role_id, u.position_id,
           r.name AS role_name, r.permissions AS role_permissions,
           p.name AS position_name, d.name AS department_name
      FROM users u
      JOIN roles r ON r.id = u.role_id
      LEFT JOIN positions p ON p.id = u.position_id
      LEFT JOIN departments d ON d.id = u.department_id
     WHERE u.name ILIKE ${"%" + USER_LIKE + "%"}
     ORDER BY u.status, u.name`;
  if (!users.length) say("  (no user matches)");
  const ucReg = (await sql`SELECT to_regclass('public.user_companies')::text AS r`)[0].r;
  for (const u of users) {
    const res = await resolveUser(u, overridesByPos);
    let companies = "(user_companies absent)";
    if (ucReg) {
      const uc = await sql`SELECT uc.company_id, c.code FROM user_companies uc LEFT JOIN companies c ON c.id = uc.company_id WHERE uc.user_id = ${u.id} ORDER BY uc.company_id`;
      companies = uc.length ? uc.map((x) => `${x.company_id}:${x.code ?? "?"}`).join(",") : "NONE (no grants)";
    }
    say(`  user#${u.id} ${pad(u.name, 24)} status=${u.status} role="${u.role_name}" position="${u.position_name ?? "-"}" dept="${u.department_name ?? "-"}"`);
    say(`      source=${res.source} cohort=${res.cohort} ${AREA}=${res.level} scm_l2_configured=${res.l2} holds scm.access/*=${res.scmAccess} salesJdDenial=${res.jd ? `"${res.jd}"` : "none"} companies=${companies}`);
    say(`      => FRONTEND /scm/outstanding route opens: ${res.feOpens ? "YES" : "NO (Forbidden)"} · BACKEND GET /outstanding/po-lines admitted by area guard: ${res.beRead ? "YES" : "NO (403)"}`);
    if (res.overrides.length) say(`      position scm overrides: ${res.overrides.map((o) => `${o.page_key}=${o.level}`).join(" ")}`);
  }
}

/* ── 31 ─────────────────────────────────────────────────────────────────── */
async function q31() {
  const OUT = PO_STATUS_BUCKETS.outstanding;
  section(`31. PO list Outstanding bucket [${OUT.join(", ")}] — company ${COMPANY}, split at po_date ${SPLIT_DATE}`);
  say(`list page size: PurchaseOrdersListV2 useLocalStorage("scm:perpage:purchase-orders", 50); backend clamps 1..100, default 50; sort po_date desc then po_number desc`);
  const rows = await sql`
    SELECT (po_date < ${SPLIT_DATE}::date) AS older,
           status::text AS status,
           count(*)::int AS n,
           count(*) FILTER (WHERE linked_ac_docno IS NOT NULL AND lower(po_number) LIKE ('%-' || lower(linked_ac_docno)))::int AS migrated_prefixed,
           count(*) FILTER (WHERE linked_ac_docno IS NOT NULL AND lower(po_number) = lower(linked_ac_docno))::int AS written_back_equal,
           count(*) FILTER (WHERE linked_ac_docno IS NULL)::int AS no_book_no,
           min(po_date)::text AS min_d, max(po_date)::text AS max_d
      FROM scm.purchase_orders
     WHERE company_id = ${COMPANY} AND status::text = ANY(${OUT})
     GROUP BY 1, 2 ORDER BY 1 DESC, 2`;
  say(`  ${pad("bucket", 22)} ${pad("status", 20)} ${pad("n", 6)} ${pad("migrated(HC-+book)", 19)} ${pad("wrote-back(=)", 14)} ${pad("no book no", 11)} po_date range`);
  let tot = 0;
  for (const r of rows) {
    tot += r.n;
    say(`  ${pad(r.older ? `po_date < ${SPLIT_DATE}` : `po_date >= ${SPLIT_DATE}`, 22)} ${pad(r.status, 20)} ${pad(r.n, 6)} ${pad(r.migrated_prefixed, 19)} ${pad(r.written_back_equal, 14)} ${pad(r.no_book_no, 11)} ${r.min_d}..${r.max_d}`);
  }
  say(`  TOTAL outstanding-bucket POs company ${COMPANY}: ${tot}`);

  const all = await sql`SELECT status::text AS s, count(*)::int AS n FROM scm.purchase_orders WHERE company_id = ${COMPANY} GROUP BY 1 ORDER BY 1`;
  say(`  all company-${COMPANY} POs by status: ${all.map((x) => `${x.s}=${x.n}`).join(" ")}`);
  const migAll = await sql`
    SELECT status::text AS s, count(*)::int AS n, min(po_date)::text AS min_d, max(po_date)::text AS max_d
      FROM scm.purchase_orders
     WHERE company_id = ${COMPANY} AND linked_ac_docno IS NOT NULL AND lower(po_number) LIKE ('%-' || lower(linked_ac_docno))
     GROUP BY 1 ORDER BY 1`;
  say(`  migrated (HC-+book) company-${COMPANY} POs by status: ${migAll.map((x) => `${x.s}=${x.n} [${x.min_d}..${x.max_d}]`).join(" ") || "none"}`);

  const page1 = await sql`
    SELECT po_number, po_date::text AS d, status::text AS s
      FROM scm.purchase_orders
     WHERE company_id = ${COMPANY} AND status::text = ANY(${OUT})
     ORDER BY po_date DESC, po_number DESC LIMIT 50`;
  if (page1.length) {
    say(`  page 1 (50 rows) of the Outstanding tab spans po_date ${page1[page1.length - 1].d} .. ${page1[0].d}; first ${page1[0].po_number}, last ${page1[page1.length - 1].po_number}`);
    const pages = Math.ceil(tot / 50);
    say(`  => at pageSize 50 the tab has ${pages} page(s); at 100, ${Math.ceil(tot / 100)}`);
  }
  const firstOlder = await sql`
    SELECT count(*)::int AS rank_before FROM scm.purchase_orders
     WHERE company_id = ${COMPANY} AND status::text = ANY(${OUT}) AND po_date >= ${SPLIT_DATE}::date`;
  say(`  the first PO dated before ${SPLIT_DATE} appears at row ${firstOlder[0].rank_before + 1} (page ${Math.floor(firstOlder[0].rank_before / 50) + 1} at 50/page)`);

  const [hv] = await sql`SELECT to_regclass('scm.v_po_outstanding')::text AS r`;
  if (hv.r) {
    const v = await sql`
      SELECT (po_date < ${SPLIT_DATE}::date) AS older, count(*)::int AS n,
             count(*) FILTER (WHERE po_date >= (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date - 365)::int AS in_365
        FROM scm.v_po_outstanding WHERE company_id = ${COMPANY} AND is_outstanding GROUP BY 1 ORDER BY 1 DESC`;
    say(`  (Finance > Outstanding > PO tab, scm.v_po_outstanding is_outstanding, default From = today-365): ${v.map((x) => `${x.older ? "older" : "newer"}=${x.n} (in 365d window ${x.in_365})`).join(" · ")}`);
  }
}

/* ── amendments helper (32 + 33) ────────────────────────────────────────── */
const AMEND_SKIP = new Set(["id", "so_doc_no", "amendment_no", "lane", "status", "reason", "header_changes", "created_at", "old_header_snapshot", "updated_at", "company_id"]);
async function printAmendments(docNo) {
  const ams = await sql`SELECT to_jsonb(a) AS row FROM scm.so_amendments a WHERE a.so_doc_no = ${docNo} ORDER BY a.created_at`;
  if (!ams.length) { say(`  (no SO amendments on ${docNo})`); return; }
  for (const { row: a } of ams) {
    say(`  ▸ ${a.amendment_no}  lane=${a.lane ?? "NULL(legacy)"}  status=${a.status}  created_at=${a.created_at}`);
    say(`      reason: ${j(a.reason)}`);
    say(`      header_changes: ${j(a.header_changes)}`);
    const extra = Object.entries(a).filter(([k, v]) => !AMEND_SKIP.has(k) && v != null && !/_by$/.test(k)).map(([k, v]) => `${k}=${j(v)}`);
    if (extra.length) say(`      other: ${extra.join(" · ").slice(0, 600)}`);
    const lines = await sql`
      SELECT to_jsonb(l) AS l, soi.item_code AS so_code, soi.item_group AS so_group, soi.line_no AS so_line, soi.description AS so_desc
        FROM scm.so_amendment_lines l
        LEFT JOIN scm.mfg_sales_order_items soi ON soi.id = l.sales_order_item_id
       WHERE l.amendment_id = ${a.id}
       ORDER BY soi.line_no NULLS LAST`;
    if (!lines.length) say(`      (no lines — header-only amendment)`);
    for (const r of lines) {
      const l = r.l;
      const oldCode = l.old_snapshot?.item_code ?? l.old_snapshot?.itemCode ?? null;
      const code = r.so_code ?? l.new_item_code ?? oldCode;
      const group = r.so_group ?? l.old_snapshot?.item_group ?? null;
      const laneToday = classifyLine({ itemCode: l.change_type === "ADD" ? l.new_item_code : code, itemGroup: l.change_type === "ADD" ? null : group });
      say(`      - change_type=${l.change_type} SO ln ${r.so_line ?? "∅"} item_code=${code ?? "∅"} item_group=${group ?? "∅"} new_item_code=${l.new_item_code ?? "∅"} new_qty=${l.new_qty ?? "∅"} new_remark=${j(l.new_remark)} -> classifyLine today: ${laneToday}`);
      if (l.new_variants) say(`          new_variants: ${j(l.new_variants).slice(0, 400)}`);
      if (l.old_snapshot) say(`          old_snapshot: ${j(l.old_snapshot).slice(0, 400)}`);
    }
  }
}

/* ── 32 ─────────────────────────────────────────────────────────────────── */
async function q32() {
  section(`32. Amendments on ${AMEND_SOS.join(", ")}`);
  for (const want of AMEND_SOS) {
    const digits = want.replace(/\D/g, "");
    const hits = await sql`
      SELECT doc_no, status::text AS s, linked_ac_docno, company_id FROM scm.mfg_sales_orders
       WHERE doc_no = ${want} OR (company_id = ${COMPANY} AND doc_no LIKE ${"%" + digits})
       ORDER BY (doc_no = ${want}) DESC, doc_no LIMIT 10`;
    say("");
    say(`-- ${want}: matches ${hits.map((h) => `${h.doc_no}[co ${h.company_id}, ${h.s}, book=${h.linked_ac_docno ?? "∅"}]`).join(", ") || "NONE"}`);
    const exact = hits.find((h) => h.doc_no === want) ?? hits[0];
    if (!exact) continue;
    await printAmendments(exact.doc_no);
  }
  const laneCensus = await sql`
    SELECT a.lane, l.change_type, count(*)::int AS n,
           count(*) FILTER (WHERE lower(coalesce(soi.item_group,'')) = 'service')::int AS service_group
      FROM scm.so_amendments a JOIN scm.so_amendment_lines l ON l.amendment_id = a.id
      LEFT JOIN scm.mfg_sales_order_items soi ON soi.id = l.sales_order_item_id
     WHERE a.company_id = ${COMPANY}
     GROUP BY 1, 2 ORDER BY 1 NULLS FIRST, 2`;
  say("");
  say(`-- company ${COMPANY} amendment-line census (lane × change_type): ${laneCensus.map((x) => `${x.lane ?? "NULL"}/${x.change_type}=${x.n}(service ${x.service_group})`).join(" · ")}`);
  const keyCensus = await sql`
    SELECT a.lane, k AS header_key, count(*)::int AS n
      FROM scm.so_amendments a
      CROSS JOIN LATERAL jsonb_object_keys(CASE WHEN jsonb_typeof(a.header_changes) = 'object' THEN a.header_changes ELSE '{}'::jsonb END) k
     WHERE a.company_id = ${COMPANY}
     GROUP BY 1, 2 ORDER BY 1 NULLS FIRST, 2`;
  say(`-- company ${COMPANY} header_changes key census (lane × key): ${keyCensus.map((x) => `${x.lane ?? "NULL"}/${x.header_key}=${x.n}`).join(" · ") || "none"}`);
  const types = await sql`SELECT jsonb_typeof(header_changes) AS t, count(*)::int AS n FROM scm.so_amendments WHERE company_id = ${COMPANY} AND header_changes IS NOT NULL GROUP BY 1`;
  say(`-- header_changes jsonb types: ${types.map((x) => `${x.t}=${x.n}`).join(" ") || "none"}`);
}

/* ── 33 ─────────────────────────────────────────────────────────────────── */
async function q33() {
  section(`33. Documents numbered *${DOC_4681} (company ${COMPANY})`);
  const sos = await sql`SELECT doc_no, status::text AS s, linked_ac_docno, company_id FROM scm.mfg_sales_orders WHERE doc_no LIKE ${"%" + DOC_4681} ORDER BY doc_no`;
  const dos = await sql`SELECT to_jsonb(d) AS d FROM scm.delivery_orders d WHERE d.do_number LIKE ${"%" + DOC_4681} ORDER BY d.do_number`;
  say(`SOs: ${sos.map((x) => `${x.doc_no}[co ${x.company_id}, ${x.s}, book=${x.linked_ac_docno ?? "∅"}]`).join(", ") || "none"}`);
  say(`DOs: ${dos.map(({ d }) => `${d.do_number}[co ${d.company_id}, ${d.status}, so=${d.so_doc_no ?? "∅"}, book=${d.linked_ac_docno ?? "∅"}, migrated_no_stock=${d.migrated_no_stock ?? "(col absent)"}]`).join(", ") || "none"}`);

  const soDocs = new Set(sos.filter((x) => x.company_id === COMPANY).map((x) => x.doc_no));
  for (const { d } of dos) if (d.so_doc_no && d.company_id === COMPANY) soDocs.add(d.so_doc_no);
  const doiCols = await cols("scm", "delivery_order_items");
  say(`delivery_order_items has: linked_ac_dtlkey=${doiCols.has("linked_ac_dtlkey")} ac_substituted=${doiCols.has("ac_substituted")}`);

  for (const soNo of soDocs) {
    say("");
    say(`-- ${soNo}: SO lines vs DO lines (joined on so_item_id) --`);
    const soLines = await sql`
      SELECT i.id, i.line_no, i.item_code, i.item_group, i.description, i.description2, i.variants::text AS v, i.qty, i.linked_ac_dtlkey
        FROM scm.mfg_sales_order_items i WHERE i.doc_no = ${soNo} ORDER BY i.line_no NULLS LAST, i.item_code`;
    const doLines = await sql`
      SELECT d.do_number, d.status::text AS s, d.linked_ac_docno, d.created_at::text AS created, to_jsonb(di) AS di, di.variants::text AS v
        FROM scm.delivery_orders d JOIN scm.delivery_order_items di ON di.delivery_order_id = d.id
       WHERE d.so_doc_no = ${soNo} AND d.company_id = ${COMPANY}
       ORDER BY d.do_number, di.line_no NULLS LAST`;
    const doHdrs = [...new Map(doLines.map((r) => [r.do_number, r])).values()];
    for (const h of doHdrs) {
      const shape = !h.linked_ac_docno ? "no book number (ERP-made)" : h.do_number.toLowerCase() === h.linked_ac_docno.toLowerCase() ? "equal (ERP-made, written back)" : h.do_number.toLowerCase().endsWith("-" + h.linked_ac_docno.toLowerCase()) ? "prefixed (MIGRATED from AutoCount)" : "neither";
      say(`   DO ${h.do_number} status=${h.s} book=${h.linked_ac_docno ?? "∅"} created_at=${h.created} -> number shape: ${shape}`);
    }
    const bySo = new Map();
    for (const r of doLines) { const k = r.di.so_item_id ?? `__nolink__${r.di.id}`; if (!bySo.has(k)) bySo.set(k, []); bySo.get(k).push(r); }
    for (const s of soLines) {
      say(`   SO ln ${s.line_no ?? "∅"} ${s.item_code} [${s.item_group}] qty ${s.qty} dtlkey=${s.linked_ac_dtlkey ?? "∅"}`);
      say(`      SO  desc="${s.description ?? ""}" desc2="${s.description2 ?? ""}" variants=${s.v ?? "∅"}`);
      const ds = bySo.get(s.id) ?? [];
      if (!ds.length) say(`      DO  (no DO line links to this SO line)`);
      for (const r of ds) {
        const di = r.di;
        const diffs = [];
        if (di.item_code !== s.item_code) diffs.push("item_code");
        if ((di.description ?? "") !== (s.description ?? "")) diffs.push("description");
        if ((di.description2 ?? "") !== (s.description2 ?? "")) diffs.push("description2");
        if ((r.v ?? "") !== (s.v ?? "")) diffs.push("variants");
        say(`      DO  ${r.do_number} ln ${di.line_no ?? "∅"} ${di.item_code} qty ${di.qty} desc="${di.description ?? ""}" desc2="${di.description2 ?? ""}" variants=${r.v ?? "∅"}${doiCols.has("linked_ac_dtlkey") ? ` dtlkey=${di.linked_ac_dtlkey ?? "∅"}` : ""}${doiCols.has("ac_substituted") ? ` ac_substituted=${di.ac_substituted}` : ""}`);
        say(`      => ${diffs.length ? `DIFFERS on: ${diffs.join(", ")}` : "identical on item_code/description/description2/variants"}`);
      }
    }
    for (const [k, rs] of bySo) {
      if (soLines.some((s) => s.id === k)) continue;
      for (const r of rs) say(`   UNLINKED/FOREIGN DO line ${r.do_number} ln ${r.di.line_no ?? "∅"} ${r.di.item_code} so_item_id=${r.di.so_item_id ?? "∅"} desc="${r.di.description ?? ""}" desc2="${r.di.description2 ?? ""}" variants=${r.v ?? "∅"}`);
    }
    say(`   amendments on ${soNo}:`);
    await printAmendments(soNo);
    const revs = await sql`SELECT revision, amendment_id IS NOT NULL AS by_amendment, created_at::text AS at FROM scm.so_revisions WHERE so_doc_no = ${soNo} ORDER BY revision`;
    say(`   so_revisions: ${revs.map((r) => `r${r.revision}${r.by_amendment ? "(amend)" : ""}@${r.at}`).join(" ") || "none"}`);
  }
}

async function main() {
  try { await sql`SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`; }
  catch (e) { warn(`could not set the session READ ONLY (${e.message}) — continuing, every statement is a SELECT`); }
  const [ro] = await sql`SELECT current_setting('transaction_read_only') AS ro, now()::text AS at`;
  notice(`=== staff issues 27/31/32/33 — READ-ONLY (transaction_read_only=${ro.ro}) · read at ${ro.at} · company ${COMPANY} ===`);
  for (const [name, fn] of [["27", q27], ["31", q31], ["32", q32], ["33", q33]]) {
    try { await fn(); }
    catch (e) { warn(`section ${name} could not complete: ${e.message}`); }
  }
  await sql.end();
}

try {
  await main();
  process.exit(0);
} catch (e) {
  console.error(`::error::check could not complete: ${e.message}`);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
}
