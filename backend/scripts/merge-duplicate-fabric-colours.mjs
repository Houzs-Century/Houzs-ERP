#!/usr/bin/env node
/* Merge the DUPLICATE COLOURS that sit inside ONE series.

   THE CASES, from a prod run on 2026-08-13 — 68 of them:
     M2402:    "M2402-08"     = "M2402-8-YELLOW"
     M2402:    "M2402-4-SAND" = "M2402-04"
     GARFIELD: "GARFIELD-01"  = "GARFIELD-1-SOFT LINEN"
     BO315:    "BO315-2-FEATHER" = "BO315-02"
   One physical colour, two rows: an old format that kept the colour NAME
   inside the code, and the tidy SERIES-NN the 2026-08-11 normalisation
   introduced. The picker shows the same fabric twice.

   Owner 2026-08-13: "这些全部也一起" — merge them; and, on the standard the
   result must reach, "确保真的是干净的。因为这个东西做了很多次了".

   ── WHY THE PREVIOUS PASSES WERE NOT CLEAN ───────────────────────────────
   The shared sweep knew FOUR document arms. A source audit found fifteen line
   tables carrying a fabric colour, plus the printed text, plus the physical
   stock key, plus the model's colour whitelist — and NOT ONE foreign key
   protects any of them, because every reference is a bare TEXT string inside
   jsonb or inside a pipe-joined key. The census run before this script was
   written proved it on live data: BO315-2-FEATHER had 3 SO lines, 3 PO lines
   AND 3 inventory_movements + 3 inventory_lots rows. A four-arm merge would
   have moved the documents and left the stock in the retired colour's bucket,
   where it stops matching its own orders and resurfaces as a shortage.

   So this script repoints, for every pair, in ONE transaction:
     · variants on all 15 line arms, across the whole alias chain
       (fabricCode / colorCode / colourCode / fabricColor / colourId)
     · description2 — the STORED text every PDF prints
     · variant_key on all 8 stock tables, including the frozen
       committed_variant_key a ship commitment compares against
     · product_models.allowed_options->'fabrics', the ON/OFF whitelist that
       would otherwise make the SURVIVOR unpickable
     · the fabric_trackings COST row
   and then verifies with the same census, which must reach zero.

   ── WHAT IT REFUSES, AND WHY THAT MATTERS MOST ───────────────────────────
   The last time a script decided two fabric colour rows were "the same
   colour", it was wrong 38 times and the owner had to order a mass revival
   (restore-wrongly-superseded-fabrics.mjs is still in this directory). So:

     NAMES DISAGREE      "M2402-4-SAND" vs a winner whose description says
                         BEIGE is not a formatting difference, it is two
                         colours. Refused, listed, never merged.
     TIERS DISAGREE      two cost rows with different price tiers are a
                         pricing decision, not a duplicate. Refused.
     NO CANONICAL SIDE   if neither code is the tidy shape, there is nothing
                         to canonicalise TO. Refused.

   Refusing is the cheap failure. Merging two real colours is not: the loser's
   name leaves the picker, and every line on it silently becomes the winner.

   ── NOTHING IS DELETED ───────────────────────────────────────────────────
   The losing colour row is SUPERSEDED — active = false, label records what
   absorbed it and when — so a historical document that still names it (an
   audit row, a frozen revision) still resolves for display. The stamp is
   applied ONCE: a re-run finds the marker and leaves the label alone, because
   a 67-pair run has already produced "[superseded by X] [superseded by X]".

   MODE=plan (default) writes nothing. MODE=apply needs
   CONFIRM="I HAVE REVIEWED THE DRY-RUN", runs ONE TRANSACTION PER PAIR so a
   single bad pair cannot abort the other 67, and verifies on a fresh
   connection. */
