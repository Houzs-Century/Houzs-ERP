#!/usr/bin/env node
// Re-issue the SOFA PWP (换购) vouchers that were never minted between the 2990
// cutover (2026-07-21) and the #1339 deploy.
//
// WHY: scm's POST /pwp-codes/reserve was ported from the pre-2026-06-20 shape of
// 2990's route — it matched a SOFA trigger only by Combo and hard-returned []
// when the request carried no sofaModules. The live rule is by MODEL
// (trigger_combo_ids = [], 17 sofa Models -> BEDFRAME), so EVERY sofa sold in
// that window earned nothing and the customer never got the voucher. #1339 fixed
// the code going forward; this script pays back the window.
//
// WHAT IT MINTS: one AVAILABLE, customer-bound voucher per reward slot the rule
// would have granted — target = qty_per_trigger x build qty — exactly the row
// the create path leaves behind for an un-applied trigger (status AVAILABLE,
// source_doc_no = the SO, customer_id = the SO's customer, cart_line_key NULL).
//
// SAFETY / SCOPE (deliberately narrow — this WRITES money-bearing rows):
//   · ONLY by-Model SOFA rules. A by-Combo rule always worked (the ported code
//     kept that branch), so re-minting for one would DOUBLE-issue.
//   · ONLY native company-2990 SOs. Mirrored 2990-* docs came from the OLD API,
//     which minted their codes in the 2990 database — they are reported, never
//     minted, because whether to re-home those vouchers is an owner ruling.
//   · ONLY non-CANCELLED, non-DRAFT orders.
//   · A build already carrying codes for that rule is TOPPED UP to the target,
//     never re-issued from scratch — so the script is idempotent and safe to
//     re-run after a partial failure.
//   · A sofa build is ONE trigger unit. The persisted SO splits a sofa into one
//     row per module SKU (variants.buildKey); counting rows would issue a
//     voucher per module. Rows are grouped by buildKey, the LEAD row (lowest
//     line_no) supplies trigger_item_code + qty, exactly as the cart line did.
//   · Model + compartment matching import the REAL shared matcher
//     (rule-target.ts), never a re-implementation, so this agrees with the
//     server gate line-for-line.
//
// APPLY=1 writes; anything else is a DRY-RUN that prints the full plan.
// SINCE=YYYY-MM-DD overrides the cutover date (default 2026-07-21).
import { register } from "node:module";
// Registered before the dynamic imports of the .ts shared modules below.
register("./_ts-resolve.mjs", import.meta.url);

import { randomInt } from "node:crypto";
import postgres from "postgres";

const { passesRefinementColumns } = await import("../src/scm/shared/rule-target.ts");

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const SINCE = (process.env.SINCE || "2026-07-21").trim();
const dst = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

// Same alphabet + shape as scm/routes/pwp-codes.ts genCode ('PWP-' + 4 digits +
// 4 A-Z). Not imported: that module builds a Hono router at import time and
// pulls the Workers request stack in with it. The FORMAT is all that is shared,
// and a collision is retried below either way.
// pwp_rules / pwp_codes hold their id lists as JSONB (not Postgres arrays), so
// every write goes through dst.json(); reads come back already parsed.
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const genCode = () => {
  let d = ""; for (let i = 0; i < 4; i++) d += String(randomInt(10));
  let l = ""; for (let i = 0; i < 4; i++) l += LETTERS[randomInt(26)];
  return `PWP-${d}${l}`;
};

// A sofa module's compartment code is its item_code SUFFIX (`ANNSA-1A(LHF)` ->
// `1A(LHF)`); every sofa SKU has size_code NULL. Mirrors the reserve route.
const compartmentOf = (itemCode) => {
  const i = String(itemCode).indexOf("-");
  return i > 0 ? String(itemCode).slice(i + 1) : "";
};

