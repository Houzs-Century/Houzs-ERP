// ---------------------------------------------------------------------------
// mislabelled-sofa-po-plan.mjs — the PURE half of
// repair-mislabelled-sofa-po-lines.mjs.
//
// NO SHEBANG, ON PURPOSE (CLAUDE.md, "Anything a TEST imports lives in
// backend/scripts/lib/"): backend/tests/mislabelledSofaPoPlan.test.mjs imports
// this, and a `#!` in an imported .mjs is a load-time SyntaxError on Windows
// vitest.
//
// THE SHAPE THIS REPAIRS. The SO-linked purchase-order importer asked the
// product catalogue about the MAPPED code (`5540-1S`) before folding it through
// SOFA_MODEL_ALIAS (5540 -> 8030). The catalogue has never carried a 5540 code,
// so the answer was silence, the `?? "others"` underneath filed the line as
// `others`, and the sofa decomposition — which only runs on `sofa` — was skipped
// (docs/bugs/0577, the same fault on the top-up in 0686). The row was then
// written on the ALIASED placeholder `8030-1S` with NO `SOFA UNPARSED` marker,
// because nothing had failed to parse: the decoder was simply never asked.
//
// So the row looks like a genuine one-seater to every reader:
//   - import-ac-sofa-stock.mjs selects `item_group = 'sofa'` and never sees it,
//     so no stock is ever opened for the build;
//   - redecode-collapsed-sofa-lines.mjs selects `item_group = 'sofa'` AND the
//     marker, and never sees it either;
//   - the sales-order side of the same build DID decode (its lane folds the
//     alias first), so the order holds `8030-2A(LHF)` + `8030-1A(RHF)` with no
//     purchase line dedicated to either, and both read PENDING forever.
//
// Everything here is objects in, a plan or a refusal out. No filesystem, no
// database, no process.exit — the runner does the I/O and owns the verdict.
// ---------------------------------------------------------------------------

import { compartmentOf, isPlaceholderLine, pieceCodes, sameBuild } from './redecode-sofa-plan.mjs';
import { judgeCompartmentPair } from './sofa-po-so-pair.mjs';

const K = (s) => String(s ?? '').trim().toUpperCase();
const norm = (s) => K(s).replace(/\s+/g, ' ');

/** The AutoCount item the importer wrote into `supplier_sku`, or null. The
 *  importer writes the bare ItemCode (`HOK-5540 SOFA`) on a line it did not
 *  decompose and `<ItemCode> <compartment>` on one it did; either way the code
 *  is a prefix. Decided against the binding CSV's SOFA category, never against
 *  the spelling of the code (import-ac-sofa-stock.mjs, 2026-09-07: the name test
 *  could not see a fifth of the book). Longest match wins so `HOK-5540 SOFA`
 *  is not claimed by a shorter `HOK-5540` should the binding ever carry both. */
export function acSofaItemOfSku(supplierSku, sofaAcItems) {
  const sku = norm(supplierSku);
  if (!sku) return null;
  let best = null;
  for (const item of sofaAcItems ?? []) {
    const k = norm(item);
    if (!k) continue;
    if (sku === k || sku.startsWith(`${k} `)) {
      if (!best || k.length > best.length) best = k;
    }
  }
  return best;
}

/** The population, restated so the script and the test cannot state it
 *  differently: a bare `{model}-1S` purchase line that is NOT filed as sofa, whose
 *  supplier_sku names an AutoCount item the binding calls SOFA. A genuine
 *  one-seater filed as `sofa` is not one; a `-1S` on a non-sofa AutoCount item is
 *  not one either. */
export function isMislabelledSofaPoLine({ itemCode, itemGroup, supplierSku }, sofaAcItems) {
  if (!/^1S$/i.test(compartmentOf(itemCode))) return false;
  if (K(itemGroup) === 'SOFA') return false;
  return acSofaItemOfSku(supplierSku, sofaAcItems) !== null;
}

/** Whitespace-insensitive equality of two AutoCount Desc2 texts. */
export function sameText(a, b) {
  const f = (s) => String(s ?? '').replace(/\r/g, '').replace(/\s+/g, ' ').trim().toUpperCase();
  return f(a) === f(b) && f(a) !== '';
}

/**
 * What happens to ONE mislabelled purchase line.
 *
 * @param {object}   o
 * @param {object}   o.po        { doc, code, qty, soItemId, d2, model }
 * @param {object|null} o.so     the sales side the BOOK names through
 *                               PODTL.FromSODtlKey: { doc, cancelled, lines }
 *                               where lines = [{ id, code, group, remark,
 *                               cancelled, lineNo, d2, variants }], every line
 *                               carrying that same key; null when the ERP holds
 *                               no line with the key
 * @param {Array}    o.grns      the goods-receipt lines on the purchase row:
 *                               [{ doc, migrated, movements }]
 * @param {number}   o.doLines   delivery-order lines against ANY of the sales
 *                               lines
 * @param {object}   o.decoded   parseSofa() over the PURCHASE text
 * @param {Set}      o.codeSet   every product code, upper-cased
 * @param {Function} o.canonical the catalogue's own spelling of a code
 * @param {boolean}  o.allowDelivered  REQUIRED, and never optional. `false`
 *                               refuses a build whose goods have already left
 *                               the warehouse, which is the default and the
 *                               only safe answer without a person. `true` is
 *                               the owner saying, for a NAMED set of documents,
 *                               that the history is to be corrected anyway.
 *                               Written as a required parameter on purpose
 *                               (CLAUDE.md: "a parameter that DECIDES something
 *                               is required, never optional") — as `?:` every
 *                               existing caller would silently keep refusing
 *                               and the switch would apply only where somebody
 *                               remembered it.
 * @returns {{kind:'refuse', why:string} | {kind:'expand', target:Array<{code:string, soItemId:string, variants:object|null}>}}
 *
 * Every gate is a refusal, never a fallback. The one thing this plan is allowed
 * to WRITE is the sales order's own compartments onto the purchase line — the
 * same build, described on the two documents the book links — and it is
 * allowed to do that only when the purchase text, read by the same decoder,
 * says the same pieces in the same order (or is the same text byte for byte).
 */
