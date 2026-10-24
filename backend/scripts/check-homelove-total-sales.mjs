#!/usr/bin/env node
// check-homelove-total-sales.mjs — READ ONLY. Owner's Event Commission screenshot
// (2026-10-24) shows Total sales RM 165,034.00 for both [AKEMI] HOMELOVE (UOB)
// @ MID VALLEY 10/15-10/18 and [AKEMI] MYHOME @ SUNWAY PYRAMID 10/16-10/18.
// Is the HOMELOVE (UOB) event page's Total Sales box a copy of MYHOME's? Prints
// both projects' typed Total Sales and their orders' goods. Writes nothing.
// Env: DATABASE_URL.
import postgres from 'postgres';

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  try {
    const ps = await sql`SELECT p.id, p.name, p.brand, p.start_date, p.end_date, pf.total_sales
      FROM public.projects p LEFT JOIN public.project_finance pf ON pf.project_id = p.id
      WHERE p.company_id = 1 AND p.start_date BETWEEN '2026-10-14' AND '2026-10-17'
        AND (p.name ILIKE '%HOMELOVE%' OR p.name ILIKE '%MYHOME%')
      ORDER BY p.start_date, p.name`;
    for (const p of ps) {
      const [g] = await sql`SELECT count(*)::int AS n,
          coalesce(sum(mattress_sofa_sen + bedframe_sen + accessories_sen + others_sen), 0)::bigint AS goods,
          coalesce(sum(local_total_sen), 0)::bigint AS total
        FROM scm.mfg_sales_orders WHERE project_id = ${p.id} AND status::text NOT IN ('CANCELLED', 'DRAFT')`;
      console.log(`ROW|#${p.id} ${p.name} ${new Date(p.start_date).toISOString().slice(0, 10)}: typed Total Sales ${p.total_sales ?? '-'}; orders ${g.n}, goods RM ${(Number(g.goods) / 100).toFixed(2)}, SO total RM ${(Number(g.total) / 100).toFixed(2)}`);
    }
  } finally { await sql.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
