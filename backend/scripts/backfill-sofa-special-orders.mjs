#!/usr/bin/env node
// Put the sofa SPECIAL ORDERS the AutoCount slips asked for onto the migrated
// lines, as picker codes where one exists and as free text where none does.
//
// Owner 2026-08-10, verbatim: "那些 Special order 全部 match 回来 special order
// 的 picker listing, 没有的才用 customs others 那边写进去."
//
// The picker master is scm.special_addons (SOFA category). It is READ LIVE and
// every rule below resolves its target against that read - a rule whose code is
// not in the database is REPORTED and its phrases fall through to free text,
// never silently mapped to a code that does not exist.
//
// WHERE THE PHRASES COME FROM. The line keeps its original AutoCount Desc2 in
// description2, so this re-decodes that text with the CURRENT parser and unions
// the result with whatever custom_specials already carries. Nothing already on
// the line is dropped. The re-decode matters: until today parse-sofa deleted
// every `bottom...` phrase before specials were collected, so all 53 umbrella
// fabric instructions were absent from the ERP entirely.
//
// DRY-RUN by default; APPLY=1 writes.
import postgres from "postgres";
import { parseSofa, SOFA_MODEL_ALIAS } from "./lib/parse-sofa.mjs";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const CO = Number(process.env.COMPANY || 1);
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });

const K = (s) => String(s ?? "").trim().toUpperCase().replace(/\s+/g, " ");
// same identity the parser dedupes on: letters and digits only, nilon = nylon
const skey = (s) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/NILON/g, "NYLON");
// match on words, so "BACK REST", "BACKREST" and "back-rest" are one thing
const flat = (s) => " " + String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim() + " ";

/* Owner rulings, each one the reason the rule exists.

   nylon 和 umbrella fabric 一样的                  -> Nylon Fabric
   "fully cover to floor no leg", "fully cover replace the leg" and
   "extend to floor with 1 inch leg" 都是 under no leg
                                        -> Seat Base Fully Cover with no Leg
   "after push back align to seat"      -> Seat Behind Extend 5"
   "seat cushion add height 1 inch"     -> NO code on purpose ("不要太多选项"),
                                           it belongs in the free text
   Altay Leg left the Specials picker for the sofa leg pool, so a leg-change
   phrase is deliberately NOT mapped here either.

   `no` is the negation guard: "request to normal leg and not fully cover" says
   the opposite of the code it would otherwise match. */
const RULES = [
  { code: 'Nylon Fabric',
    yes: (s) => /\b(nylon|nilon|umbrella|umb|nilonn?)\b/.test(s) },

  { code: 'Seat Base Fully Cover with no Leg',
    no: (s) => /\bnot fully cover|\bnormal leg\b/.test(s),
    yes: (s) => (/\bfully cover(ed)?\b/.test(s) && /\bno leg\b|\bto floor\b|\breplace the leg\b|\bchange for the leg\b/.test(s))
      || (/\breplace the leg\b/.test(s) && /\bfully cover(ed)?\b/.test(s))
      || (/\bextend to floor\b/.test(s) && /\bleg\b/.test(s))
      || /\bno leg\b/.test(s) },

  { code: 'Seat Behind Extend 5"',
    yes: (s) => /\bpush back\b/.test(s) && /\balign to seat\b/.test(s) },

  { code: 'Wooden Arm',
    yes: (s) => /\bwood\w*\b/.test(s) && /\barm\w*\b|\bplate\b/.test(s) },

  /* "notch" is the stitched dimple in a seat cushion; every one of these says
     do not put one there. Flagged in the report as an inferred mapping. */
  { code: 'No notch on Seat Cushion',
    no: (s) => /\bplane\b|\bplain\b/.test(s),
    yes: (s) => /\bno\b/.test(s) && /\bstitch\w*|\bstich\w*|\bholes?\b|\bnotch\b/.test(s)
      && /\bsit\w*|\bseat\w*|\bcushion\b|\bstitch\w*|\bstich\w*/.test(s) },

  // owner named this code from this exact phrase (tidy-sofa-special-addons.mjs)
  { code: 'Seat Cushion No Notch and Plain',
    yes: (s) => /\bno line\b/.test(s) && /\bplane\b|\bplain\b/.test(s) },

  { code: 'Seat Firmer',
    no: (s) => /\bless firm\b|\bsofter\b|\bmore soft\b|\bback\b/.test(s),
    yes: (s) => /\bseat\w*\b|\bsitting\b/.test(s) && /\bfirmer\b|\bharder\b|\bdo hard\b/.test(s) },

  { code: 'Backcushion Firmer',
    no: (s) => /\bless firm\b|\bsofter\b|\bmore soft\b|\bseat\b/.test(s),
    yes: (s) => /\bback\b/.test(s) && /\bfirmer\b|\bharder\b/.test(s) },

  { code: 'Seat and Backcushion Firmer',
    no: (s) => /\bless firm\b|\bsofter\b|\bmore soft\b/.test(s),
    yes: (s) => /\bseat\w*\b/.test(s) && /\bback\b/.test(s) && /\bfirmer\b|\bharder\b/.test(s) },

  { code: 'Separate Backrest Packing',
    yes: (s) => /\bback ?rest\b|\bback cushion\b/.test(s) && /\bseparate\b/.test(s) },

  { code: 'No bracket', yes: (s) => /\bno bracket\b/.test(s) },
  { code: 'Short Backrest', yes: (s) => /\bshort back ?rest\b/.test(s) },
  { code: 'Seat Add 1ft', yes: (s) => /\bseat\b/.test(s) && /\badd 1 ?f?t\b|\badd one foot\b/.test(s) },
  { code: 'Seat Behind Extend 4"', yes: (s) => /\bseat behind\b/.test(s) && /\bextend 4\b/.test(s) },
  { code: '5537 Backrest', yes: (s) => /\b5537\b/.test(s) && /\bback ?rest\b/.test(s) },
  { code: '5540 Backrest', yes: (s) => /\b5540\b/.test(s) && /\bback ?rest\b/.test(s) },
];