export function planMislabelledBuild({ po, so, grns, doLines, decoded, codeSet, canonical, allowDelivered }) {
  const refuse = (why) => ({ kind: 'refuse', why });
  if (!so) return refuse('the book names a sales line the ERP does not hold (no line carries that AutoCount key)');
  if (so.cancelled) return refuse(`the sales order ${so.doc} is cancelled`);
  const live = (so.lines ?? []).filter((l) => !l.cancelled).slice()
    .sort((a, b) => Number(a.lineNo ?? 0) - Number(b.lineNo ?? 0));
  if (!live.length) return refuse(`every sales line under that key on ${so.doc} is cancelled`);
  if (live.some((l) => K(l.group) !== 'SOFA')) return refuse(`the sales side on ${so.doc} is not filed as sofa (${[...new Set(live.map((l) => l.group))].join(', ')})`);
  if (live.some((l) => isPlaceholderLine({ itemCode: l.code, remark: l.remark }) || /^1S$/i.test(compartmentOf(l.code)) && /SOFA UNPARSED/.test(String(l.remark ?? '')))) {
    return refuse(`the sales side on ${so.doc} is itself a placeholder — redecode-collapsed-sofa-lines.mjs owns that shape`);
  }
  const soCodes = live.map((l) => String(l.code).trim());
  const unminted = soCodes.filter((c) => !codeSet.has(K(c)));
  if (unminted.length) return refuse(`a piece SKU is not minted: ${unminted.join(', ')}`);
  if (Number(po.qty) !== 1) return refuse(`the purchase line orders ${po.qty}, not one build`);
  if (po.soItemId && !live.some((l) => l.id === po.soItemId)) return refuse(`the purchase line is already dedicated to a line that is not under this key`);
  /* THE GOODS HAVE ALREADY SHIPPED. Refusing is the default and stays the
     default: re-describing a build that a delivery note already states is a
     change to history, and nothing in a script may decide that on its own.

     The owner authorised it for these five on 2026-09-09, told plainly what it
     does and does not touch — no money, no stock, no delivery line moves; the
     purchase row stops saying "one single seater" and says the four pieces the
     sales order already says. His standing rule is the reason: 「已经出货了的单
     金额不用追，可是还是要确保 transaction flow 的数据是一样的」 — the figures on a
     delivered order do not need chasing, but the document CHAIN does.

     `allowDelivered` is REQUIRED, never optional, so this decision cannot be
     inherited by silence. */
  if (Number(doLines) > 0 && !allowDelivered) return refuse(`${doLines} delivery-order line(s) already state this build on ${so.doc}`);
  const real = (grns ?? []).filter((g) => !g.migrated || Number(g.movements) > 0);
  if (real.length) return refuse(`goods-receipt line(s) really moved stock (${real.map((g) => g.doc).join(', ')}) — splitting those needs a compensating movement, not a re-code`);

  const readable = decoded && Array.isArray(decoded.pieces) && decoded.pieces.length > 0 && decoded.conf !== 'low';
  let poCodes;
  if (readable) {
    poCodes = pieceCodes(po.model, decoded.pieces).map((c) => (canonical ? canonical(c) : c));
    /* ORDER MATTERS here, on top of the multiset the shared judge compares: the
       piece list is the sofa read left to right, so the mirrored build is a
       different sofa and needs the drawing (redecode-sofa-plan's sameBuild). */
    if (!sameBuild(poCodes, soCodes)) {
      return refuse(`the purchase text decodes to ${poCodes.join('+')} where ${so.doc} holds ${soCodes.join('+')}`);
    }
  } else if (sameText(po.d2, live[0].d2)) {
    poCodes = soCodes;
  } else {
    return refuse(`the purchase text does not decode and is not the same text as ${so.doc}'s — nothing says they are one build`);
  }

  /* The dedication is the ONE pairing vocabulary every tool on this edge shares
     (docs/modules/purchase-order.md: "do not write a fourth"). The pieces this
     plan will write stand in for the purchase rows; a compartment that repeats
     on either side is the coin flip that judge refuses. */
  const verdict = judgeCompartmentPair(poCodes.map((c) => ({ item_code: c })), live, (r) => r.item_code ?? r.code);
  if (verdict.verdict !== 'provable') return refuse(`${so.doc}: ${verdict.why}`);

  return {
    kind: 'expand',
    target: verdict.pairs.map(({ po: p, so: s }) => ({ code: String(p.item_code).trim(), soItemId: s.id, variants: s.variants ?? null })),
  };
}
