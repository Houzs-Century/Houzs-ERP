/** Start a read now, await it later (HC-0006 speed). Awaiting the returned promise still
 *  rejects as before; the no-op catch only stops an "unhandled rejection" when an earlier
 *  `return` means the caller never awaits it. */
export function startEarly<T>(p: Promise<T>): Promise<T> {
  p.catch(() => {});
  return p;
}