async function main() {
  const [c] = await dst`SELECT id FROM companies WHERE code='2990'`;
  if (!c) { log("no company code='2990' — nothing to do."); return; }
  const cid = Number(c.id);
  log(`company_id=${cid}  since=${SINCE}  mode=${APPLY ? "APPLY (writes)" : "DRY-RUN"}`);

  // 1. The rules the broken code could never match.
  const allSofaRules = await dst`
    SELECT id, trigger_eligible_model_ids, trigger_combo_ids, trigger_size_codes, trigger_compartments,
           reward_category, eligible_reward_model_ids, reward_combo_ids,
           reward_size_codes, reward_compartments, qty_per_trigger, type
      FROM scm.pwp_rules
     WHERE active = true AND company_id = ${cid} AND trigger_category = 'SOFA'`;
  const byModelRules = allSofaRules.filter(
    (r) => (r.trigger_combo_ids ?? []).length === 0 && (r.trigger_eligible_model_ids ?? []).length > 0,
  );
  const byComboRules = allSofaRules.filter((r) => (r.trigger_combo_ids ?? []).length > 0);
  log("");
  log(`=== active SOFA rules: ${allSofaRules.length} (by-Model ${byModelRules.length}, by-Combo ${byComboRules.length}) ===`);
  for (const r of byModelRules) {
    log(`  by-Model ${r.id}  models=${(r.trigger_eligible_model_ids ?? []).length}  -> ${r.reward_category} x${r.qty_per_trigger}  type=${r.type ?? "pwp"}`);
  }
  for (const r of byComboRules) log(`  by-Combo ${r.id} — SKIPPED (this branch always worked; re-minting would double-issue)`);
  if (byModelRules.length === 0) { log("no by-Model SOFA rule — nothing this bug could have missed. Done."); return; }

  // 2. Candidate SOs.
  const sos = await dst`
    SELECT doc_no, status, so_date, customer_id, salesperson_id, debtor_name
      FROM scm.mfg_sales_orders
     WHERE company_id = ${cid} AND so_date >= ${SINCE}::date
     ORDER BY doc_no`;
  const mirrored = sos.filter((s) => String(s.doc_no).startsWith("2990-"));
  const skippedStatus = sos.filter((s) => !String(s.doc_no).startsWith("2990-") && ["CANCELLED", "DRAFT"].includes(String(s.status).toUpperCase()));
  const live = sos.filter((s) => !String(s.doc_no).startsWith("2990-") && !["CANCELLED", "DRAFT"].includes(String(s.status).toUpperCase()));
  log("");
  log(`=== SOs since ${SINCE}: ${sos.length} — native live ${live.length}, cancelled/draft ${skippedStatus.length}, mirrored 2990-* ${mirrored.length} (reported only) ===`);
  if (mirrored.length > 0) {
    log(`  mirrored (their vouchers live in the 2990 database — owner ruling needed to re-home): ${mirrored.map((s) => s.doc_no).join(", ")}`);
  }
  if (live.length === 0) { log("no native live SOs in the window. Done."); return; }

  const docs = live.map((s) => s.doc_no);
  const soByDoc = new Map(live.map((s) => [s.doc_no, s]));

  // 3. Their sofa lines, grouped into builds.
  const lines = await dst`
    SELECT doc_no, line_no, item_code, qty, variants
      FROM scm.mfg_sales_order_items
     WHERE doc_no = ANY(${docs}) AND cancelled = false AND item_group = 'sofa'
     ORDER BY doc_no, line_no`;
  if (lines.length === 0) { log("no sofa lines in the window. Done."); return; }

  const codes = [...new Set(lines.map((l) => l.item_code))];
  const prods = await dst`SELECT code, model_id FROM scm.mfg_products WHERE code = ANY(${codes})`;
  const modelByCode = new Map(prods.map((p) => [p.code, p.model_id]));

  // buildKey groups one physical sofa; a row without one is its own build.
  const builds = new Map(); // `${doc}|${key}` -> { doc, lead, qty, compartments[], isReward }
  for (const l of lines) {
    const v = l.variants ?? {};
    const key = `${l.doc_no}|${v.buildKey ?? `line-${l.line_no}`}`;
    let b = builds.get(key);
    if (!b) {
      b = { doc: l.doc_no, lead: l, qty: Math.max(1, Math.floor(Number(l.qty) || 1)), compartments: [], isReward: false };
      builds.set(key, b);
    }
    b.compartments.push(compartmentOf(l.item_code));
    if (v.pwp === true || String(v.pwp) === "true") b.isReward = true;
  }

  // 4. What already exists (idempotency + never re-issue a build that has codes).
  const existing = await dst`
    SELECT source_doc_no, rule_id, trigger_item_code, COUNT(*)::int AS n
      FROM scm.pwp_codes
     WHERE source_doc_no = ANY(${docs})
     GROUP BY 1, 2, 3`;
  const haveKey = (doc, ruleId, code) => `${doc}|${ruleId}|${code}`;
  const have = new Map(existing.map((e) => [haveKey(e.source_doc_no, e.rule_id, e.trigger_item_code), e.n]));

  // 5. Plan.
  const plan = [];
  let noRuleMatch = 0;
  for (const b of builds.values()) {
    const modelId = modelByCode.get(b.lead.item_code) ?? null;
    const ruleLine = { category: "SOFA", modelId, sizeCode: null, builtCompartments: b.compartments };
    let matchedAny = false;
    for (const r of byModelRules) {
      const models = r.trigger_eligible_model_ids ?? [];
      if (!(modelId != null && models.includes(modelId))) continue;
      if (!passesRefinementColumns(ruleLine, r.trigger_size_codes, r.trigger_compartments)) continue;
      // Promo is one-way: a build that IS a reward never funds another free one.
      if (String(r.type ?? "pwp") === "promo" && b.isReward) continue;
      matchedAny = true;
      const target = Math.max(0, Math.floor((Number(r.qty_per_trigger) || 1) * b.qty));
      const already = have.get(haveKey(b.doc, r.id, b.lead.item_code)) ?? 0;
      const mint = target - already;
      plan.push({ build: b, rule: r, modelId, target, already, mint });
    }
    if (!matchedAny) noRuleMatch++;
  }

  const toMint = plan.filter((p) => p.mint > 0);
  const totalCodes = toMint.reduce((s, p) => s + p.mint, 0);
  const docsAffected = new Set(toMint.map((p) => p.build.doc));
  log("");
  log(`=== plan: ${builds.size} sofa builds — ${plan.length} rule matches, ${noRuleMatch} builds match no rule, ${totalCodes} vouchers to mint across ${docsAffected.size} SOs ===`);
  for (const p of plan) {
    const so = soByDoc.get(p.build.doc);
    const note = p.mint > 0 ? `MINT ${p.mint}` : `ok (has ${p.already}/${p.target})`;
    log(`  ${p.build.doc}  ${p.build.lead.item_code}  qty=${p.build.qty}  cust=${so?.debtor_name ?? "-"}${so?.customer_id ? "" : " ⚠ NO customer_id (voucher will not be customer-bound)"}  -> ${note}`);
  }
  if (totalCodes === 0) { log(""); log("nothing to mint. Done."); return; }
  if (!APPLY) { log(""); log("DRY-RUN — nothing written. Re-run with APPLY=1 to mint."); return; }

  // 6. Mint.
  let minted = 0;
  const mintedCodes = [];
  for (const p of toMint) {
    const so = soByDoc.get(p.build.doc);
    for (let i = 0; i < p.mint; i++) {
      let ok = false;
      for (let attempt = 0; attempt < 5 && !ok; attempt++) {
        const code = genCode();
        try {
          await dst`
            INSERT INTO scm.pwp_codes (
              company_id, code, rule_id, reward_category, eligible_reward_model_ids,
              reward_combo_ids, reward_size_codes, reward_compartments, type, status,
              owner_staff_id, cart_line_key, trigger_item_code, source_doc_no, customer_id
            ) VALUES (
              ${cid}, ${code}, ${p.rule.id}, ${p.rule.reward_category},
              ${dst.json(p.rule.eligible_reward_model_ids ?? [])}, ${dst.json(p.rule.reward_combo_ids ?? [])},
              ${dst.json(p.rule.reward_size_codes ?? [])}, ${dst.json(p.rule.reward_compartments ?? [])},
              ${p.rule.type ?? "pwp"}, 'AVAILABLE',
              ${so?.salesperson_id ?? null}, NULL, ${p.build.lead.item_code},
              ${p.build.doc}, ${so?.customer_id ?? null}
            )`;
          ok = true; minted++; mintedCodes.push(`${p.build.doc} ${code}`);
        } catch (e) {
          // 23505 = code collision -> regenerate. Anything else is real.
          if (!String(e?.message ?? e).includes("duplicate key")) throw e;
        }
      }
      if (!ok) throw new Error(`could not mint a unique code for ${p.build.doc} after 5 attempts`);
    }
  }
  log("");
  log(`=== MINTED ${minted} vouchers ===`);
  for (const m of mintedCodes) log(`  ${m}`);
}

main()
  .then(() => dst.end())
  .catch(async (e) => { console.error(e); await dst.end(); process.exit(1); });
