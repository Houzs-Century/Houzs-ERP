#!/usr/bin/env node
// ---------------------------------------------------------------------------
// backfill-so-header-branding.mjs — fill a Sales Order HEADER branding that is
// a placeholder (NULL / blank / NONE ...) with the brand the SO list already
// SHOWS for that order.
//
// OWNER, 2026-09-14: 「没有品牌的，你可以补到品牌吗？」 — yes, fill them.
//
// WHY. The SO list prints `header branding || label derived from the first line`
// (MfgSalesOrdersListV2.tsx / MobileSalesOrders.tsx `brandOf`), so an order whose
// header says NONE still shows ZANOTTI. The Branding FILTER (PR #3830) and the
// free-text search read the HEADER column, so those orders cannot be found by
// the brand the screen shows them under.
//
// THE VALUE IS THE LIST'S OWN, IMPORTED — NOT A COPY OF ITS RULE:
//   isPlaceholderBrandText  src/scm/shared/so-branding-label.ts   (which headers)
//   deriveListFirstItemBranding  src/scm/lib/so-list-first-item-branding.ts
//                                (the list handler's first_item_* — the handler
//                                 calls this same function since this PR)
//   brandingLabel  src/scm/shared/so-branding-label.ts          (the label)
// Lines are read exactly as the handler reads them: live lines, ordered by
// (doc_no, line_no ASC NULLS LAST, created_at ASC); the catalogue is this
// company's mfg_products.
//
// ONLY A BRAND THE OWNER MAINTAINS IS WRITTEN. The label can be a CATEGORY noun
// ("Accessory", "Mattress", "Other", "No Items") that is not a brand at all, and
// the header column is the AutoCount BRANDING UDF on write-back and is audited
// against project_brands by check-branding-vocabulary.mjs (owner 2026-08-18).
// So a label is written only when it is a member of the company's ACTIVE
// project_brands — exactly, or case-insensitively, in which case the LIST'S
// spelling in project_brands is written ("Bedframe" -> "BEDFRAME" for Houzs).
// Anything else is LEFT AS IT IS and listed with the label and why. Never guessed.
//
// SIDE EFFECTS, printed in the plan so nobody has to read this to know them:
//   · this UPDATE queues NO AutoCount edit — nothing here calls enqueueEdit, and
//     the plan lists every trigger on scm.mfg_sales_orders from pg_trigger so
//     that claim is read off the live database, not this comment. The NEXT save
//     of such an order republishes its header, and AutoCount's BRANDING then
//     receives the brand instead of NONE.
//   · trg_vp_outbox_so fires on UPDATE OF branding and queues one Venture Portal
//     outbox row per order; the drain only delivers while scm.venture_portal_feed
//     is on. The plan prints that flag.
//
// MODE=plan (default) reads inside a READ ONLY transaction and writes nothing.
// MODE=apply requires CONFIRM=backfill-so-header-branding, writes inside ONE
// transaction guarded on the value the plan read (a header changed since is
// refused, the whole apply rolls back), then re-reads on a FRESH connection
// and asserts the SHAPE: every written header equals its planned brand, is not
// a placeholder, is an exact member of project_brands, and a fresh plan finds
// 0 pending with the identical not-derivable set.
//
// COMPANY=HOUZS | 2990 (required). Company-scoped on every statement.
//
// RE-RUN: idempotent. A filled header is no longer a placeholder, so a second
// run reports 0 pending and lists only the orders it cannot derive.
//
// Run under tsx (TS imports): npx tsx scripts/backfill-so-header-branding.mjs
// ---------------------------------------------------------------------------
import postgres from "postgres";
import { brandingLabel, isPlaceholderBrandText } from "../src/scm/shared/so-branding-label.ts";
import { brandForHeader, deriveListFirstItemBranding } from "../src/scm/lib/so-list-first-item-branding.ts";
import { normCategory } from "../src/scm/lib/so-readiness.ts";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("need DATABASE_URL"); process.exit(2); }
const MODE = (process.env.MODE ?? "plan").toLowerCase();
const APPLY = MODE === "apply";
const CONFIRM_PHRASE = "backfill-so-header-branding";
if (MODE !== "plan" && MODE !== "apply") { console.error(`MODE must be plan or apply, got ${MODE}`); process.exit(2); }
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply requires CONFIRM=${CONFIRM_PHRASE} — refusing to write.`);
  process.exit(2);
}
const COMPANY = String(process.env.COMPANY ?? "").trim().toUpperCase();
if (COMPANY !== "HOUZS" && COMPANY !== "2990") { console.error("COMPANY must be HOUZS or 2990"); process.exit(2); }

const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const out = (m) => console.log(m);
const tidy = (v) => String(v ?? "").trim();
const shown = (v) => (v == null ? "(null)" : tidy(v) === "" ? "(blank)" : JSON.stringify(v));

async function buildPlan(sql) {
  const [co] = await sql`SELECT id, code FROM companies WHERE upper(code) = ${COMPANY}`;
  if (!co) throw new Error(`company ${COMPANY} not found — refusing to run`);
  const cid = Number(co.id);
  const companyCode = tidy(co.code).toUpperCase();

  const vocab = (await sql`
    SELECT name FROM project_brands WHERE company_id = ${cid} AND active = 1 ORDER BY name`).map((b) => tidy(b.name));
  if (vocab.length === 0) throw new Error(`no active project_brands for ${companyCode} — refusing to run`);

  const heads = await sql`
    SELECT doc_no, branding, status, linked_ac_docno, created_at, so_date::text AS so_date
    FROM scm.mfg_sales_orders WHERE company_id = ${cid} ORDER BY doc_no`;
  if (heads.length === 0) throw new Error(`company ${companyCode} has no sales orders — a plan over nothing is not a verdict`);
  const targets = heads.filter((h) => isPlaceholderBrandText(h.branding));
  const docs = targets.map((h) => h.doc_no);

  const lines = docs.length === 0 ? [] : await sql`
    SELECT doc_no, item_group, branding, item_code
    FROM scm.mfg_sales_order_items
    WHERE company_id = ${cid} AND cancelled = false AND doc_no = ANY(${docs})
    ORDER BY doc_no, line_no ASC NULLS LAST, created_at ASC`;
  /* The list handler reads lines by doc_no alone. A line under one of these doc
     numbers carrying ANOTHER company's id would make the two disagree; count it
     rather than assume it away. */
  const [{ n: foreignLines }] = docs.length === 0 ? [{ n: 0 }] : await sql`
    SELECT count(*)::int AS n FROM scm.mfg_sales_order_items
    WHERE doc_no = ANY(${docs}) AND company_id <> ${cid} AND cancelled = false`;

  const codes = [...new Set(lines.map((l) => l.item_code).filter(Boolean))];
  const prods = codes.length === 0 ? [] : await sql`
    SELECT code, category::text AS category, branding
    FROM scm.mfg_products WHERE company_id = ${cid} AND code = ANY(${codes})`;
  const productCategory = new Map();
  const productBranding = new Map();
  for (const p of prods) {
    if (p.category) productCategory.set(p.code, normCategory(p.category));
    if (p.branding && p.branding.trim()) productBranding.set(p.code, p.branding);
  }

  const first = deriveListFirstItemBranding(lines, productCategory, productBranding);
  const writes = [];
  const unfilled = [];
  for (const h of targets) {
    const f = first.get(h.doc_no);
    const label = brandingLabel(f?.category ?? null, f?.branding ?? null, companyCode);
    const to = brandForHeader(label, vocab);
    const row = { doc_no: h.doc_no, before: h.branding, label, status: h.status, ac: h.linked_ac_docno, created_at: h.created_at, so_date: h.so_date, category: f?.category ?? null };
    if (to) writes.push({ ...row, to, caseOnly: to !== label });
    else unfilled.push({ ...row, why: f ? `the list shows "${label}", which is not a brand in ${companyCode}'s project_brands` : 'no live line — the list shows "No Items"' });
  }

  const triggers = await sql`
    SELECT t.tgname AS name, pg_get_triggerdef(t.oid) AS def
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'scm' AND c.relname = 'mfg_sales_orders' AND NOT t.tgisinternal ORDER BY 1`;
  const flags = await sql`
    SELECT key, value FROM scm.app_config WHERE key IN ('scm.venture_portal_feed', 'scm.autocount_writeback') ORDER BY key`;

  /* WHERE THE PLACEHOLDER CAME FROM. linked_ac_docno is set on BOTH kinds: the
     AutoCount number (SO-013099) on an imported order, and the order's own
     number on an ERP-created one the write-back pushed. */
  const imported = (h) => !!tidy(h.linked_ac_docno) && tidy(h.linked_ac_docno) !== h.doc_no;
  const linesByDoc = new Map();
  for (const l of lines) { if (!linesByDoc.has(l.doc_no)) linesByDoc.set(l.doc_no, []); linesByDoc.get(l.doc_no).push(l); }
  const erpDetail = targets.filter((h) => !imported(h)).map((h) => ({
    doc_no: h.doc_no, before: h.branding, created_at: h.created_at,
    lines: (linesByDoc.get(h.doc_no) ?? []).map((l) => `${l.item_code ?? "(no code)"} [${l.item_group ?? ""}; sku ${productCategory.get(l.item_code) ?? "?"} / ${shown(productBranding.get(l.item_code) ?? null)}]`),
  }));

  /* Venture Portal reach. The URL and secret are never read out — only whether
     both are set, and the date floor the drain applies (vp.since). */
  const vp = await sql`
    SELECT max(v) FILTER (WHERE k = 'vp.since') AS since,
           count(*) FILTER (WHERE k IN ('vp.url', 'vp.secret') AND coalesce(trim(v), '') <> '')::int AS wired
    FROM scm.sync_config WHERE k IN ('vp.since', 'vp.url', 'vp.secret')`;
  const vpSince = tidy(vp[0]?.since) || null;
  const vpWired = Number(vp[0]?.wired ?? 0) === 2;
  /* Has the portal already been sent each order? A re-delivery of an order it
     holds is an ordinary update; a first delivery of an order it never had is
     a new record in somebody's commission input. */
  const writeDocs = writes.map((w) => w.doc_no);
  const vpRows = writeDocs.length === 0 ? [] : await sql`
    SELECT doc_no, bool_or(status = 'sent') AS sent, bool_or(status = 'pending') AS pending,
           bool_or(status = 'skipped') AS skipped, bool_or(status = 'failed') AS failed
    FROM scm.venture_portal_outbox WHERE doc_no = ANY(${writeDocs}) GROUP BY doc_no`;
  const vpByDoc = new Map(vpRows.map((r) => [r.doc_no, r]));
  for (const w of writes) {
    const r = vpByDoc.get(w.doc_no);
    w.vp = !r ? "never queued" : r.sent ? "already sent" : r.pending ? "pending" : r.failed ? "failed" : "skipped";
  }

  return { cid, companyCode, vocab, headCount: heads.length, targets, imported, erpDetail, lines: lines.length, foreignLines, writes, unfilled, triggers, flags, vpSince, vpWired };
}

