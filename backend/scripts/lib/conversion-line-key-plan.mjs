/* conversion-line-key-plan — the PURE rule that gives a delivery order or goods
 * receipt line the AutoCount line key the book itself pairs it with.
 *
 * 白话. 我们开的 DO / GR 进了 AutoCount，但 ERP 没记下「这一行是账本里的哪一行」，
 * 下次一改整张就被拦。账本的 DocTransfer 表写着每一行是从 SO / PO 的哪一行转过来的；
 * 我们这边每一行也知道自己是从哪一行来的。两边的「来源行」一对，就知道是账本的哪一行，
 * 不用猜。对不上、或者账本里一个来源行出现在两行上的，就留空并列出来。
 *
 * ── WHY THE DRAIN COULD NOT DO THIS ────────────────────────────────────────
 * After a conversion the host returns the new document's lines as DtlKey,
 * ItemCode and Desc2 (AcSyncService.cs `CreatedLines`) — no source line. The
 * drain then compared AutoCount's ItemCode with the ERP's own code, and a
 * conversion copies the SOURCE line's code, which for a supplier-coded product
 * is not ours ('AK-BASTION MATT (Q)' in the book, 'AKEMI BASTION MATT (Q)'
 * here). So it refused, correctly, rather than store a key it could not prove,
 * and the document stayed keyless (docs/bugs/0897).
 *
 * ── THE FACT IT STANDS ON ──────────────────────────────────────────────────
 * `DocTransfer` names, for every line a transfer created, the one source line
 * it came from (`ToDocDtlKey` -> `FromDocDtlKey`). Measured on the live book
 * 2026-09-14 over the ERP-numbered documents: 105 delivery orders, 459 lines,
 * every line with exactly one transfer row and no source line feeding two
 * lines of one document; 73 goods receipts, 206 lines, one line with no
 * transfer row and one source line feeding two lines. The ERP row knows its
 * source too: `delivery_order_items.so_item_id` / `grn_items.purchase_order_item_id`,
 * whose row carries that line's AutoCount key.
 *
 * So the pairing is by SOURCE KEY inside ONE document, never by position or item
 * code. Several ERP rows may share one source key — a sofa is one book line and
 * one row per piece here — and they all take the same book line, which is the
 * documented shape (docs/modules/autocount-writeback.md, "Several ERP lines can
 * share ONE book line").
 *
 * PURE. No filesystem, no database, no clock, no printing.
 * NO SHEBANG: a test imports this module.
 */

export const KEY_OUTCOMES = Object.freeze([
  /* the row has no key, its source key names exactly one line of this document
     in the book — the write */
  "stamp",
  /* the row already carries the key the book pairs it with */
  "already_correct",
  /* the row carries a DIFFERENT key from the one the book pairs it with —
     reported, never overwritten */
  "disagrees",
  /* the row points at no source line, or its source line has no AutoCount key
     (an ad-hoc line, a free gift added on the receipt) */
  "no_source_key",
  /* the source key names no line of this document in the book */
  "source_not_in_book",
  /* the source key names two or more lines of this document — refused */
  "ambiguous_in_book",
]);

export const IS_WRITE = Object.freeze(new Set(["stamp"]));
export const IS_REFUSAL = Object.freeze(new Set(["disagrees", "source_not_in_book", "ambiguous_in_book"]));

const keyOf = (v) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * @param {Array<{ id: string, linkedKey: unknown, sourceKey: unknown }>} rows
 *   the ERP rows of ONE delivery order or goods receipt
 * @param {Array<{ toDtlKey: unknown, fromDtlKey: unknown }>} bookLines
 *   that SAME document's lines in the book, each with its DocTransfer source
 * @returns {{ rows: Array<{ id: string, outcome: string, dtlKey: number | null, sourceKey: number | null }>, unclaimedBookLines: number[] }}
 */