/* The back-cushion swap family. In these slips "backrest" and "back cushion"
   are the same part - the picker carries exactly one code per model number -
   so both wordings route to the model's code. 5537/5540 are handled above as
   their own products and must be tested before this. */
const CUSHION_MODELS = [
  ["8030", "Change 8030 Backcushion"],
  ["9028", "change to 9028 back cushion"],
  ["9050", "change to 9050 back cushion"],
  ["9058", "change to 9058 back cushion"],
  ["5535", "change to 5535 back cushion"],
];

function mapPhrase(raw, live) {
  const s = flat(raw);
  const out = new Set();
  for (const r of RULES) {
    if (r.no && r.no(s)) continue;
    if (!r.yes(s)) continue;
    const code = live.get(K(r.code));
    if (code) out.add(code);
  }
  if (/\bback ?rest\b|\bback ?cushion\b/.test(s)) {
    for (const [model, want] of CUSHION_MODELS) {
      // "9058 sofa backrest change 9028" names the sofa first: take the model
      // being changed TO, which is the last number mentioned
      if (!new RegExp(`\\b${model}\\b`).test(s)) continue;
      const nums = s.match(/\b\d{4}\b/g) || [];
      if (nums.length > 1 && nums[nums.length - 1] !== model) continue;
      const code = live.get(K(want));
      if (code) out.add(code);
    }
  }
  return [...out];
}

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"} company=${CO}`);

  // ---- the picker, read LIVE ------------------------------------------------
  const addons = await sql`SELECT code, label, categories, active FROM scm.special_addons
    WHERE company_id = ${CO} ORDER BY code`;
  const sofa = addons.filter((r) => (r.categories || []).some((c) => /sofa/i.test(String(c))));
  log(`special_addons rows: ${addons.length}; SOFA category: ${sofa.length}`);
  for (const r of sofa) log(`   [${r.code}]${r.active === false ? " (inactive)" : ""}`);

  const live = new Map();
  for (const r of sofa) { live.set(K(r.code), r.code); if (r.label) live.set(K(r.label), r.code); }
  const missing = [];
  for (const c of [...RULES.map((r) => r.code), ...CUSHION_MODELS.map(([, c]) => c)])
    if (!live.has(K(c))) missing.push(c);
  if (missing.length) {
    log("");
    log(`RULES whose picker code is NOT in the database - their phrases fall through to free text:`);
    for (const c of missing) log(`   MISSING  ${c}`);
  }

  // ---- the migrated sofa lines ---------------------------------------------
  const soLines = await sql`SELECT i.id, i.item_code AS code, i.description2 AS d2, i.custom_specials
    FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    WHERE h.company_id = ${CO} AND i.item_group = 'sofa' AND h.linked_ac_docno IS NOT NULL`;
  const poLines = await sql`SELECT i.id, i.material_code AS code, i.description2 AS d2, i.custom_specials
    FROM scm.purchase_order_items i JOIN scm.purchase_orders h ON h.id = i.purchase_order_id
    WHERE h.company_id = ${CO} AND i.item_group = 'sofa' AND h.linked_ac_docno IS NOT NULL`;
  log("");
  log(`migrated sofa lines: SO ${soLines.length}, PO ${poLines.length}`);

  const byCode = new Map();       // picker code -> phrase instances mapped to it
  const freeCounts = new Map();   // unmatched phrase -> occurrences
  let freeTotal = 0, matchedTotal = 0;
  const updates = { so: [], po: [] };

  for (const [which, rows] of [["so", soLines], ["po", poLines]]) {
    for (const r of rows) {
      /* {model}-{compartment}; the alias table is what the importers apply, so
         the re-decode sees the same model they did. */
      let model = String(r.code || "").split("-")[0].toUpperCase();
      model = SOFA_MODEL_ALIAS[model] || model;
      const phrases = [];
      const seen = new Set();
      const push = (t) => {
        const v = String(t ?? "").trim();
        const k = skey(v);
        if (!k) return;
        for (let i = 0; i < phrases.length; i++) {
          const e = skey(phrases[i]);
          if (e.includes(k)) return;
          if (k.includes(e)) { phrases[i] = v; return; }
        }
        seen.add(k); phrases.push(v);
      };
      /* Both recliner states decode the same specials (the sweep runs before
         any model logic), so one pass is enough. */
      if (r.d2) for (const s of parseSofa(r.d2, model, false).specials) push(s);
      const had = Array.isArray(r.custom_specials) ? r.custom_specials : [];
      for (const s of had) push(s);
      if (!phrases.length) continue;

      const codes = new Set(), free = [];
      for (const p of phrases) {
        // already a real picker code (a previous pass, or a hand-picked option)
        if (live.has(K(p))) { codes.add(live.get(K(p))); byCode.set(live.get(K(p)), (byCode.get(live.get(K(p))) || 0) + 1); continue; }
        const hit = mapPhrase(p, live);
        if (hit.length) {
          for (const c of hit) { codes.add(c); byCode.set(c, (byCode.get(c) || 0) + 1); }
          matchedTotal++;
        } else {
          free.push(p);
          freeCounts.set(K(p), (freeCounts.get(K(p)) || 0) + 1);
          freeTotal++;
        }
      }
      const next = [...codes, ...free];
      if (JSON.stringify(next) === JSON.stringify(had)) continue;
      updates[which].push({ id: r.id, next });
    }
  }

  // ---- report ---------------------------------------------------------------
  log("");
  log(`phrases matched to a picker code: ${matchedTotal}`);
  for (const [c, n] of [...byCode.entries()].sort((a, b) => b[1] - a[1])) log(`   ${String(n).padStart(4)}  ${c}`);
  log("");
  log(`phrases with no code, written as free text verbatim: ${freeTotal} (${freeCounts.size} distinct)`);
  for (const [p, n] of [...freeCounts.entries()].sort((a, b) => b[1] - a[1])) log(`   ${String(n).padStart(4)}  ${p}`);
  log("");
  log(`lines to update: SO ${updates.so.length}, PO ${updates.po.length}`);

  if (!APPLY) { log(""); log("DRY-RUN - set APPLY=1 to write."); await sql.end(); return; }

  for (const [which, table] of [["so", "mfg_sales_order_items"], ["po", "purchase_order_items"]]) {
    const list = updates[which];
    for (let i = 0; i < list.length; i += 200) {
      const b = list.slice(i, i + 200);
      await sql.begin(async (tx) => {
        for (const u of b)
          await tx.unsafe(`UPDATE scm.${table} SET custom_specials = $1::jsonb WHERE id = $2`,
            [JSON.stringify(u.next), u.id]);
      });
      log(`  ${which} ..${Math.min(i + 200, list.length)}/${list.length}`);
    }
  }
  log(`APPLIED - SO ${updates.so.length} lines, PO ${updates.po.length} lines.`);
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
