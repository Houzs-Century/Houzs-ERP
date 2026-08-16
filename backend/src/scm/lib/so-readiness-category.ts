// ----------------------------------------------------------------------------
// so-readiness-category — put mfg_products.category onto ReadinessLine.
//
// isServiceLine (scm/shared/service-sku.ts) calls `category` its STRONGEST
// signal: item_group is free text a POS can save as 'others', and the SVC-
// prefix only covers seeded codes. Until 2026-08-16 ReadinessLine had no field
// for it, so no caller could pass it — and a delivery fee shaped like an
// accessory counted as a short accessory that held its SO out of READY_TO_SHIP.
//
// Every rollup caller resolves it through HERE. The SO list, the Delivery
// Planning board, the delivery agent and the manual stock toggle must classify
// one line identically or they disagree about the same SO on four screens, and
// each of them had already grown its own copy of this chunked catalog read.
// ----------------------------------------------------------------------------

import { chunkIn } from './paginate-all';
import type { ReadinessLine } from './so-readiness';

type CategoryRow = { code: string; category: string | null };

/** Attach an already-resolved catalog category to every line carrying a code.
 *  Callers that built the map for another purpose — the SO list and the board
 *  both resolve it for the Branding pill — use THIS and pay no extra read. */
export function attachLineCategories(
  groups: Iterable<ReadinessLine[]>,
  categoryByCode: ReadonlyMap<string, string>,
): void {
  for (const lines of groups) {
    for (const l of lines) {
      if (l.item_code) l.category = categoryByCode.get(l.item_code) ?? null;
    }
  }
}

/** Read the catalog category for every code on `groups`, then attach it.
 *  Bounded by construction: chunked `.in` + paged (chunkIn), never a whole-table
 *  read.
 *
 *  Returns the error for the caller to BIND. Do not discard it: a failed read
 *  falls through as "none of these codes is a SERVICE", which is a wrong answer
 *  shaped exactly like a right one — the SO quietly stops being ship-able and
 *  nothing anywhere says why.
 *
 *  `scope` applies the caller's company filter. Omit it for a cross-company job
 *  (the delivery agent has no single active company): the value is only ever
 *  read as "is this SERVICE?", and a SVC- code is SERVICE in either company. */
export async function resolveLineCategories(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- supabase-js builder generics do not survive a structural narrowing; every helper in this directory takes the client this way.
  sb: any,
  groups: Iterable<ReadinessLine[]>,
  scope?: <Q>(query: Q) => Q,
): Promise<{ error: { message: string; code?: string } | null }> {
  const all = [...groups];
  const codes = [...new Set(
    all.flatMap((lines) => lines.map((l) => l.item_code)).filter((x): x is string => !!x),
  )];
  if (codes.length === 0) return { error: null };

  const { data, error } = await chunkIn<CategoryRow>(codes, (batch, from, to) => {
    /* eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- `sb` is the untyped client above. */
    const q = sb.from('mfg_products').select('code, category').in('code', batch);
    return (scope ? scope(q) : q).range(from, to) as PromiseLike<{ data: CategoryRow[] | null; error: { message: string; code?: string } | null }>;
  });
  if (error) return { error };

  const byCode = new Map<string, string>();
  for (const p of data) if (p.category) byCode.set(p.code, p.category);
  attachLineCategories(all, byCode);
  return { error: null };
}