function report(p) {
  log(`company ${p.companyCode} (company_id=${p.cid})   MODE=${MODE}`);
  out(`brand vocabulary (${p.vocab.length}): ${p.vocab.join(" | ")}`);
  const byBefore = new Map();
  for (const t of p.targets) byBefore.set(shown(t.branding), (byBefore.get(shown(t.branding)) ?? 0) + 1);
  log(`sales orders: ${p.headCount}; header branding is a placeholder on ${p.targets.length} (${[...byBefore].map(([k, n]) => `${k} x${n}`).join(", ") || "none"})`);
  const imp = p.targets.filter(p.imported);
  const impBy = new Map();
  for (const t of imp) impBy.set(shown(t.branding), (impBy.get(shown(t.branding)) ?? 0) + 1);
  log(`  imported from AutoCount (linked_ac_docno is an AutoCount number): ${imp.length} (${[...impBy].map(([k, n]) => `${k} x${n}`).join(", ") || "none"}); ERP-created: ${p.targets.length - imp.length}`);
  for (const d of p.erpDetail) out(`  ERP-CREATED	${d.doc_no}	${new Date(d.created_at).toISOString().slice(0, 10)}	header=${shown(d.before)}	lines: ${d.lines.join(" | ") || "(none)"}`);
  const recent = p.targets.filter((t) => Date.now() - new Date(t.created_at).getTime() < 14 * 864e5);
  log(`  created in the last 14 days: ${recent.length}${recent.length ? ` (${recent.map((t) => `${t.doc_no} ${p.imported(t) ? "imported" : "ERP-created"} ${new Date(t.created_at).toISOString().slice(0, 10)} ${shown(t.branding)}`).join("; ")})` : ""}`);
  out(`  live lines read: ${p.lines}; lines under these doc numbers carrying another company's id: ${p.foreignLines}`);

  const byLabel = new Map();
  for (const w of p.writes) byLabel.set(w.to, (byLabel.get(w.to) ?? 0) + 1);
  log(`WILL FILL ${p.writes.length}: ${[...byLabel].map(([k, n]) => `"${k}" x${n}`).join(", ") || "nothing"}`);
  const caseOnly = p.writes.filter((w) => w.caseOnly);
  if (caseOnly.length) log(`  ${caseOnly.length} of them written in project_brands' spelling where the list's label differs only in case (${[...new Set(caseOnly.map((w) => `"${w.label}" -> "${w.to}"`))].join(", ")})`);
  log(`CANNOT DERIVE ${p.unfilled.length} — left as they are:`);
  for (const u of p.unfilled) out(`  UNFILLED\t${u.doc_no}\tstatus=${u.status}\theader=${shown(u.before)}\t${u.why}`);

  out(`\nBEFORE -> AFTER (backup: the value each header holds now)`);
  for (const w of p.writes) out(`  FILL\t${w.doc_no}\t${shown(w.before)}\t->\t"${w.to}"\tstatus=${w.status}\t${w.ac ? `linked_ac_docno=${w.ac}` : "no AutoCount key"}`);

  out(`\ntriggers on scm.mfg_sales_orders (live pg_trigger):`);
  for (const t of p.triggers) out(`  ${t.name}: ${t.def}`);
  const firesOnBrandingUpdate = (def) => {
    if (!/\bUPDATE\b/.test(def)) return false;
    const of = def.match(/UPDATE OF (.*?) ON /);
    return !of || of[1].split(",").map((c) => c.trim()).includes("branding");
  };
  const brandTriggers = p.triggers.filter((t) => firesOnBrandingUpdate(t.def));
  log(`triggers that fire on this UPDATE: ${brandTriggers.map((t) => t.name).join(", ") || "none"}`);
  log(`flags: ${p.flags.map((f) => `${f.key}=${JSON.stringify(f.value)}`).join("  ") || "(neither row present)"}`);
  const vpReach = p.writes.filter((w) => !p.vpSince || (w.so_date && w.so_date >= p.vpSince));
  log(`Venture Portal: receiver wired=${p.vpWired}, vp.since=${p.vpSince ?? "(none)"}; of the ${p.writes.length} fills, ${vpReach.length} are dated on/after vp.since and are re-delivered by the next drain IF the feed flag enables company ${p.cid}; the other ${p.writes.length - vpReach.length} are marked skipped without a request`);
  const vpState = new Map();
  for (const w of vpReach) vpState.set(w.vp, (vpState.get(w.vp) ?? 0) + 1);
  log(`  portal outbox history of those ${vpReach.length}: ${[...vpState].map(([k, n]) => `${k} x${n}`).join(", ") || "none"}`);
  if (vpReach.length) out(`  VP-REACH\t${vpReach.map((w) => `${w.doc_no}(${w.so_date}; ${w.vp})`).join(" ")}`);
}