export function planDocumentKeys(rows, bookLines) {
  const targetsBySource = new Map();
  for (const b of bookLines) {
    const from = keyOf(b.fromDtlKey);
    const to = keyOf(b.toDtlKey);
    if (from == null || to == null) continue;
    const set = targetsBySource.get(from) ?? new Set();
    set.add(to);
    targetsBySource.set(from, set);
  }

  const claimed = new Set();
  const out = [];
  for (const r of rows) {
    const sourceKey = keyOf(r.sourceKey);
    const linked = keyOf(r.linkedKey);
    if (sourceKey == null) {
      out.push({ id: r.id, outcome: "no_source_key", dtlKey: null, sourceKey: null });
      continue;
    }
    const targets = targetsBySource.get(sourceKey);
    if (!targets || targets.size === 0) {
      out.push({ id: r.id, outcome: "source_not_in_book", dtlKey: null, sourceKey });
      continue;
    }
    if (targets.size > 1) {
      out.push({ id: r.id, outcome: "ambiguous_in_book", dtlKey: null, sourceKey });
      continue;
    }
    const [to] = targets;
    claimed.add(to);
    if (linked == null) out.push({ id: r.id, outcome: "stamp", dtlKey: to, sourceKey });
    else if (linked === to) out.push({ id: r.id, outcome: "already_correct", dtlKey: to, sourceKey });
    else out.push({ id: r.id, outcome: "disagrees", dtlKey: to, sourceKey });
  }

  const unclaimedBookLines = [];
  for (const b of bookLines) {
    const to = keyOf(b.toDtlKey);
    if (to != null && !claimed.has(to)) unclaimedBookLines.push(to);
  }
  return { rows: out, unclaimedBookLines };
}

/** Counts per outcome, every declared outcome present. */
export function tallyOutcomes(planned) {
  const t = Object.fromEntries(KEY_OUTCOMES.map((o) => [o, 0]));
  for (const p of planned) t[p.outcome] = (t[p.outcome] ?? 0) + 1;
  return t;
}

function selfTestCases() {
  const book = [
    { toDtlKey: 930287, fromDtlKey: 758395 },
    { toDtlKey: 930289, fromDtlKey: 758396 },
  ];
  return [
    { name: "a keyless row takes the line its source feeds", rows: [{ id: "a", linkedKey: null, sourceKey: 758395 }], book, want: ["stamp"] },
    { name: "sofa pieces sharing one source take one line", rows: [{ id: "a", linkedKey: null, sourceKey: 758395 }, { id: "b", linkedKey: null, sourceKey: 758395 }], book, want: ["stamp", "stamp"] },
    { name: "a row already on the right line is left", rows: [{ id: "a", linkedKey: 930289, sourceKey: 758396 }], book, want: ["already_correct"] },
    { name: "a row on another line is reported, not overwritten", rows: [{ id: "a", linkedKey: 930287, sourceKey: 758396 }], book, want: ["disagrees"] },
    { name: "no source key, nothing to pair", rows: [{ id: "a", linkedKey: null, sourceKey: null }], book, want: ["no_source_key"] },
    { name: "a source the document does not hold", rows: [{ id: "a", linkedKey: null, sourceKey: 1 }], book, want: ["source_not_in_book"] },
    { name: "one source on two lines refuses", rows: [{ id: "a", linkedKey: null, sourceKey: 758395 }], book: [...book, { toDtlKey: 930290, fromDtlKey: 758395 }], want: ["ambiguous_in_book"] },
  ];
}

/** Run before a row is read; a non-empty answer means the rule is broken. */
export function runSelfTest() {
  const failures = [];
  for (const c of selfTestCases()) {
    const got = planDocumentKeys(c.rows, c.book).rows.map((r) => r.outcome);
    if (JSON.stringify(got) !== JSON.stringify(c.want)) failures.push(`${c.name}: wanted ${c.want.join(",")}, got ${got.join(",")}`);
  }
  for (const o of [...IS_WRITE, ...IS_REFUSAL]) {
    if (!KEY_OUTCOMES.includes(o)) failures.push(`${o} is classified but is not a declared outcome`);
  }
  return failures;
}
