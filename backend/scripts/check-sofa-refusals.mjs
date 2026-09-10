// WHY each still-refused sofa cannot be written, and what WOULD let it through.
//
// The owner asked on 2026-09-10, after the Description-2 class was cleared:
// 「看下是不是全部都有解决办法了额」 — is there a way out for every one of them.
// A refusal message says what the composer could not do; it does not say whether
// anything could. This asks the second question.
//
// FOR EACH REFUSED SOFA RUN it prints the shape the composer is working with —
// the model, the compartment list, the seat size, how many special orders — and
// then TRIES the spellings that are currently withheld, handing each to the same
// `decodesTo` gate the write-back uses. A spelling that round-trips is a fix
// somebody can ship; one that does not is a document that needs a person.
//
// IT PROVES NOTHING BY READING. Every verdict here is the real decoder's answer
// to a real string, which is the only thing that settles whether a spelling is
// safe (docs/bugs: `3S` decodes to [3S] bare and to [2A(LHF), 1A(RHF)] with a
// size, and a probe on the wrong shape answered three questions wrongly).
//
// THE LOG IS PUBLIC. Model codes, compartment tokens, seat sizes, counts and
// document numbers only — no customer, no colour text, no special-order text,
// no money.
//
// Read-only. One SELECT.
//
//   DOC_NOS=HC-SO-000814,HC-SO-001112,...   required; comma separated
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { collapseSofaLines, composeSofaDesc2, decodesTo, splitSofaCode } from '../src/services/autocount-sofa-collapse.ts';

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

/* The spellings the composer withholds today, each paired with the reason it is
   withheld. Every one is TRIED against the real gate rather than argued about. */
const WITHHELD = {
  '3S': '3S',
  CNR: 'C',
  'CONSOLE': 'CT',
  '1A(LHF)': '1EL',
  '1A(RHF)': '1ER',
  '2A(LHF)': '2EL',
  '2A(RHF)': '2ER',
};

try {
  const rows = await pg`SELECT doc_no, id, item_code, item_group, variants, description,
                               description2, qty, unit_price_sen, linked_ac_dtlkey,
                               warehouse_id, line_delivery_date
                          FROM scm.mfg_sales_order_items
                         WHERE doc_no = ANY(${DOC_NOS})
                         ORDER BY doc_no, created_at, id`;

  const byDoc = new Map();
  for (const r of rows) {
    if (!byDoc.has(r.doc_no)) byDoc.set(r.doc_no, []);
    byDoc.get(r.doc_no).push(r);
  }

  console.log(`Asking about ${DOC_NOS.length} document(s); ${byDoc.size} of them have lines.`);
  let solvable = 0;
  let needsAPerson = 0;

  for (const doc of DOC_NOS) {
    const lines = byDoc.get(doc) ?? [];
    console.log('');
    console.log(`== ${doc} ==`);
    if (!lines.length) { console.log('   no lines read — nothing to say'); continue; }

    const res = collapseSofaLines(lines);
    if (!res.refusals.length) {
      console.log('   NO REFUSAL any more — this document composes today.');
      solvable += 1;
      continue;
    }

    for (const ref of res.refusals) {
      const codes = ref.itemCodes ?? [];
      const comps = codes.map((c) => splitSofaCode(String(c))?.compartment ?? String(c));
      const model = splitSofaCode(String(codes[0] ?? ''))?.model ?? '?';
      const first = lines.find((l) => String(l.item_code) === String(codes[0]));
      const v = (first?.variants ?? {});
      const sizeRaw = v.seatHeight != null ? String(v.seatHeight).trim() : null;
      const size = sizeRaw ? sizeRaw.replace(/["']+$/, '') : null;
      const specials = Array.isArray(v.specials) ? v.specials.length : 0;

      console.log(`   model ${model}  build [${comps.join(', ')}]  seat size ${size ?? 'NONE'}  ${specials} special order(s)`);
      /* THE BOOK'S OWN ANSWER to "which ERP lines are one line there": a sofa is
         ONE line in AutoCount and several here, and every piece carries that one
         line's DtlKey. If a refused run's pieces share a key with lines the run
         does NOT contain, the run was formed by ADJACENCY when the key already
         said which lines belong together. */
      const keys = new Set(codes.map((c) => lines.find((l) => String(l.item_code) === String(c))?.linked_ac_dtlkey).filter((k) => k != null).map(String));
      const elsewhere = lines.filter((l) => keys.has(String(l.linked_ac_dtlkey)) && !codes.includes(String(l.item_code)));
      console.log(`   DtlKey on this run: ${keys.size ? [...keys].join(', ') : 'NONE'}` +
        (elsewhere.length ? `  -- ${elsewhere.length} OTHER line(s) here share it: ${elsewhere.map((l) => splitSofaCode(String(l.item_code))?.compartment ?? l.item_code).join(', ')}` : ''));
      console.log(`   refused: ${String(ref.reason).slice(0, 150)}`);

      /* WOULD A WITHHELD SPELLING WORK? Composed with the compartments as they
         are, substituting the withheld token for the piece that has none, and
         handed to the same gate the write-back uses. */
      const missing = comps.filter((c) => WITHHELD[c.toUpperCase()] !== undefined);
      const canText = comps.map((c) => WITHHELD[c.toUpperCase()] ?? null);
      let verdict = 'NO SPELLING TRIED — the refusal is not about a missing token';
      if (missing.length) {
        const toks = comps.map((c, i) => canText[i] ?? tokenGuess(c, i, comps.length));
        if (toks.every(Boolean)) {
          for (const trySize of [size, null]) {
            const text = trySize ? `${toks.join(' + ')} (${trySize}")` : toks.join(' + ');
            const g = decodesTo(text, model, comps, { size: trySize, colour: null, specials: [] });
            if (g.ok) { verdict = `WOULD WORK as "${text}"${trySize === size ? '' : '  — only WITHOUT the seat size'}`; break; }
            verdict = `no: "${text}" -> ${String(g.why).slice(0, 90)}`;
          }
        }
      }
      console.log(`   ${verdict}`);
      if (verdict.startsWith('WOULD WORK')) solvable += 1; else needsAPerson += 1;
    }
  }

  console.log('');
  console.log(`VERDICT — ${solvable} refusal(s) a spelling would clear, ${needsAPerson} that need a person.`);
} finally {
  await pg.end({ timeout: 5 });
}

/* The tokens the composer already writes, so a run that mixes a withheld piece
   with ordinary ones can still be spelled whole. Deliberately a SMALL copy: this
   probe proposes, it never writes, and importing the private tokenFor would tie
   a diagnostic to an internal shape. */
function tokenGuess(comp, i, n) {
  const c = String(comp).toUpperCase();
  const left = i === 0;
  const map = {
    '1S': '1S', '2S': '2S', '1NA': '1NA', '2NA': '2NA', STOOL: 'STOOL', CONSOLE: 'CT',
    'L(LHF)': left ? 'L' : 'LL', 'L(RHF)': left ? 'LR' : 'L',
    '1A(LHF)': '1EL', '1A(RHF)': '1ER', '2A(LHF)': '2EL', '2A(RHF)': '2ER', CNR: 'C',
  };
  return map[c] ?? null;
}
