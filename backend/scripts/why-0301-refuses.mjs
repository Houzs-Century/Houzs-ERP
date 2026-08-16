#!/usr/bin/env node
// READ-ONLY. Why migration 0301 rejects its own rewrite and blocks every deploy.
//
// SINCE 2026-08-16 11:16Z the production deploy has failed on every push with
//
//   FAILED 0301_so_balance_live_signed.sql: 0301: rewrite reported success
//          but balance_centi_live is still floored.
//
// and because pg-migrate stops at the first failure, NOTHING has shipped since
// 11:12:53Z. 0301 rewrites `scm.mfg_sales_orders_with_payment_totals` by string
// substitution on `pg_get_viewdef(..., true)`, swapping
//
//   GREATEST(so.local_total_centi - COALESCE(p.paid_total, 0::bigint), 0::bigint) AS balance_centi_live
//   -> (so.local_total_centi - COALESCE(p.paid_total, 0::bigint)) AS balance_centi_live
//
// then re-reads the catalogue and demands the SECOND literal appear verbatim.
//
// HYPOTHESIS: the view IS rewritten correctly and only the post-condition is
// wrong, because `CREATE OR REPLACE VIEW` does not store the text it was given
// — Postgres parses it to a tree and pg_get_viewdef DEPARSES that tree afresh.
// The deparser emits only the parentheses precedence requires, so a top-level
// select-list item written `(a - b) AS x` comes back as `a - b AS x` and the
// literal with its outer parens can never match.
//
// WHAT WOULD REFUTE IT: this server's deparser keeping redundant outer
// parentheses on an aliased arithmetic expression. If existing views in this
// database DO carry `(a - b) AS x`, the hypothesis is dead and the rewrite is
// genuinely not applying — a completely different fix.
//
// That distinction is the whole point of this script, and it decides whether
// relaxing the post-condition is a correct fix or is forging the evidence the
// post-condition exists to check. DO NOT relax it before reading section C.
//
// NOTHING IS WRITTEN. One connection, SELECTs only, no DDL, no transaction.
// The rewrite is NOT attempted here, not even in a rolled-back transaction.
//
// RE-RUN: idempotent and side-effect free. Run it as often as you like.
//
//   node backend/scripts/why-0301-refuses.mjs
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('DATABASE_URL missing'); process.exit(1); }

const VIEW = 'scm.mfg_sales_orders_with_payment_totals';
const CLAMPED =
  'GREATEST(so.local_total_centi - COALESCE(p.paid_total, 0::bigint), 0::bigint) AS balance_centi_live';
const UNCLAMPED =
  '(so.local_total_centi - COALESCE(p.paid_total, 0::bigint)) AS balance_centi_live';

const sql = postgres(DSN, { ssl: 'require', max: 1, idle_timeout: 20, connect_timeout: 60 });
const notice = (m) => console.log(`::notice::${m}`);

async function main() {
  notice('why 0301 refuses its own rewrite — READ ONLY, nothing is written');

  /* A — does the view still carry the floor? 0301 rolls back on its own
     exception, so the expected answer is yes; anything else means someone has
     already changed it by hand and the migration needs re-thinking, not
     re-running. */
  console.log('');
  notice('A — the deployed definition, exactly as the catalogue returns it');
  const [row] = await sql`SELECT pg_get_viewdef(${VIEW}::regclass, true) AS def`;
  if (!row) { notice(`  ${VIEW} does not exist`); return; }
  const def = row.def;
  console.log(def);

  console.log('');
  notice(`  clamped literal present:   ${def.includes(CLAMPED)}`);
  notice(`  unclamped literal present: ${def.includes(UNCLAMPED)}`);
  notice('  clamped=true means 0301 gets past its first gate and the substitution DOES produce a string');
  notice('  clamped=false AND unclamped=false means the view is a shape 0301 was not written against');

  /* B — the substitution 0301 would perform, printed but NOT executed, so the
     exact text the post-condition is hoping to read back is on the record. */
  console.log('');
  notice('B — what 0301 would send to CREATE OR REPLACE (not executed here)');
  if (def.includes(CLAMPED)) {
    const next = def.replace(CLAMPED, UNCLAMPED);
    const line = next.split('\n').find((l) => l.includes('balance_centi_live'));
    notice(`  the rewritten select-list item: ${line ? line.trim() : '(not found)'}`);
    notice('  the post-condition then demands this exact substring back from pg_get_viewdef:');
    notice(`    ${UNCLAMPED}`);
  } else {
    notice('  skipped — the clamped literal is not present, so 0301 raises its "refusing to guess" error instead');
  }

  /* C — THE DECIDING EVIDENCE. How does THIS server's deparser render a
     top-level aliased arithmetic expression? Sampled from views that already
     exist, so no DDL is needed to find out. If none of them keep redundant
     outer parentheses, the post-condition is unsatisfiable by construction. */
  console.log('');
  notice('C — how this server deparses aliased arithmetic in existing views');
  const views = await sql`
    SELECT schemaname || '.' || viewname AS name, definition
    FROM pg_views
    WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
    ORDER BY schemaname, viewname`;
  notice(`  scanned ${views.length} view(s)`);

  /* A select-list item is one line in the deparser's pretty output. Aliased
     arithmetic is an operator followed by AS on that same line. */
  const withParens = [];
  const withoutParens = [];
  for (const v of views) {
    for (const raw of String(v.definition).split('\n')) {
      const line = raw.trim().replace(/,$/, '');
      if (!/\sAS\s+[a-z_][a-z0-9_]*$/i.test(line)) continue;
      if (!/[a-z0-9_)]\s[-+*/]\s[a-z0-9_(]/i.test(line)) continue;
      (/^\(.*\)\s+AS\s+[a-z_][a-z0-9_]*$/i.test(line) ? withParens : withoutParens)
        .push(`${v.name}: ${line}`);
    }
  }

  notice(`  aliased arithmetic WRAPPED in redundant parentheses: ${withParens.length}`);
  for (const s of withParens.slice(0, 12)) console.log(`      ${s}`);
  notice(`  aliased arithmetic with NO wrapping parentheses:     ${withoutParens.length}`);
  for (const s of withoutParens.slice(0, 12)) console.log(`      ${s}`);

  console.log('');
  notice('READ THE RESULT LIKE THIS:');
  notice('  WRAPPED = 0 and NO-WRAPPING > 0 -> the deparser strips the outer parens.');
  notice('    The post-condition can never match, the rewrite itself is fine, and the');
  notice('    correct fix is a post-condition that asserts the FLOOR IS GONE rather than');
  notice('    matching one hand-written spelling of what replaced it.');
  notice('  WRAPPED > 0 -> hypothesis REFUTED. The deparser does keep them, so the');
  notice('    rewrite is genuinely not applying and relaxing the check would ship a');
  notice('    still-floored view. Find the real reason before touching 0301.');
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => sql.end({ timeout: 5 }));
