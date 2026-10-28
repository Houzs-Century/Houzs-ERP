#!/usr/bin/env node
// set-auto-derive-product-cost — turn the cost auto-derive on / off for ONE company.
//
// Writes scm.app_config['scm.auto_derive_product_cost'], which
// scm/lib/auto-derive-cost.ts reads (autoDeriveEnabled) before recomputing a
// SKU's cost from its supplier bindings: absent row / any value but on|1|true
// = OFF, and the read fails CLOSED. While OFF the routes keep the old
// is_cost_anchor path.
//
// WHY THIS SCRIPT EXISTS. The flag was switched on by hand on 2026-09-16 and
// the mechanism erased 193 of company 2's RETAIL prices over four days, because
// the reader carried no company predicate and the single app_config row lives
// under company 1. Retail is now defended where it is WRITTEN (every derive path
// merges via mergeRetailOntoDerivedSeatGrid, and company 2 has the DB trigger
// trg_mfg_products_retail_price_lock), and the owner asked (2026-09-25) for both
// companies to behave the same, so the switch is now GLOBAL: autoDeriveEnabled
// reads the one (key) row regardless of company. This script is the write half:
// it names the company out loud and refuses to re-point the single row at a
// different company (which would move the switch out from under its owner).
//
// TWO GATES, because this ends in a switch over a live catalogue:
//   MODE     plan (DEFAULT) shows what it WOULD write and writes nothing;
//            apply writes, and only with the confirm phrase.
//   CONFIRM  must equal 'set-auto-derive-product-cost' on the apply path.
// COMPANY_ID is required and has no default — it is the parameter that decides.
// DERIVE is the value to set: on | off.
//
// RE-RUN: idempotent. A second run with the same COMPANY_ID and DERIVE leaves
// the row on the same value and the fresh-connection read-back proves it;
// nothing accumulates.
import postgres from "postgres";
import { decideFlagWrite } from "./lib/auto-derive-flag-decision.mjs";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }

const KEY = "scm.auto_derive_product_cost";
const CONFIRM_PHRASE = "set-auto-derive-product-cost";
const MODE = (process.env.MODE || "plan").trim().toLowerCase();
const DERIVE = (process.env.DERIVE || "").trim().toLowerCase();
const CONFIRM = (process.env.CONFIRM || "").trim();
const COMPANY_ID = Number((process.env.COMPANY_ID || "").trim());

const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const die = (m) => { console.error(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR: ${m}`); process.exit(1); };

const describe = (v) => {
  const s = String(v ?? "").trim().toLowerCase();
  return ["on", "1", "true"].includes(s)
    ? "ON — a supplier-price write recomputes that SKU's derived cost"
    : "OFF — the routes keep the is_cost_anchor path";
};

async function main() {
  const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
  const [existing] = await sql`SELECT value, company_id FROM scm.app_config WHERE key = ${KEY}`;

  log(`current: ${existing ? `${JSON.stringify(existing.value)} (company ${existing.company_id})` : "(row absent)"} -> ${describe(existing?.value)}`);
  log(`target : ${JSON.stringify(DERIVE)} for company ${COMPANY_ID} -> ${describe(DERIVE)}`);

  const decision = decideFlagWrite({ key: KEY, companyId: COMPANY_ID, desired: DERIVE, existing: existing ?? null });
  if (!decision.ok) { await sql.end(); die(decision.reason); }
  log(`plan: ${decision.action.toUpperCase()} (${decision.from === null ? "no row" : JSON.stringify(decision.from)} -> ${JSON.stringify(DERIVE)})`);

  if (MODE !== "apply") {
    log(`PLAN: nothing written. Re-run with MODE=apply CONFIRM=${CONFIRM_PHRASE} to set it.`);
    await sql.end();
    return;
  }
  if (CONFIRM !== CONFIRM_PHRASE) { await sql.end(); die(`apply needs CONFIRM=${CONFIRM_PHRASE}`); }

  const description = "Cost auto-derive (scm/lib/auto-derive-cost.ts). Per company: the reader filters on company_id.";
  if (decision.action === "update") {
    await sql`UPDATE scm.app_config SET value = ${DERIVE}, description = ${description}, updated_at = now()
               WHERE key = ${KEY} AND company_id = ${COMPANY_ID}`;
  } else {
    await sql`INSERT INTO scm.app_config (key, value, description, company_id, updated_at)
              VALUES (${KEY}, ${DERIVE}, ${description}, ${COMPANY_ID}, now())`;
  }
  await sql.end();

  /* Verify on a FRESH connection and assert the SHAPE — the value AND the
     company that holds it, not a row count. "I set it" and "it is set" must not
     be able to disagree, and the company is half of what was set. */
  const sql2 = postgres(DST, { ssl: "require", prepare: false, max: 1 });
  const [after] = await sql2`SELECT value, company_id FROM scm.app_config WHERE key = ${KEY}`;
  await sql2.end();
  const got = String(after?.value ?? "");
  const gotCompany = Number(after?.company_id ?? 0);
  if (got !== DERIVE || gotCompany !== COMPANY_ID) {
    die(`verify FAILED: ${KEY} = ${JSON.stringify(got)} (company ${gotCompany}), expected ${JSON.stringify(DERIVE)} (company ${COMPANY_ID}). Nothing to trust.`);
  }
  log(`APPLIED: ${KEY} = ${JSON.stringify(got)} for company ${gotCompany} -> ${describe(got)} (verified on a fresh connection)`);
  log("takes effect on the next supplier-price write. Watch the '2990 retail prices - sentinel' workflow tomorrow.");
}
main().catch((e) => { console.error(e); process.exit(1); });
