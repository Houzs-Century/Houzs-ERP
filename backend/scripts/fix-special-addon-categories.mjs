#!/usr/bin/env node
// Two mistakes from today's specials work, both mine, both invisible until the
// owner opened the page and said "空的啊".
//
// 1. THE TOKEN IS UPPER CASE. Every pre-existing row carries ["SOFA"] or
//    ["BEDFRAME"]; the fifteen rows I created and renamed carry ["sofa"]. The
//    maintenance page splits the list by that token, so all fifteen are on file
//    and none of them show under SOFA Specials.
//
// 2. THE DEDUPE KEPT THE WRONG TWIN. "Nylon Fabric", "5537 Backrest" and
//    "Separate Backrest Packing" each existed twice - once plain, once with a
//    "(Sofa)" suffix. I kept the plain one and deleted the "(Sofa)" one, but
//    the plain one is categorised BEDFRAME. Three sofa specials vanished from
//    the sofa list.
//
//    The fix is NOT to recreate the twins. categories is an ARRAY: one code can
//    serve both lists. Add "SOFA" to those three and the picker is whole again
//    with no duplicate to merge later.
//
// DRY-RUN by default; APPLY=1 writes.
//
// RE-RUN: inert. The category rewrite is computed from the row as it reads now, and a corrected row produces no change.
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const CO = Number(process.env.COMPANY || 1);
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });

// the three whose surviving row is BEDFRAME-only but which the sofa list needs
const ALSO_SOFA = ["Nylon Fabric", "5537 Backrest", "Separate Backrest Packing"];

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"} company=${CO}`);
  const rows = await sql`SELECT id, code, categories FROM scm.special_addons WHERE company_id = ${CO} ORDER BY code`;
  const cat = (r) => (Array.isArray(r.categories) ? r.categories : []);

  const lower = rows.filter((r) => cat(r).some((c) => c !== String(c).toUpperCase()));
  log(`rows with a lower-case category token: ${lower.length}`);
  for (const r of lower) log(`   ${r.code}  ${JSON.stringify(cat(r))} -> ${JSON.stringify(cat(r).map((c) => String(c).toUpperCase()))}`);

  const add = rows.filter((r) => ALSO_SOFA.some((n) => n.toUpperCase() === r.code.trim().toUpperCase())
    && !cat(r).some((c) => String(c).toUpperCase() === "SOFA"));
  log("");
  log(`rows needing SOFA added: ${add.length}`);
  for (const r of add) log(`   ${r.code}  ${JSON.stringify(cat(r))} -> ${JSON.stringify([...cat(r), "SOFA"])}`);

  if (!lower.length && !add.length) { log("nothing to do"); await sql.end(); return; }
  if (!APPLY) { log("\nDRY-RUN — set APPLY=1 to write."); await sql.end(); return; }

  for (const r of lower) {
    const next = [...new Set(cat(r).map((c) => String(c).toUpperCase()))];
    await sql`UPDATE scm.special_addons SET categories = ${next} WHERE id = ${r.id}`;
  }
  for (const r of add) {
    const next = [...new Set([...cat(r).map((c) => String(c).toUpperCase()), "SOFA"])];
    await sql`UPDATE scm.special_addons SET categories = ${next} WHERE id = ${r.id}`;
  }
  log(`APPLIED — ${lower.length} tokens upper-cased, ${add.length} given SOFA as well.`);
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
