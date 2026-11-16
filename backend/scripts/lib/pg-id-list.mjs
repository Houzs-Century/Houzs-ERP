// An id list as a Postgres array literal, "{70,99,100}", cast in the query:
// `= ANY(${pgIdArray(ids)}::bigint[])`.
//
// postgres.js's sql.array() serialises by the array type the connection fetches
// with its first query. On a FRESH connection whose first query carries one, it
// went out as "70,99,100" and Postgres refused it — "malformed array literal" —
// in archive-duplicate-fair-sales-lines.mjs's re-read after its apply (run
// 43826479002, 2026-11-16), after the write had been kept. A literal string needs
// no type from the connection.

/** @param {Iterable<number | string>} ids */
export function pgIdArray(ids) {
  const list = [...ids].map((v) => Number(v));
  if (list.some((n) => !Number.isSafeInteger(n) || n <= 0)) throw new Error(`not a list of ids: ${JSON.stringify([...ids])}`);
  return `{${list.join(",")}}`;
}
