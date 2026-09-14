#!/usr/bin/env node
// Re-activate ONE retired special option for ONE company.
// MODE=plan by default; MODE=apply needs CONFIRM.
//
// THE ASK (owner, 2026-09-14): 「查看有什么类似的 seperate packing for backerest
// 的 special 嘛 没有的话就用 1 这个」 — look for an ACTIVE option that means the
// same as `Separate Backrest Packing`; if there is none, re-activate it.
//
// THE LOOK, and it is not skipped: before writing, this prints every ACTIVE
// option in the same category whose code or label mentions packing, backrest
// packing, or separate. If one exists the run REFUSES to re-activate — the
// owner said to use the existing one in that case, and re-offering a duplicate
// would put two picker entries on one meaning, which is exactly the legacy
// spelling mess docs/bugs/0851 is cleaning up.
//
// WHY IT MATTERS. unify-legacy-specials refuses to fold a live line onto a
// RETIRED option (docs/bugs/0859's round, chore/authorise-remaining-families).
// Two lines carry a legacy spelling of this option and cannot be folded until
// it is active again.
//
// It changes `active` and NOTHING else — no price, no category, no label.
//
// RE-RUN: inert. A second run finds the option already active and writes nothing.
//
//   DATABASE_URL   required
//   COMPANY_ID     optional, default 1
//   CODE           required, the exact catalogue code
//   MODE           plan (default) | apply
//   CONFIRM        required for apply: REACTIVATE THIS OPTION
import postgres from 'postgres';

const CONFIRM_PHRASE = 'REACTIVATE THIS OPTION';
const MODE = String(process.env.MODE || 'plan').toLowerCase();
const WANTS_APPLY = MODE === 'apply';
const CO = Number(process.env.COMPANY_ID || 1);
const CODE = String(process.env.CODE || '').trim();
const line = (s = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${s}` : s);
const rule = () => line('-'.repeat(78));

const DST = process.env.DATABASE_URL;
if (!DST) { console.error('need DATABASE_URL'); process.exit(2); }
if (!CODE) { console.error('need CODE'); process.exit(2); }
if (WANTS_APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}" — refusing, nothing was written.`);
  process.exit(2);
}
const APPLY = WANTS_APPLY;
const sql = postgres(DST, { ssl: 'require', max: 1, prepare: false });

try {
  line('='.repeat(78));
  line(`RE-ACTIVATE A SPECIAL OPTION — "${CODE}"   company ${CO}   mode ${APPLY ? 'APPLY' : 'PLAN'}`);
  line('='.repeat(78));

  const [target] = await sql`
    SELECT id::text AS id, code, label, categories, active,
           coalesce(selling_price_sen,0)::int AS sell, coalesce(cost_price_sen,0)::int AS cost
      FROM scm.special_addons WHERE company_id = ${CO} AND code = ${CODE}`;
  if (!target) { line(`   NOT FOUND: no option "${CODE}" for company ${CO}. Nothing to do.`); process.exit(0); }
  line(`   found: ${target.code}   categories ${JSON.stringify(target.categories)}   active=${target.active}`
    + `   cost ${target.cost}   selling ${target.sell}`);
  if (target.active === true) { line('   already ACTIVE. Nothing to do.'); process.exit(0); }

  /* THE LOOK the owner asked for: an active option meaning the same thing. */
  const cats = (target.categories ?? []).map(String);
  const similar = await sql`
    SELECT code, label, categories FROM scm.special_addons
     WHERE company_id = ${CO} AND active = true AND id::text <> ${target.id}
       AND (code ILIKE '%pack%' OR coalesce(label,'') ILIKE '%pack%'
            OR code ILIKE '%separate%' OR coalesce(label,'') ILIKE '%separate%')`;
  const sameCat = similar.filter((s) => (s.categories ?? []).some((c) => cats.includes(String(c))));
  rule();
  line('   ACTIVE options that might already mean the same thing (code or label mentions');
  line('   packing or separate, same category):');
  if (!sameCat.length) line('      NONE. There is no active equivalent.');
  for (const s of sameCat) line(`      ${s.code}   ${JSON.stringify(s.categories)}`);
  if (sameCat.length) {
    rule();
    line('   REFUSED — an active option already covers this. The owner said to use the');
    line('   existing one in that case; fold the lines onto it instead of re-activating a');
    line('   duplicate. Nothing was written.');
    process.exit(0);
  }

  if (!APPLY) {
    rule();
    line('PLAN ONLY — nothing was written.');
    line(`To write: MODE=apply CONFIRM="${CONFIRM_PHRASE}" CODE="${CODE}"`);
  } else {
    const res = await sql`
      UPDATE scm.special_addons SET active = true
       WHERE id = ${target.id} AND company_id = ${CO} AND active = false`;
    line(`APPLIED — ${Number(res.count ?? 0)} option re-activated.`);

    /* VERIFY on a FRESH connection, asserting the SHAPE: active is true, and
       every other field is exactly what it was. */
    const check = postgres(DST, { ssl: 'require', max: 1, prepare: false });
    try {
      const [a] = await check`
        SELECT active, code, label, categories,
               coalesce(selling_price_sen,0)::int AS sell, coalesce(cost_price_sen,0)::int AS cost
          FROM scm.special_addons WHERE id = ${target.id}`;
      const bad = [];
      if (a?.active !== true) bad.push('active is not true');
      if (a?.sell !== target.sell) bad.push(`selling moved ${target.sell} -> ${a?.sell}`);
      if (a?.cost !== target.cost) bad.push(`cost moved ${target.cost} -> ${a?.cost}`);
      if (a?.label !== target.label) bad.push('label moved');
      if (JSON.stringify(a?.categories) !== JSON.stringify(target.categories)) bad.push('categories moved');
      if (bad.length) { line(`VERIFY FAILED — ${bad.join(' · ')}`); process.exitCode = 1; }
      else line('VERIFY OK — active, and price, label and categories unchanged.');
    } finally {
      await check.end({ timeout: 5 });
    }
  }
} finally {
  await sql.end({ timeout: 5 });
}
