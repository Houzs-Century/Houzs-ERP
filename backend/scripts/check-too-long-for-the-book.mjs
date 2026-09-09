// The exact text of every line the account book is refusing for being too long,
// so somebody can shorten it.
//
// THE OWNER ASKED FOR THIS, twice, 2026-09-09: 「超过100字的给我处理 我cut」 and
// 「太长的全部给我 我edit」. A length is not something you can edit; the words
// are. Five documents are over on 2026-09-09 — three on a line's Further
// Description and two on a collapsed sofa build.
//
// TWO DIFFERENT STRINGS, and they are built by two different renderers, so both
// are asked the same question here rather than guessed at:
//   · an ordinary line's Desc2 is `buildVariantSummary` over the line's variants
//   · a sofa's is `composeSofaDesc2` over the whole build, after the ERP's many
//     compartment lines are folded into the one line AutoCount has
//
// IT PRINTS THE TEXT. That is the point of it and it is a deliberate exception
// to this repo's "counts and document numbers only" habit: the repository is
// public, and a build specification is going through its Actions log. It is
// scoped to the documents NAMED in DOC_NOS and prints nothing else — no
// customer, no address, no money. The same specifications already appear in the
// outbox health log today, in the refusal messages themselves.
//
// Read-only. One statement per question, no writes.
//
//   DOC_NOS=HC-SO-012312,HC-SO-007678,...   required; comma separated
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { buildVariantSummary } from '../src/scm/shared/variant-summary.ts';
import { collapseSofaLines, composeSofaDesc2, splitSofaCode, AC_DESC2_MAX } from '../src/services/autocount-sofa-collapse.ts';

const DOC_NOS = (process.env.DOC_NOS || '').split(',').map((s) => s.trim()).filter(Boolean);

function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync('.dev.vars', 'utf8').match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}

const url = resolveUrl();
if (!url) {
  console.error('DATABASE_URL not set (env var or .dev.vars). Aborting.');
  process.exit(0);
}
if (!DOC_NOS.length) {
  console.error('DOC_NOS not set. Name the documents to read, comma separated.');
  process.exit(0);
}

const pg = postgres(url, { ssl: 'require', prepare: false, max: 1 });

try {
  console.log(`AutoCount's field holds ${AC_DESC2_MAX} characters. Asking about ${DOC_NOS.length} document(s).`);

  const soNos = DOC_NOS.filter((d) => !d.includes('-PO-'));
  const poNos = DOC_NOS.filter((d) => d.includes('-PO-'));

  const soLines = soNos.length
    ? await pg`SELECT doc_no, line_no, item_code, item_group, variants, description2,
                      qty, unit_price_sen
                 FROM scm.mfg_sales_order_items
                WHERE doc_no = ANY(${soNos})
                ORDER BY doc_no, line_no`
    : [];
  const poLines = poNos.length
    ? await pg`SELECT po_number AS doc_no, line_no, item_code, item_group, variants, description2
                 FROM scm.purchase_order_items pi
                 JOIN scm.purchase_orders p ON p.id = pi.purchase_order_id
                WHERE p.po_number = ANY(${poNos})
                ORDER BY po_number, line_no`
    : [];

  /* THE ORDINARY LINES FIRST. A stored description2 wins verbatim — that is the
     echo path the write-back itself honours — so it is what gets measured when
     it is there. */
  console.log('');
  console.log('=== LINES WHOSE DESCRIPTION 2 IS OVER ===');
  let over = 0;
  for (const r of [...soLines, ...poLines]) {
    const stored = String(r.description2 ?? '').trim();
    const text = stored || buildVariantSummary(r.item_group ?? '', r.variants ?? null);
    if (text.length <= AC_DESC2_MAX) continue;
    over += 1;
    console.log('');
    console.log(`${r.doc_no}  line ${r.line_no}  ${r.item_code}`);
    console.log(`  ${text.length} characters, ${text.length - AC_DESC2_MAX} over:`);
    console.log(`  ${text}`);
  }
  if (!over) console.log('  none');

  /* THEN THE SOFAS. The over-long string here is not stored anywhere: it is what
     the collapse WOULD write, so it has to be composed to be shown. */
  console.log('');
  console.log('=== SOFA BUILDS WHOSE COLLAPSED TEXT IS OVER ===');
  let sofas = 0;
  for (const docNo of soNos) {
    /* CollapsibleLine's own field names, snake_case — the interface is in
       autocount-sofa-collapse.ts and guessing at it would silently collapse
       nothing. qty and unit_price_sen are required by the type and are not read
       by the composition, so the row's own values are passed through. */
    const lines = soLines.filter((r) => r.doc_no === docNo).map((r) => ({
      item_code: String(r.item_code ?? ''),
      item_group: r.item_group ?? null,
      description2: r.description2 ?? null,
      variants: r.variants ?? null,
      qty: Number(r.qty ?? 1),
      unit_price_sen: Number(r.unit_price_sen ?? 0),
    }));
    if (!lines.length) continue;
    let result;
    try {
      result = collapseSofaLines(lines);
    } catch (e) {
      console.log(`${docNo}: collapse threw — ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    for (const ref of result.refusals ?? []) {
      const why = String(ref.reason ?? '');
      if (!/characters/.test(why)) continue;
      sofas += 1;
      console.log('');
      console.log(`${docNo}  ${(ref.itemCodes ?? []).join(', ')}`);
      console.log(`  ${why}`);
      /* THE STRING ITSELF. The reason gives a LENGTH, and a length cannot be
         edited — the words can. Rebuilt exactly as the collapse builds it:
         the compartments in the refused lines' own order, and the size, colour
         and specials off the first of them. */
      const parts = (ref.sourceIndexes ?? []).map((i) => lines[i]).filter(Boolean);
      const comps = parts.map((l) => splitSofaCode(String(l.item_code ?? ''))?.compartment).filter(Boolean);
      const v = (parts[0]?.variants ?? {});
      if (comps.length) {
        const text = composeSofaDesc2(comps, {
          size: v.size ?? v.seatSize ?? null,
          colour: v.colourLabel ?? v.fabricCode ?? null,
          specials: Array.isArray(v.specials) ? v.specials.map(String) : [],
        });
        if (text) {
          console.log(`  what it would write (${text.length} characters):`);
          console.log(`  ${text}`);
        } else {
          console.log('  (the pieces have no spelling, so there is no text to shorten — a different problem)');
        }
      }
    }
  }
  if (!sofas) console.log('  none reported as over-length by the collapse');
} catch (e) {
  console.error('DB unreachable or query failed:', e.message);
  process.exit(1);
} finally {
  await pg.end({ timeout: 5 });
}
