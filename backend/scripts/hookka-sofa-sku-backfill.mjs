#!/usr/bin/env node
/* hookka-sofa-sku-backfill.mjs — Hookka's sofa supplier codes, and what each
   change would send to the ACCOUNT BOOK.
   ===========================================================================

   PLAIN LANGUAGE (老板版):
   老板 2026-08-25:「hookka 的 9028 换 5530 / 9058 换 5536 / 8030 换 5540」、
   「之前 hookka 的 code 开错了」、「帮我 dry run backfill」。
   这支工具**预设只做预演**：印出每一笔会从什么变成什么，而且用真正的解析器算出
   AutoCount 那边会收到什么码、那个码帐本有没有。MODE=apply 才会写。

   ── WHY A SCRIPT AND NOT A DATA EDIT ─────────────────────────────────────
   `scm.supplier_material_bindings.supplier_sku` is read by TWO different
   questions (docs/bugs/0537, and the owner's own finding on 2026-08-25):

     the purchase document  — the code the supplier acts on
     the AutoCount write-back — the code the account book knows

   So a value that fixes the purchase order also changes what is written into a
   licensed account book. Editing the rows by hand answers one question and
   silently answers the other; this prints BOTH answers before anything moves.

   ── WHAT THE BOOK ACTUALLY HOLDS (measured, cutover snapshot 1561 rows,
      verified against the live AED_HOUZS Item table 2026-08-11) ───────────

     HOK-5530 SOFA / HOK-5535 / HOK-5536 / HOK-5540 / HOK-5543 …  ← Hookka
     AMN-SF9028 SOFA · DSL-9028 SOFA                              ← ARMANI / DORSETTLOFT
     AMN-SF9058     · DSL-9058
     DSL-8030 SOFA

   That is the owner's point in one line: 9028 / 9058 / 8030 were never
   Hookka's models in the book. They belong to ARMANI and DORSETTLOFT, and
   Hookka's own sofas are the HOK-55xx family.

   ── THE FORMAT IS THE OWNER'S CHOICE, and the alternative is recorded ────
   `9028-1A(LHF)` becomes `5530-1A(LHF)`: the model number swapped, nothing
   else. The alternative was the account book's own spelling — three of Hookka
   Manufacturing's rows already carry it (`5543-1S -> HOK-5543 SOFA 1S`) —
   which would have produced `HOK-5530 SOFA 1A(LHF)`. Both were rendered side
   by side on 2026-08-25 and he picked the plain swap. See proposedSku.

   ── MODES ────────────────────────────────────────────────────────────────
   MODE=plan (DEFAULT) — reads only. Prints, per binding: the ERP code, the
     supplier SKU now, what it WOULD become, and — computed with the real
     resolver — the AutoCount ItemCode before and after, plus whether the book
     is known to hold it.
   MODE=apply — requires CONFIRM="REWRITE HOOKKA SOFA SUPPLIER CODES". Updates
     supplier_sku only, one statement per row, inside a transaction, and
     re-reads on a fresh connection to assert every row landed.

   RE-RUN: idempotent. A second plan run just re-reads and prints the same table.
     A second apply finds every row already holding the new code, so nothing is
     planned, the transaction updates nothing, and the fresh-connection check
     passes trivially. It CANNOT compound: the transform reads the ERP
     `item_code`, which this script never writes, so `9028-…` always yields
     `5530-…` however many times it runs. A re-run after someone has hand-edited
     one row back rewrites just that row.
   =========================================================================== */
import postgres from 'postgres';
import { resolveAcItemCode, acItemIndex } from '../src/services/autocount-item-code.js';

const MODE = (process.env.MODE ?? 'plan').toLowerCase();
const CONFIRM = process.env.CONFIRM ?? '';
const CONFIRM_PHRASE = 'REWRITE HOOKKA SOFA SUPPLIER CODES';

/* The owner's mapping, 2026-08-25, verbatim. */
const MODEL_MAP = { '9028': '5530', '9058': '5536', '8030': '5540' };
/* Hookka's two supplier records plus OHANA (owner 2026-08-25: 「帮我把 hookka
   和 ohana 的 9028换5530 / 8030换5540 / 9058换5536」). OHANA is not an
   afterthought: the cutover snapshot records 400-O002 as the supplier against
   every HOK-55xx sofa in the book, so it holds the same mapping question.
   Named by CODE, never by id — ids differ between staging and production and
   this script must be safe to read on both. */
const SUPPLIER_CODES = ['400-H003', '400-H004', '400-O002'];

const notice = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const fail = (m) => { console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : m); process.exitCode = 1; };

const url = process.env.DATABASE_URL;
if (!url) { fail('DATABASE_URL is not set'); process.exit(1); }

