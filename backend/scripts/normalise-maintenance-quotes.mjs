#!/usr/bin/env node
// ---------------------------------------------------------------------------
// normalise-maintenance-quotes.mjs — straighten the typographic inch/foot marks
// in the LIVE maintenance config pools.
//
// THE SHAPE (measured on prod 2026-08-17). 2990's totalHeights pool carries
// `17“`, `19“`, `25”` and `27“` — U+201C/U+201D — alongside straight-quoted
// `18"` and `26"`. Products · Maintenance therefore lists the same kind of
// value two different ways, and a document that stores one spelling used to
// price against the other at 0.
//
// THE PRICING CONSEQUENCE IS ALREADY CLOSED IN CODE, and that matters for how
// you read this script: mfg-pricing.ts now matches exactly first and only then
// quote-insensitively, so nothing here is load-bearing for money. This is
// hygiene — making the stored pool read the way the Maintenance screen should.
//
// IT ADDS A VERSION, IT DOES NOT REWRITE ONE. maintenance_config_history is a
// versioned table and the app reads the newest row per (company, scope);
// editing an old row in place would rewrite what the business believed on a
// past date. So the normalised pools are INSERTed as a fresh version with
// today's effective_from, exactly as a human edit through the UI would land,
// and the previous version stays readable.
//
// A CONFLICTING DUPLICATE IS REFUSED, NOT MERGED. Supplier 07204b99's pool has
// 19 inches twice — curly at RM120, straight at RM40. Folding them together
// leaves two identical keys whose lookup answer depends on array order: the
// ambiguity made permanent instead of removed. Which price is right is a
// business fact nobody wrote down, so that POOL is reported and left alone
// (the other pools in the same config still get normalised).
//
// DRY-RUN BY DEFAULT.
//   node backend/scripts/normalise-maintenance-quotes.mjs
//   APPLY=true CONFIRM="I HAVE REVIEWED THE DRY-RUN" node backend/scripts/normalise-maintenance-quotes.mjs
//
// RE-RUN: a second run is a no-op. It re-reads the CURRENT version per
// (company, scope) — which, after an apply, is the normalised one it just
// wrote — finds nothing left to straighten, and inserts no version. Only the
// refusals are printed again, every time, until a human resolves them; that
// repetition is deliberate, because a conflicting duplicate stays wrong
// silently otherwise. It never stacks duplicate versions on repeat.
//
// REVERSAL: the previous version is untouched and still in the table. To go
// back, INSERT a copy of it with a later effective_from (same shape this script
// writes) — the app reads the newest row, so nothing has to be deleted.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { planQuoteNormalise } from './lib/maintenance-quote-normalise.mjs';

function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync('.dev.vars', 'utf8').match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}

const CONFIRM_PHRASE = 'I HAVE REVIEWED THE DRY-RUN';
const notice = (msg) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);

async function main() {
  const url = resolveUrl();
  if (!url) {
    console.error('DATABASE_URL not set (env var or .dev.vars). Aborting.');
    process.exit(1);
  }
  /* A mismatched CONFIRM exits rather than quietly demoting to a dry-run: the
     operator asked for a write, and answering a different question under a
     "DRY-RUN" banner reads as "there was nothing to do". Exit 2 so a wrapper
     can tell refused from ran-and-found-nothing. */
  if (process.env.APPLY === 'true' && process.env.CONFIRM !== CONFIRM_PHRASE) {
    console.error(`APPLY requested but CONFIRM did not match "${CONFIRM_PHRASE}". Nothing was written.`);
    process.exit(2);
  }
  const APPLY = process.env.APPLY === 'true';

  const pg = postgres(url, { ssl: 'require', prepare: false, max: 1 });
  const written = [];
  let refusedPools = 0;

  try {
    console.log(`\nMAINTENANCE QUOTE NORMALISE — ${APPLY ? 'APPLY (a new config version will be COMMITTED)' : 'DRY-RUN (nothing will be written)'}\n`);

    // The CURRENT config per (company, scope) — the rows the app actually reads.
    const current = await pg`
      SELECT DISTINCT ON (company_id, scope) id, company_id, scope, config, effective_from
        FROM scm.maintenance_config_history
       ORDER BY company_id, scope, effective_from DESC, created_at DESC`;

    for (const row of current) {
      const { config: next, changes, collisions } = planQuoteNormalise(row.config);
      const label = `company ${row.company_id} / ${row.scope}`;
      for (const c of collisions) {
        console.log(`  REFUSED  ${label}  ${c.pool} "${c.value}" — ${c.detail}`);
      }
      refusedPools += collisions.length;
      if (changes.length === 0) continue;

      console.log(`  ${label}: ${changes.length} value(s) to straighten`);
      for (const c of changes) console.log(`    ${c.pool}: ${JSON.stringify(c.from)} -> ${JSON.stringify(c.to)}`);

      if (APPLY) {
        const [ins] = await pg`
          INSERT INTO scm.maintenance_config_history (company_id, scope, config, effective_from, created_by, notes)
          VALUES (${row.company_id}, ${row.scope}, ${pg.json(next)}, CURRENT_DATE, NULL,
                  ${'Typographic quote normalisation — see backend/scripts/normalise-maintenance-quotes.mjs'})
          RETURNING id`;
        written.push({ id: ins.id, companyId: row.company_id, scope: row.scope, changes: changes.length });
      } else {
        written.push({ id: null, companyId: row.company_id, scope: row.scope, changes: changes.length });
      }
    }

    console.log('');
    notice(
      `${APPLY ? 'WROTE' : 'WOULD WRITE'} ${written.length} new config version(s); ` +
      `${refusedPools} pool(s) refused for conflicting duplicates (listed above, need a human).`,
    );
    if (!APPLY && written.length > 0) {
      console.log(`\nRe-run with:  APPLY=true CONFIRM="${CONFIRM_PHRASE}" node backend/scripts/normalise-maintenance-quotes.mjs`);
    }
    if (APPLY && written.length > 0) await verifyOnFreshConnection(url, written);
  } finally {
    await pg.end({ timeout: 5 });
  }
}

/* The session that wrote is the worst witness that the write landed. Re-open a
   SECOND connection and assert the SHAPE: each new row is now the current
   version for its (company, scope), and no pool value in it still carries a
   typographic quote. A row count would not catch a version that landed but is
   not the one the app will read. */
async function verifyOnFreshConnection(url, written) {
  const pg2 = postgres(url, { ssl: 'require', prepare: false, max: 1 });
  try {
    for (const w of written) {
      const [cur] = await pg2`
        SELECT id, config FROM scm.maintenance_config_history
         WHERE company_id = ${w.companyId} AND scope = ${w.scope}
         ORDER BY effective_from DESC, created_at DESC LIMIT 1`;
      if (!cur || cur.id !== w.id) {
        throw new Error(`post-apply verify FAILED — ${w.scope}: the current version is ${cur?.id ?? 'missing'}, not the ${w.id} this run wrote`);
      }
      const { changes } = planQuoteNormalise(cur.config);
      if (changes.length > 0) {
        throw new Error(`post-apply verify FAILED — ${w.scope}: ${changes.length} value(s) still carry a typographic quote`);
      }
    }
    notice(`Verified on a fresh connection: ${written.length} config version(s) current and quote-clean.`);
  } finally {
    await pg2.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
