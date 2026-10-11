#!/usr/bin/env node
// ----------------------------------------------------------------------------
// seed-delivery-rate-cards.mjs — install a SAMPLE delivery rate card (Fleet
// Module C, mig 0207: scm.delivery_rate_cards + scm.delivery_rate_rules) for a
// company, so the admin page + reconciliation have something to show.
//
// WHY A SCRIPT, NOT A MIGRATION. Repo rule: sample / default rows the owner then
// edits belong in a one-shot script, not a numbered migration (numbered
// migrations run in prod forever). The tables ship EMPTY from 0207.
//
// The sample card is the owner's WORKED EXAMPLE, so a reconciliation demo lands
// on the same RM560 the unit test asserts:
//   1st set RM120 + 2nd set RM80 + 3rd+ RM60, sofa 2-4 RM90 / 5-6 RM130 / 7+ RM170,
//   outstation MELAKA RM150 / JOHOR RM200, dispose RM30, setup RM50, dismantle RM40,
//   service RM60, pickup RM70, inspection RM40, transfer RM50.
// (2 sets + sofa 3-comp + Melaka + setup + dismantle + dispose = RM560.)
//
// IDEMPOTENT: the card is keyed by (company_id, name); a second run skips it if
// the name already exists (never overwrites an owner edit).
//
// USAGE:
//   DATABASE_URL=…  node scripts/seed-delivery-rate-cards.mjs             # DRY-RUN
//   DATABASE_URL=…  APPLY=1 node scripts/seed-delivery-rate-cards.mjs     # WRITE
//   COMPANY_CODE=HOUZS APPLY=1 node scripts/seed-delivery-rate-cards.mjs  # one company
// ----------------------------------------------------------------------------
import postgres from "postgres";

const DSN = process.env.DATABASE_URL;
if (!DSN) {
  console.error("Set DATABASE_URL. Refusing to run without it.");
  process.exit(2);
}
const APPLY = process.env.APPLY === "1";
const COMPANY_CODE = process.env.COMPANY_CODE || null;
const sql = postgres(DSN, { ssl: /localhost|127\.0\.0\.1/.test(DSN) ? false : "require", prepare: false, max: 1 });

const RM = (n) => Math.round(n * 100);
const CARD_NAME = "Sample 3PL Rate Card";

// [rule_type, tier_position, bracket_min, bracket_max, zone, amount_centi]
const RULES = [
  ["POSITIONAL_TIER", 1, null, null, null, RM(120)],
  ["POSITIONAL_TIER", 2, null, null, null, RM(80)],
  ["POSITIONAL_TIER", 3, null, null, null, RM(60)],
  ["SOFA_BRACKET", null, 2, 4, null, RM(90)],
  ["SOFA_BRACKET", null, 5, 6, null, RM(130)],
  ["SOFA_BRACKET", null, 7, null, null, RM(170)],
  ["OUTSTATION", null, null, null, "MELAKA", RM(150)],
  ["OUTSTATION", null, null, null, "JOHOR", RM(200)],
  ["DISPOSE", null, null, null, null, RM(30)],
  ["SETUP", null, null, null, null, RM(50)],
  ["DISMANTLE", null, null, null, null, RM(40)],
  ["SERVICE", null, null, null, null, RM(60)],
  ["PICKUP", null, null, null, null, RM(70)],
  ["INSPECTION", null, null, null, null, RM(40)],
  ["TRANSFER", null, null, null, null, RM(50)],
];

async function resolveCompanies() {
  if (COMPANY_CODE) return sql`SELECT id, code FROM companies WHERE code = ${COMPANY_CODE}`;
  return sql`SELECT id, code FROM companies ORDER BY id`;
}

async function main() {
  const companies = await resolveCompanies();
  console.log(`mode=${APPLY ? "APPLY" : "DRY-RUN"}  companies=${companies.length}  rules/card=${RULES.length}`);
  if (companies.length === 0) {
    console.log("No companies matched — nothing to seed.");
    return;
  }

  let cardsInserted = 0;
  let rulesInserted = 0;
  for (const co of companies) {
    if (!APPLY) {
      console.log(`  [dry] company ${co.code ?? co.id}: card "${CARD_NAME}" (basis SET, aggregation DROP) + ${RULES.length} rules`);
      continue;
    }
    const existing = await sql`SELECT id FROM scm.delivery_rate_cards WHERE company_id = ${co.id} AND name = ${CARD_NAME}`;
    if (existing.length > 0) {
      console.log(`  company ${co.code ?? co.id}: "${CARD_NAME}" already exists — skipped.`);
      continue;
    }
    const [card] = await sql`
      INSERT INTO scm.delivery_rate_cards (company_id, name, basis, aggregation, notes)
      VALUES (${co.id}, ${CARD_NAME}, 'SET', 'DROP', 'Seeded sample — the Module C worked example (RM560).')
      RETURNING id`;
    cardsInserted += 1;
    for (let i = 0; i < RULES.length; i++) {
      const [rt, tier, bmin, bmax, zone, amount] = RULES[i];
      await sql`
        INSERT INTO scm.delivery_rate_rules
          (company_id, card_id, rule_type, tier_position, bracket_min, bracket_max, zone, amount_centi, sort_order)
        VALUES (${co.id}, ${card.id}, ${rt}, ${tier}, ${bmin}, ${bmax}, ${zone}, ${amount}, ${i})`;
      rulesInserted += 1;
    }
    console.log(`  company ${co.code ?? co.id}: inserted "${CARD_NAME}" + ${RULES.length} rules.`);
  }
  console.log(APPLY
    ? `Done. Inserted ${cardsInserted} card(s), ${rulesInserted} rule(s).`
    : "Dry run — pass APPLY=1 to write.");
}

main()
  .then(() => sql.end())
  .catch((e) => { console.error(e); sql.end(); process.exit(1); });
