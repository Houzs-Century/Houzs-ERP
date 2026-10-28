// ----------------------------------------------------------------------------
// Bounded concurrency for read waves.
//
// WHY THIS EXISTS. PR #2300 made MRP correct by paging every read — the demand
// read had been silently truncated to 1000 of ~13,900 rows — and paid for it in
// latency, which its own body stated rather than discovered later: "roughly a
// dozen round trips to on the order of a hundred ... They are sequential."
//
// They did not have to be. Most of those round trips are independent of one
// another: the batches of a chunked read do not feed each other, and neither do
// the master-data reads. Sequential was how they were written, not a property
// of the problem.
//
// WHY BOUNDED rather than Promise.all over everything. The Worker reaches
// Postgres through Hyperdrive, which pools a finite number of connections. An
// unbounded fan-out over ~14 batches trades latency for pool exhaustion and
// gets SLOWER — or starts erroring under load, which is the owner's standing
// rule ("performance work must not destabilise") failing in the most expensive
// possible way. The bound is the whole point of the helper.
// ----------------------------------------------------------------------------

/**
 * Run `fn` over `items` with at most `limit` calls in flight.
 *
 * Results are returned in INPUT order, never completion order — that is what
 * makes this a drop-in for a sequential `for` loop whose results are
 * concatenated. A caller that flattens the result gets the same sequence the
 * sequential form produced, so no downstream ordering can change.
 *
 * `limit` is REQUIRED and has no default, deliberately. It decides how hard
 * this hits a shared connection pool, and CLAUDE.md's rule is that a parameter
 * which decides something is required so that forgetting it fails to compile
 * rather than silently picking someone else's answer.
 *
 * The first rejection propagates, exactly as `await` in a sequential loop would
 * — but the in-flight siblings are already awaited by their own workers, so a
 * rejection here can never surface as an unhandled rejection.
 */
export async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (limit < 1) throw new Error(`mapBounded: limit must be >= 1, got ${limit}`);
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Start a promise NOW but keep its error until it is read.
 *
 * The pattern this supports: fire several independent reads up-front so they
 * overlap, then await each at its original site so the surrounding code — and,
 * critically, the ORDER IN WHICH ERRORS SURFACE — is unchanged.
 *
 * A bare `const p = load(); ... await p` cannot do that safely. If `p` rejects
 * before anything awaits it, the runtime sees an unhandled rejection; in a
 * Worker that is a crashed request rather than the 500 the route would have
 * returned. `eager` attaches both handlers immediately, so the rejection is
 * always "handled", and re-throws it at the point of use.
 *
 * So `await eager(p)()` throws exactly what `await p` would have thrown,
 * exactly where the sequential code threw it — and the read has been running in
 * the background the whole time.
 */
export function eager<T>(promise: Promise<T>): Promise<() => T> {
  return promise.then(
    (value) => () => value,
    (err: unknown) => () => {
      throw err;
    },
  );
}
