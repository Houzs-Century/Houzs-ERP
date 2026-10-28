// ----------------------------------------------------------------------------
// Shared tiny React hooks. Anything that appears in two or more components or
// pages belongs here.
// ----------------------------------------------------------------------------

import { useEffect, useState } from 'react';

/**
 * Returns a value that lags behind `value` by `delayMs` of stillness.
 *
 * Use for inputs that drive a server query (autocomplete, search-as-you-type)
 * so a fast typist doesn't fire one request per keystroke. Pair with an
 * `enabled: q.trim().length >= N` guard on the query for the strongest effect.
 *
 * Task #99 lifted the SO Detail customer-name debounce out of
 * SalesOrderDetail.tsx; Task #102 reuses it in SoLineCard for the product
 * picker (which used to fire useMfgProducts({ search }) on every keystroke).
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), delayMs);
    return () => window.clearTimeout(t);
  }, [value, delayMs]);
  return v;
}