/* THE MODEL NUMBER, SWAPPED, AND NOTHING ELSE.
   `9028-1A(LHF)` -> `5530-1A(LHF)`, `8030-CNR` -> `5540-CNR`.

   THE OWNER CHOSE THIS SHAPE over the other candidate, and the other candidate
   is written down because the choice was real. Three of Hookka Manufacturing's
   sofa bindings already carry the account book's own spelling —
   `5543-1S -> HOK-5543 SOFA 1S` — and following that pattern would have
   produced `HOK-5530 SOFA 1A(LHF)`, which the book would recognise. Asked which
   he wanted on 2026-08-25 with both rendered side by side, he picked the plain
   swap.

   So this is a decision, not a default, and its consequence is stated rather
   than hidden: the plain form is NOT a code the account book holds, so the plan
   below prints `[NOT in book — would be OPENED]` for every row it would change.
   That line is the whole reason the plan exists. */
function proposedSku(itemCode, newModel) {
  if (!/^\d{4}/.test(itemCode)) return null;
  return itemCode.replace(/^\d{4}/, newModel);
}

const pg = postgres(url, { max: 1, prepare: false, idle_timeout: 5, connect_timeout: 20 });
const index = acItemIndex();

try {
  notice(`mode=${MODE.toUpperCase()}${MODE === 'plan' ? ' (read-only, nothing is written)' : ''}`);

  const sups = await pg`
    SELECT id, code, name FROM scm.suppliers WHERE code = ANY(${SUPPLIER_CODES})`;
  if (!sups.length) { fail(`no supplier rows for ${SUPPLIER_CODES.join(' / ')}`); process.exit(1); }
  for (const s of sups) notice(`supplier ${s.code} — ${s.name}`);

  const prefixes = Object.keys(MODEL_MAP);
  const rows = await pg`
    SELECT b.id, b.item_code, b.supplier_sku, b.supplier_id, s.code AS supplier_code
      FROM scm.supplier_material_bindings b
      JOIN scm.suppliers s ON s.id = b.supplier_id
     WHERE s.code = ANY(${SUPPLIER_CODES})
       AND (${pg.unsafe(prefixes.map((p) => `b.item_code LIKE '${p}%'`).join(' OR '))})
     ORDER BY s.code, b.item_code`;

  notice(`=== ${rows.length} binding row(s) match ${prefixes.join(' / ')} ===`);
  if (!rows.length) { notice('nothing to do'); process.exit(0); }

  const planned = [];
  for (const r of rows) {
    const model = (r.item_code.match(/^(\d{4})/) ?? [])[1];
    const newModel = MODEL_MAP[model];
    const want = newModel ? proposedSku(r.item_code, newModel) : null;

    /* THE PART THAT MATTERS: what the account book would receive, computed by
       the SAME resolver the write-back uses — before and after. */
    const before = resolveAcItemCode(r.item_code, {
      supplierCode: r.supplier_code,
      index,
      bindings: new Map([[r.item_code.toUpperCase(), (r.supplier_sku ?? '').trim()]]),
    });
    const after = want ? resolveAcItemCode(r.item_code, {
      supplierCode: r.supplier_code,
      index,
      bindings: new Map([[r.item_code.toUpperCase(), want]]),
    }) : null;

    const say = (v) => (v == null ? '—'
      : v.ok ? `${v.acItemCode}${index.acCodes.has(v.acItemCode.toUpperCase()) ? ' [in book]' : ' [NOT in book — would be OPENED]'}`
      : `REFUSED (${v.reason}): ${v.detail}`);

    notice(`  ${r.supplier_code} ${r.item_code}`);
    notice(`      sku   ${JSON.stringify(r.supplier_sku)}  ->  ${JSON.stringify(want)}`);
    notice(`      AC    ${say(before)}`);
    notice(`      AC'   ${say(after)}`);
    if (want && want !== (r.supplier_sku ?? '')) planned.push({ id: r.id, want, itemCode: r.item_code });
  }

  notice(`=== ${planned.length} row(s) would change ===`);

  if (MODE !== 'apply') {
    notice('PLAN ONLY. Nothing was written. Re-run with MODE=apply and the confirm phrase to write.');
    process.exit(0);
  }
  if (CONFIRM !== CONFIRM_PHRASE) {
    fail(`apply refused: CONFIRM must be exactly "${CONFIRM_PHRASE}"`);
    process.exit(1);
  }

  await pg.begin(async (tx) => {
    for (const p of planned) {
      await tx`UPDATE scm.supplier_material_bindings SET supplier_sku = ${p.want} WHERE id = ${p.id}`;
    }
  });
  notice(`updated ${planned.length} row(s)`);

  /* FRESH CONNECTION, because a read inside the transaction that wrote it can
     only tell you what that transaction believes. */
  const check = postgres(url, { max: 1, prepare: false, idle_timeout: 5 });
  try {
    const back = await check`
      SELECT id, supplier_sku FROM scm.supplier_material_bindings
       WHERE id = ANY(${planned.map((p) => p.id)})`;
    const byId = new Map(back.map((b) => [b.id, b.supplier_sku]));
    const wrong = planned.filter((p) => byId.get(p.id) !== p.want);
    if (wrong.length) fail(`${wrong.length} row(s) did not land: ${wrong.map((w) => w.itemCode).join(', ')}`);
    else notice(`VERIFIED on a fresh connection: all ${planned.length} row(s) hold the new code.`);
  } finally { await check.end({ timeout: 5 }); }
} finally {
  await pg.end({ timeout: 5 });
}
