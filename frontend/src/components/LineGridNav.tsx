import { useEffect } from 'react';

/** Arrow keys move between the fields of every document's line editor — see
 *  lib/lineGridNav.ts. Loaded after first paint, so it costs the initial
 *  bundle nothing (that budget is nearly spent). */
export function LineGridNav() {
  useEffect(() => {
    let uninstall: (() => void) | null = null;
    let cancelled = false;
    void import('../lib/lineGridNav').then(({ installLineGridNav }) => {
      if (!cancelled) uninstall = installLineGridNav();
    });
    return () => { cancelled = true; uninstall?.(); };
  }, []);
  return null;
}
