// ---------------------------------------------------------------------------
// align-sofa-piece-columns — after anything moves a sofa line's `item_code`,
// every OTHER column on that row that states a piece must move with it.
//
// WHY THIS EXISTS AS A CALLABLE STEP. Three writers change a sofa line's code —
// the compartment-corrections applier, the in-place rename tool, and the sweep
// that cleans up after both — and each one learned about a different subset of
// the sibling columns, months apart:
//
//   `item_code` only ................ every writer, from the start
//   + the printed name .............. taught 2026-09-11 (docs/bugs/0818),
//                                     after the owner found a PO printing a
//                                     lounger's name beside an arm's code
//   + `supplier_sku` ................ taught 2026-09-11 (docs/bugs/0822), after
//                                     he found HC-PO-2609-053 telling the
//                                     factory to build the other end piece
//
// A subset per writer is the shape this repo keeps paying for, so the answer is
// not a third list: it is ONE step both writers call with the row they just
// changed. A new sibling column is then added here once.
//
// ONLY the piece token moves, and only where the column DISAGREES — see
// lib/sofa-piece-token.mjs for the rule and its self-test. A column stating no
// piece is the supplier's own product name and is left exactly as it is.
// ---------------------------------------------------------------------------
import { disagrees, movePieceTo, pieceOf } from './sofa-piece-token.mjs';

/** Every column that can state a piece beside `item_code`. Add to this list,
 *  not to a caller. */
export const PIECE_COLUMNS = ['description', 'material_name', 'supplier_sku'];

/** Which of them this table actually has. `table` is `schema.name`. */
export async function pieceColumnsOn(tx, table) {
  const [schema, name] = String(table).split('.');
  const rows = await tx.unsafe(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2 AND column_name = ANY($3)`,
    [schema, name, PIECE_COLUMNS],
  );
  const have = rows.map((r) => r.column_name);
  return PIECE_COLUMNS.filter((c) => have.includes(c));
}

/**
 * Move the piece token in every column of this row that disagrees with its own
 * `item_code`.
 *
 * Returns what it wrote, so a caller can log it — `[{ col, from, to }]`, empty
 * when the row already agreed.
 *
 * Each write carries the OLD value in its WHERE, so a row somebody edited
 * between the read and the write is left alone rather than overwritten from a
 * stale reading.
 */
export async function alignPieceColumns(tx, table, rowId, columns) {
  if (columns.length === 0) return [];
  const sel = columns.map((c) => `"${c}"`).join(', ');
  const rows = await tx.unsafe(
    `SELECT item_code, ${sel} FROM ${table} WHERE id = $1`, [rowId],
  );
  const row = rows[0];
  if (!row) return [];
  const piece = pieceOf(row.item_code);
  const wrote = [];
  for (const col of columns) {
    const from = row[col];
    if (!disagrees(row.item_code, from)) continue;
    const to = movePieceTo(from, piece);
    const res = await tx.unsafe(
      `UPDATE ${table} SET "${col}" = $1 WHERE id = $2 AND "${col}" = $3`,
      [to, rowId, from],
    );
    if (Number(res.count ?? 0) === 1) wrote.push({ col, from, to });
  }
  return wrote;
}
