/* hc0108-repair-plan — the decisions behind repair-hc0108-sofa-pieces-and-doubled-receipts.mjs,
 * kept free of I/O so the gates can be tested on the real production rows.
 *
 * Two shapes, both left by data rounds rather than by a user:
 *
 *   PIECE — apply-sofa-compartment-corrections (2026-09-10, run 34507126629)
 *   split a collapsed AutoCount sofa line into one PO row per piece and INSERTed
 *   the new piece at received 0 with no receipt line, although the whole set was
 *   received (and delivered) as one book line. Same defect as HC-0110.
 *
 *   DOUBLED — the 2026-08-28 receipt import attached a PO line to an unlinked
 *   receipt that the 2026-09-20 AutoCount-linked import received again, so the
 *   PO line reads two receipts for one unit ordered.
 */

const K = (s) => String(s ?? '').trim().toUpperCase();
const LIVE = (status) => !['CANCELLED', 'DRAFT'].includes(K(status));
const net = (g) => Math.max(0, Number(g.qtyAccepted ?? 0) - Number(g.returnedQty ?? 0));

/**
 * Decide one added sofa piece.
 *
 * @param e      { po, piece, source, acOnly?, so? } — the expectation read off production
 * @param lines  the PO's lines: { id, itemCode, qty, receivedQty, unitPriceSen, dtlkey, soItemId }
 * @param grns   receipt lines on those PO lines: { id, grnId, grnNumber, poItemId, status,
 *               migratedNoStock, qtyAccepted, returnedQty }
 * @returns { refused } | { piece, source, mode: 'clone', grnLine } | { piece, source, mode: 'ac-only' }
 */
export function planPiece(e, lines, grns) {
  const live = grns.filter((g) => LIVE(g.status));
  const grnOf = (id) => live.filter((g) => g.poItemId === id);
  const byCode = (code) => lines.filter((l) => K(l.itemCode) === K(code));

  const sources = byCode(e.source);
  if (sources.length !== 1) return { refused: `${e.po}: expected one ${e.source} row, found ${sources.length}` };
  const source = sources[0];
  if (!source.dtlkey) return { refused: `${e.po}: ${e.source} carries no AutoCount line key` };

  const pieces = byCode(e.piece).filter((l) => l.dtlkey === source.dtlkey);
  if (pieces.length !== 1) return { refused: `${e.po}: expected one ${e.piece} row on line key ${source.dtlkey}, found ${pieces.length}` };
  const piece = pieces[0];
  if (Number(piece.receivedQty) !== 0) return { refused: `${e.po}: ${e.piece} already reads received ${piece.receivedQty}` };
  if (Number(piece.unitPriceSen) !== 0) return { refused: `${e.po}: ${e.piece} is priced - not an added piece` };
  if (Number(piece.qty) !== Number(source.qty)) return { refused: `${e.po}: ${e.piece} qty ${piece.qty} differs from ${e.source}'s ${source.qty}` };
  if (grnOf(piece.id).length) return { refused: `${e.po}: ${e.piece} already has a receipt line` };
  if (Number(source.receivedQty) !== Number(source.qty)) {
    return { refused: `${e.po}: ${e.source} reads received ${source.receivedQty} of ${source.qty} - the set is not received` };
  }

  const srcGrn = grnOf(source.id);
  if (e.acOnly) {
    /* Received in AutoCount with no ERP receipt behind it: there is no line to
       copy, so the piece takes the same stored count its source carries. */
    if (srcGrn.length) return { refused: `${e.po}: ${e.source} has ${srcGrn.length} ERP receipt line(s) - expected none (AutoCount-only)` };
    return { piece, source, mode: 'ac-only' };
  }
  if (piece.soItemId) return { refused: `${e.po}: ${e.piece} is dedicated to an SO line - expected none` };
  if (srcGrn.length !== 1) return { refused: `${e.po}: ${e.source} has ${srcGrn.length} live receipt lines, expected 1` };
  const g = srcGrn[0];
  if (g.migratedNoStock !== true) return { refused: `${g.grnNumber} is not migrated paperwork - it moved stock` };
  if (net(g) !== Number(source.qty)) return { refused: `${g.grnNumber} received ${net(g)} against ${source.qty} on ${e.source}` };
  return { piece, source, mode: 'clone', grnLine: g };
}

/**
 * Decide the SO side of an AutoCount-only piece: the piece's SO line takes a
 * copy of the delivery-order line its source SO line shipped on.
 *
 * @param soLines  { id, docNo, itemCode, qty, cancelled }
 * @param doLines  { id, doId, doNumber, soItemId, qty, status, migratedNoStock }
 * @returns { refused } | { pieceSo, sourceSo, doLine }
 */
