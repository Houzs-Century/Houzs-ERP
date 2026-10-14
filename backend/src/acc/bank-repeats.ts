// ----------------------------------------------------------------------------
// bank-repeats — the same bank movement arriving on a second file of the same
// account (owner 2026-10-14, 2990's Hong Leong September: 「B，做」).
//
// The owner reconciles every few days and again at month end (2026-09-08), so a
// month's movements arrive twice: on the any-day export and on the month-end
// statement. The upload has always left out a movement an earlier file already
// recorded, by its day, its amount and its words (acc/bank-parse.ts
// movementWords). Hong Leong's month-end CSV prints the same movement with MORE
// words: "Cr Adv-Interbank GIRO at KLM" where the export says "Cr Adv-Interbank
// GIRO", and a transfer's reference gains its DuitNow id
// (20260902HLBBMYKL010OCB90268183). Equal words missed 42 of September's 65
// movements; they came in again as still to decide and broke the month's tally.
//
// So two prints are ONE movement when the day and the amount agree and either
// print's words all appear in the other — the longer file adds, it never drops
// what the shorter said. Containment needs at least two words on the shorter
// side; a print with fewer pairs only on equal words. Paired one to one, in the
// incoming file's order, an exact pair before a containment one: two identical
// transfers on one day are two movements, and a file carrying one more of them
// than an earlier one contributes exactly that one. A line already filed as a
// repeat is a copy, not a movement, and never stands as an earlier print.
// ----------------------------------------------------------------------------

import { movementWords } from './bank-parse';

export type PrintedMovement = { bookedOn: string; amountSen: number; description: string; reference: string | null };
/** A movement already recorded, and the words that say where (its entry, or its file). */
export type EarlierPrint = PrintedMovement & { where: string };

/** The kind a repeat is filed under (migration 0336, acc_bank_line_kind). */
export const REPEAT_KIND = 'DUPLICATE';

/** What a repeat's line says — one sentence for the upload and for the repair. */
export const repeatNote = (where: string): string =>
  `This movement is already recorded — ${where} on a statement uploaded earlier. Leave it out unless the bank really paid twice.`;

/** Containment needs at least this many words on the shorter print. */
const MIN_WORDS_TO_CONTAIN = 2;

const keyOf = (m: { bookedOn: string; amountSen: number }): string => `${String(m.bookedOn).slice(0, 10)}|${Number(m.amountSen)}`;
const holdsAll = (big: ReadonlySet<string>, small: ReadonlySet<string>): boolean => [...small].every((w) => big.has(w));
const sameWords = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => a.size === b.size && holdsAll(a, b);

/** Two prints of one day and amount say the same movement: equal words, or one's all inside the other's. */
export const samePrint = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => {
  if (sameWords(a, b)) return true;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  return small.size >= MIN_WORDS_TO_CONTAIN && holdsAll(big, small);
};

/**
 * For each incoming movement, in order: where it was recorded before — the
 * `where` of the earlier print it repeats — or null when it is new. Each
 * earlier print answers at most one incoming movement.
 */
export function pairRepeats(earlier: readonly EarlierPrint[], incoming: readonly PrintedMovement[]): Array<string | null> {
  const pools = new Map<string, Array<{ words: Set<string>; where: string; used: boolean }>>();
  for (const e of earlier) {
    const k = keyOf(e);
    const pool = pools.get(k) ?? [];
    pool.push({ words: movementWords(e), where: e.where, used: false });
    pools.set(k, pool);
  }
  return incoming.map((m) => {
    const pool = pools.get(keyOf(m));
    if (!pool) return null;
    const words = movementWords(m);
    const hit = pool.find((p) => !p.used && sameWords(p.words, words))
      ?? pool.find((p) => !p.used && samePrint(p.words, words));
    if (!hit) return null;
    hit.used = true;
    return hit.where;
  });
}

/** A bank line as the repair reads it; `where` names it as an earlier print. */
export type LineForRepeats = PrintedMovement & { id: number; statementId: number; lineNo: number; state: string; kind: string; where: string };

/** An acc_bank_statement_lines row, read for the rule. */
export const lineForRepeats = (r: Record<string, unknown>, where: string): LineForRepeats => ({
  id: Number(r.id), statementId: Number(r.statement_id), lineNo: Number(r.line_no ?? 0),
  bookedOn: String(r.booked_on ?? '').slice(0, 10), amountSen: Number(r.amount_sen ?? 0),
  description: String(r.description ?? ''), reference: typeof r.reference === 'string' ? r.reference : null,
  state: String(r.state ?? ''), kind: String(r.kind ?? ''), where,
});

/**
 * The upload's rule applied to files already in: every OPEN line that repeats
 * a movement on a statement of the same account uploaded BEFORE its own (a
 * lower id). Statements are taken in upload order; a line found to be a repeat
 * is a copy, so it is never offered to a later file as an earlier print.
 * Returns line id → where the movement was recorded before.
 */
export function repeatsAmong(lines: readonly LineForRepeats[]): Map<number, string> {
  const out = new Map<number, string>();
  const pool: EarlierPrint[] = [];
  const statementIds = [...new Set(lines.map((l) => l.statementId))].sort((a, b) => a - b);
  for (const sid of statementIds) {
    const mine = lines.filter((l) => l.statementId === sid).sort((a, b) => a.lineNo - b.lineNo || a.id - b.id);
    const asked = mine.filter((l) => l.state === 'OPEN' && l.kind !== REPEAT_KIND);
    pairRepeats(pool, asked).forEach((where, i) => { if (where != null) out.set(asked[i]!.id, where); });
    for (const l of mine) if (l.kind !== REPEAT_KIND && !out.has(l.id)) pool.push(l);
  }
  return out;
}
