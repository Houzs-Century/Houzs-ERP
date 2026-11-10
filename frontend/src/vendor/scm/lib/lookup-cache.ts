/* Lookups that almost never change (region master, state-to-region map,
   warehouses) load once and stay for hours (owner 2026-11-10). Their own
   mutations and other tabs' writes still invalidate them, which ignores
   staleTime, so an edit shows at once. */
export const LOOKUP_STALE_MS = 4 * 60 * 60_000;
export const LOOKUP_CACHE = { staleTime: LOOKUP_STALE_MS, gcTime: LOOKUP_STALE_MS } as const;