export function planPieceDelivery(e, plan, soLines, doLines) {
  const pieceSo = soLines.find((s) => s.id === plan.piece.soItemId);
  const sourceSo = soLines.find((s) => s.id === plan.source.soItemId);
  if (!pieceSo || !sourceSo) return { refused: `${e.po}: piece or source is not dedicated to an SO line` };
  if (pieceSo.docNo !== e.so || sourceSo.docNo !== e.so) return { refused: `${e.po}: dedicated to ${pieceSo.docNo} / ${sourceSo.docNo}, expected ${e.so}` };
  if (K(pieceSo.itemCode) !== K(e.piece)) return { refused: `${e.so}: ${e.piece} is dedicated to SO line ${pieceSo.itemCode}` };
  if (pieceSo.cancelled || sourceSo.cancelled) return { refused: `${e.so}: a line is cancelled` };
  if (Number(pieceSo.qty) !== Number(plan.piece.qty)) return { refused: `${e.so}: ${e.piece} qty ${pieceSo.qty} differs from its PO piece's ${plan.piece.qty}` };
  const live = doLines.filter((d) => K(d.status) !== 'CANCELLED');
  if (live.some((d) => d.soItemId === pieceSo.id)) return { refused: `${e.so}: ${e.piece} already has a delivery-order line` };
  const src = live.filter((d) => d.soItemId === sourceSo.id);
  if (src.length !== 1) return { refused: `${e.so}: ${e.source} is on ${src.length} delivery-order lines, expected 1` };
  const d = src[0];
  if (K(d.status) !== 'DELIVERED') return { refused: `${d.doNumber} is ${d.status}, not DELIVERED` };
  if (d.migratedNoStock !== true) return { refused: `${d.doNumber} is not migrated paperwork - it moved stock` };
  if (Number(d.qty) !== Number(plan.piece.qty)) return { refused: `${d.doNumber} shipped ${d.qty} against ${plan.piece.qty}` };
  return { pieceSo, sourceSo, doLine: d };
}

/**
 * Decide one doubled receipt: which receipt line to remove.
 *
 * @param e      { po, item, dup, keep } — the two receipt numbers read off production
 * @param poLine { id, itemCode, qty, receivedQty }
 * @param grns   every receipt line on that PO line, plus the dup receipt's other lines:
 *               { id, grnId, grnNumber, poItemId, status, migratedNoStock, linkedAcGrDocno,
 *                 createdOn, qtyAccepted, returnedQty, invoicedQty, lineTotalSen, refs }
 *               `refs` = rows elsewhere pointing at this receipt line.
 * @returns { refused } | { remove, keep }
 */
export function planDoubled(e, poLine, grns) {
  if (!poLine) return { refused: `${e.po}: no ${e.item} line` };
  if (K(poLine.itemCode) !== K(e.item)) return { refused: `${e.po}: line is ${poLine.itemCode}, expected ${e.item}` };
  const onLine = grns.filter((g) => g.poItemId === poLine.id && LIVE(g.status));
  const dups = onLine.filter((g) => g.grnNumber === e.dup);
  const keeps = onLine.filter((g) => g.grnNumber === e.keep);
  if (onLine.length !== 2 || dups.length !== 1 || keeps.length !== 1) {
    return { refused: `${e.po} ${e.item}: expected one line on ${e.dup} and one on ${e.keep}, found ${onLine.map((g) => g.grnNumber).join(', ') || 'none'}` };
  }
  const [dup] = dups; const [keep] = keeps;
  if (dup.linkedAcGrDocno) return { refused: `${e.dup} is linked to AutoCount ${dup.linkedAcGrDocno} - not the unlinked import` };
  if (dup.createdOn !== '2026-08-28') return { refused: `${e.dup} was created ${dup.createdOn}, not by the 2026-08-28 import` };
  if (dup.migratedNoStock !== true) return { refused: `${e.dup} is not migrated paperwork - it moved stock` };
  if (Number(dup.invoicedQty) || Number(dup.returnedQty)) return { refused: `${e.dup} ${e.item} is invoiced ${dup.invoicedQty} / returned ${dup.returnedQty}` };
  if (Number(dup.lineTotalSen)) return { refused: `${e.dup} ${e.item} carries RM ${Number(dup.lineTotalSen) / 100}` };
  if (Number(dup.refs)) return { refused: `${e.dup} ${e.item} is referenced by ${dup.refs} row(s) elsewhere` };
  if (!keep.linkedAcGrDocno) return { refused: `${e.keep} is not linked to AutoCount - cannot be the receipt to keep` };
  if (net(keep) !== Number(poLine.qty)) return { refused: `${e.keep} received ${net(keep)} against ${poLine.qty} ordered` };
  const dupOthers = grns.filter((g) => g.grnId === dup.grnId && g.id !== dup.id);
  if (!dupOthers.length) return { refused: `${e.dup} has no other line - removing this one would empty it` };
  return { remove: dup, keep };
}