async function applyPlan(sql, p) {
  await sql.begin(async (tx) => {
    let n = 0;
    for (const w of p.writes) {
      const r = await tx`
        UPDATE scm.mfg_sales_orders SET branding = ${w.to}
        WHERE company_id = ${p.cid} AND doc_no = ${w.doc_no} AND branding IS NOT DISTINCT FROM ${w.before}`;
      if (r.count !== 1) throw new Error(`${w.doc_no}: expected 1 row still holding ${shown(w.before)}, updated ${r.count} — the header moved since the plan; rolled back, nothing written`);
      n += r.count;
    }
    log(`applied: ${n} headers (one transaction)`);
  });
}

async function verify(p) {
  const fresh = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
  try {
    const problems = [];
    const vocab = new Set(p.vocab);
    for (const w of p.writes) {
      const [r] = await fresh`SELECT branding, company_id FROM scm.mfg_sales_orders WHERE doc_no = ${w.doc_no} AND company_id = ${p.cid}`;
      if (!r) { problems.push(`${w.doc_no}: vanished`); continue; }
      if (r.branding !== w.to) problems.push(`${w.doc_no}: holds ${shown(r.branding)}, planned "${w.to}"`);
      if (isPlaceholderBrandText(r.branding)) problems.push(`${w.doc_no}: still a placeholder`);
      if (!vocab.has(r.branding)) problems.push(`${w.doc_no}: "${r.branding}" is not an exact project_brands member`);
    }
    const again = await fresh.begin("read only", (tx) => buildPlan(tx));
    if (again.writes.length !== 0) problems.push(`a fresh plan still finds ${again.writes.length} pending`);
    const was = p.unfilled.map((u) => u.doc_no).sort().join(",");
    const now = again.unfilled.map((u) => u.doc_no).sort().join(",");
    if (was !== now) problems.push(`the not-derivable set changed: planned [${was}] now [${now}]`);
    if (problems.length) {
      problems.forEach((x) => log(`VERIFY FAIL: ${x}`));
      throw new Error(`${problems.length} verification failures`);
    }
    log(`VERIFY OK (fresh connection) — ${p.writes.length} headers hold their planned brand, each an exact project_brands member; a fresh plan finds 0 pending and the same ${again.unfilled.length} not derivable`);
  } finally { await fresh.end(); }
}

const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
try {
  const p = await sql.begin("read only", (tx) => buildPlan(tx));
  report(p);
  if (!APPLY) {
    log(`MODE=plan — nothing written. Re-run with MODE=apply CONFIRM=${CONFIRM_PHRASE} COMPANY=${COMPANY} to write.`);
  } else if (p.writes.length === 0) {
    log("MODE=apply — nothing pending, nothing written.");
  } else {
    await applyPlan(sql, p);
    await verify(p);
  }
} finally { await sql.end(); }
