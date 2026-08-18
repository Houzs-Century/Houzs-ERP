#!/usr/bin/env node
// ---------------------------------------------------------------------------
// normalise-maintenance-quotes.mjs — REPORT ONLY. Lists the typographic
// inch/foot marks in the live maintenance pools. It cannot write.
//
// IT USED TO BE ABLE TO, AND THAT WAS A MISTAKE — mine, on 2026-08-17. The
// reasoning was that straightening `17“` to `17"` is cosmetic, because the
// PRICING consequence is already closed in code (mfg-pricing.ts matches
// exactly first, then quote-insensitively, so a curly document finds the
// straight tier and vice versa).
//
// WHAT THAT MISSED: `gaps` and `totalHeights` values are not labels. They are
// components of `variant_key`, which IS the inventory bucket identity —
//
//     fabriccode=bf-18|gap=12“|divanheight=8"|legheight=2"|totalheight=22"
//
// Rewriting the POOL does not touch a single stored document, which is why it
// looks safe. It changes what the PICKER offers from then on: new documents
// get `gap=12"` while the existing stock sits in `gap=12“`. Measured on prod
// 2026-08-18: 12 inventory lots (11 units), 12 balances, 15 movements and 21
// document lines carry a curly mark in their key. One physical spec would
// split into two buckets, and MRP would report a shortage against stock that
// is on the shelf — the exact defect class the 2026-08-17 investigation was
// about, recreated by the tidy-up for it.
//
// OWNER DECISION 2026-08-18, after that was measured: leave the pools alone.
// The mixed spelling costs nothing now that the lookup handles both, and
// "the Maintenance screen looks tidier" does not buy a rewrite of inventory
// identity. Unifying them for real means migrating variant_key across all
// five tables first, with a bucket-merge reconciliation, and only then the
// pools — a separate, deliberate piece of work, in that order.
//
// So this reports and stops. The conflicting-duplicate detection is still
// worth running: it is how the two zero-priced curly duplicates (19" and 25"
// under HOOKKA MANUFACTURING) were found and resolved by hand.
//
// Usage: node backend/scripts/normalise-maintenance-quotes.mjs
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { planQuoteNormalise } from './lib/maintenance-quote-normalise.mjs';

function readUrlFromDevVars() {
  try {
    return readFileSync('.dev.vars', 'utf8').match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}

const notice = (msg) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);

function resolveUrlOrExit() {
  const url = process.env.DATABASE_URL || readUrlFromDevVars();
  if (!url) {
    console.error('DATABASE_URL not set (env var or .dev.vars). Aborting.');
    process.exit(1);
  }
  return url;
}

async function main() {
  /* REFUSES THE WRITE IT USED TO OFFER. Someone reaching for this script is
     reaching for the tidy-up the header explains is unsafe, so saying so at the
     moment they ask is worth more than a note they already skipped. */
  if (process.env.APPLY === 'true') {
    console.error('APPLY is not supported: normalising these pools splits inventory buckets (see the header).');
    console.error('Unifying the spellings means migrating variant_key across inventory_lots, inventory_balances,');
    console.error('inventory_movements and the document lines FIRST, with a bucket-merge reconciliation.');
    console.error('Owner decision 2026-08-18: not doing it. The lookup already prices both spellings correctly.');
    process.exit(2);
  }

  const pg = postgres(resolveUrlOrExit(), { ssl: 'require', prepare: false, max: 1 });
  let dirtyScopes = 0;
  let refusedPools = 0;

  try {
    console.log('\nMAINTENANCE QUOTE REPORT — read-only, nothing is written.\n');

    const current = await pg`
      SELECT DISTINCT ON (company_id, scope) id, company_id, scope, config, effective_from
        FROM scm.maintenance_config_history
       ORDER BY company_id, scope, effective_from DESC, created_at DESC`;

    for (const row of current) {
      const { changes, collisions } = planQuoteNormalise(row.config);
      const label = `company ${row.company_id} / ${row.scope}`;
      for (const c of collisions) {
        console.log(`  CONFLICT  ${label}  ${c.pool} "${c.value}" — ${c.detail}`);
      }
      refusedPools += collisions.length;
      if (changes.length === 0) continue;
      dirtyScopes += 1;
      console.log(`  ${label}: ${changes.length} value(s) spelled with a typographic mark`);
      for (const c of changes) console.log(`    ${c.pool}: ${JSON.stringify(c.from)} (would be ${JSON.stringify(c.to)})`);
    }

    console.log('');
    notice(
      `${dirtyScopes} config scope(s) carry typographic quotes; ${refusedPools} pool(s) hold a conflicting duplicate. ` +
      'Nothing was written — see the header for why the pools are left as they are.',
    );
    /* A CONFLICTING DUPLICATE IS THE ONE THING HERE THAT STILL COSTS MONEY: two
       spellings of one tier at two prices means the answer depends on array
       order. Those are resolved by hand, and until they are, this exits
       non-zero so a scheduled run would not report health it does not have. */
    if (refusedPools > 0) process.exit(1);
  } finally {
    await pg.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