import postgres from 'postgres';
import { normColour } from './lib/fabric-colour-match.mjs';
import { parse, canonId } from './lib/fabric-code.mjs';
import {
  repointColour, repointDescription2, repointVariantKey, repointAllowedOptions,
  countColour, arrayShapeCheck, skippedArms, sum, busy,
} from './lib/fabric-write.mjs';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const CO = Number(process.env.COMPANY || 1);
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'I HAVE REVIEWED THE DRY-RUN';
const ONLY = (process.env.PAIRS || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const STAMP = process.env.NOTE_DATE || new Date().toISOString().slice(0, 10);

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

/** The colour NAME a row asserts: whatever follows the code in its label, or
 *  in the cost ledger's description. Empty when the row names no colour. */
const nameOf = (colourId, label) => {
  const l = String(label ?? '').trim();
  const c = String(colourId ?? '').trim();
  const afterLabel = l.toUpperCase().startsWith(c.toUpperCase()) ? l.slice(c.length) : (l.includes(' ') ? l.slice(l.indexOf(' ') + 1) : '');
  return normColour(afterLabel).replace(/[^A-Z0-9]+/g, ' ').trim();
};

/** Is this code already the owner's shape — SERIES-NN with no colour name? */
const isCanonicalShape = (colourId) => {
  const p = parse(colourId);
  return Boolean(p) && !p.name && canonId(p) === normColour(colourId);
};

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (writes nothing)'} company=${CO} stamp=${STAMP}`);
  if (ONLY.length) note(`  restricted to losing colour_id(s): ${ONLY.join(', ')}`);

  const cols = await sql`SELECT fabric_id, colour_id, label, active
                           FROM scm.fabric_colours WHERE company_id = ${CO}`;
  const trk = await sql`SELECT fabric_code, fabric_description, price_tier, sofa_price_tier,
                               bedframe_price_tier, price_sen, supplier, supplier_code, is_active
                          FROM scm.fabric_trackings WHERE company_id = ${CO}`;
  const trkBy = new Map(trk.map((r) => [normColour(r.fabric_code), r]));
  note(`\nfabric_colours: ${cols.length} (${cols.filter((c) => c.active === false).length} already superseded)`);
  note(`fabric_trackings: ${trk.length}`);

  /* PAIR DETECTION — inside one series, two colour_ids whose canonical form is
     the same. That is the whole definition: "M2402-8-YELLOW" parses to
     M2402-08 and so does "M2402-08". A superseded row is a merge that already
     happened, not a duplicate, so it is left out of detection entirely. */
  const live = cols.filter((c) => c.active !== false);
  const bySeriesCanon = new Map();
  for (const r of live) {
    const p = parse(r.colour_id);
    if (!p) continue;
    const k = `${r.fabric_id}\0${canonId(p)}`;
    if (!bySeriesCanon.has(k)) bySeriesCanon.set(k, []);
    bySeriesCanon.get(k).push({ ...r, canon: canonId(p), name: p.name || nameOf(r.colour_id, r.label) });
  }

  const pairs = [], refused = [];
  for (const [, group] of bySeriesCanon) {
    if (group.length < 2) continue;
    /* CANONICAL SIDE: the row whose code already IS the canonical form. If
       none is, there is nothing to canonicalise TO and guessing is what the
       38-row incident was. If several are, they are byte-identical codes,
       which cannot happen under the (fabric_id, colour_id) primary key. */
    const canonical = group.filter((r) => isCanonicalShape(r.colour_id));
    if (canonical.length !== 1) {
      refused.push({ group, why: canonical.length === 0 ? 'no side is the canonical SERIES-NN shape' : 'more than one canonical side' });
      continue;
    }
    const keep = canonical[0];
    for (const drop of group.filter((r) => r !== keep)) {
      /* NAMES MUST NOT DISAGREE. A name on one side and none on the other is
         a formatting difference — the tidy code simply moved the name to the
         description. Two DIFFERENT names is two colours. */
      const kName = keep.name || nameOf(keep.colour_id, trkBy.get(normColour(keep.colour_id))?.fabric_description);
      const dName = drop.name || nameOf(drop.colour_id, trkBy.get(normColour(drop.colour_id))?.fabric_description);
      if (kName && dName && kName !== dName) {
        refused.push({ group: [keep, drop], why: `colour names disagree: "${kName}" vs "${dName}"` });
        continue;
      }
      /* TIERS MUST NOT DISAGREE. Two cost rows priced differently are a
         pricing decision, not a duplicate — the rule align-fabric-trackings
         already set. */
      const kt = trkBy.get(normColour(keep.colour_id)), dt = trkBy.get(normColour(drop.colour_id));
      const tierClash = kt && dt && ['price_tier', 'sofa_price_tier', 'bedframe_price_tier']
        .filter((f) => (kt[f] ?? null) !== (dt[f] ?? null));
      if (tierClash && tierClash.length) {
        refused.push({ group: [keep, drop], why: `cost tiers disagree on ${tierClash.join(', ')}` });
        continue;
      }
      pairs.push({ series: keep.fabric_id, keep, drop, name: kName || dName || null, keepTrk: kt, dropTrk: dt });
    }
  }

  const scoped = ONLY.length ? pairs.filter((p) => ONLY.includes(normColour(p.drop.colour_id))) : pairs;
  note(`\n=== DUPLICATE COLOURS INSIDE ONE SERIES ===`);
  note(`  pairs to merge: ${scoped.length}${ONLY.length ? ` (of ${pairs.length}; PAIRS restricts it)` : ''}`);
  note(`  refused:        ${refused.length}`);
  for (const r of refused) {
    note(`    REFUSED ${r.group.map((g) => `"${g.colour_id}"`).join(' = ')} — ${r.why}`);
  }

  /* Live references BEFORE, so the plan states the exposure and the apply has
     a number to verify against. */
  note(`\n=== PER-PAIR PLAN ===`);
  for (const p of scoped) {
    p.before = sum(await countColour(sql, CO, p.drop.colour_id));
    p.keepBefore = sum(await countColour(sql, CO, p.keep.colour_id));
    note(`  ${String(p.series).padEnd(14)} "${p.drop.colour_id}" -> "${p.keep.colour_id}"${p.name ? `  (${p.name})` : ''}`);
    note(`      loser ${String(p.before).padStart(5)} live line(s) | winner ${String(p.keepBefore).padStart(5)}`);
  }
  const skipped = skippedArms();
  if (skipped.length) {
    note(`\n  ARMS SKIPPED (not present in this database — say it, never sweep silently):`);
    for (const s of skipped) note(`    ${s.kind.padEnd(12)} ${String(s.table).padEnd(42)} ${s.why}`);
  }
  note(`\n  total live lines that would move: ${scoped.reduce((a, p) => a + p.before, 0)}`);

  if (!APPLY) {
    note(`\nPLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end({ timeout: 5 });
    return;
  }

  // ── APPLY: ONE TRANSACTION PER PAIR ──────────────────────────────────────
  note(`\n=== APPLYING ${scoped.length} PAIR(S) ===`);
  const done = [], failed = [];
  for (const p of scoped) {
    const from = p.drop.colour_id, to = p.keep.colour_id;
    try {
      await sql.begin(async (tx) => {
        /* Lock the winner's library row first. The collision guard in the
           series merger was check-then-act with no lock while a live app path
           could insert the row it had just checked for. */
        await tx`SELECT 1 FROM scm.fabric_colours
                  WHERE company_id = ${CO} AND fabric_id = ${p.series} AND colour_id = ${to}
                  FOR UPDATE`;

        const moved = {
          variants: busy(await repointColour(tx, CO, from, to)),
          desc2: busy(await repointDescription2(tx, CO, from, to)),
          stock: busy(await repointVariantKey(tx, CO, from, to)),
          models: (await repointAllowedOptions(tx, CO, from, to)).n,
        };

        /* The cost row. The winner keeps its own values but ABSORBS anything
           only the loser had — a supplier code that vanishes from the PO is a
           silent regression on a printed document. */
        if (p.dropTrk) {
          await tx`UPDATE scm.fabric_trackings k
                      SET supplier = COALESCE(k.supplier, ${p.dropTrk.supplier}),
                          supplier_code = COALESCE(k.supplier_code, ${p.dropTrk.supplier_code})
                    WHERE k.company_id = ${CO} AND k.fabric_code = ${to}`;
          await tx`UPDATE scm.fabric_trackings
                      SET is_active = false
                    WHERE company_id = ${CO} AND fabric_code = ${from}`;
        }

        /* Nothing may still name the loser before it is superseded. */
        const left = sum(await countColour(tx, CO, from));
        if (left) throw new Error(`${left} live line(s) still name "${from}" after the repoint`);

        /* SUPERSEDE, never delete — and stamp ONCE. */
        const tag = `[MERGED into ${to} on ${STAMP} - superseded, not deleted]`;
        await tx`UPDATE scm.fabric_colours
                    SET active = false,
                        label = CASE WHEN COALESCE(label, '') LIKE '%[MERGED into %' THEN label
                                     ELSE COALESCE(label, ${from}) || ' ' || ${tag} END
                  WHERE company_id = ${CO} AND fabric_id = ${p.series} AND colour_id = ${from}`;

        done.push({ from, to, moved });
        note(`  OK  "${from}" -> "${to}"  variants[${moved.variants || '-'}] desc2[${moved.desc2 || '-'}] stock[${moved.stock || '-'}] models[${moved.models}]`);
      });
    } catch (e) {
      failed.push({ from, to, why: e.message });
      bad(`FAILED "${from}" -> "${to}": ${e.message} (this pair rolled back; the others stand)`);
    }
  }

  // ── VERIFY ON A FRESH CONNECTION ─────────────────────────────────────────
  await sql.end({ timeout: 5 });
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    note(`\n=== VERIFIED ON A FRESH CONNECTION ===`);
    note(`  merged: ${done.length}   failed: ${failed.length}   refused earlier: ${refused.length}`);
    let dirty = 0;
    for (const d of done) {
      const left = sum(await countColour(check, CO, d.from));
      if (left) { bad(`  "${d.from}" still named by ${left} live line(s)`); dirty += left; }
    }
    if (!dirty) note(`  no merged colour is named by any live line on any of the 15 arms`);
    for (const a of await arrayShapeCheck(check, CO)) {
      if (a.n) bad(`  ${a.arm}: ${a.n} row(s) whose variants became an ARRAY — the 2026-08-10 shape`);
    }
    note(`\n  Now run census-fabric-colour with require_clean=1 over the merged codes.`);
    note(`  This script proves the 15 line arms; the census proves all 51 live carriers.`);
  } finally {
    await check.end({ timeout: 5 });
  }
}

main().catch(async (e) => {
  bad(e.message);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
