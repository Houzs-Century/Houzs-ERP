import { api } from "../api/client";
import { useQuery } from "./useQuery";

/**
 * Whether this environment is connected to the Houzs IT Hub.
 *
 * The IT Support menu row is listed only when this is true. Until the server
 * has said yes — still loading, the request failed, or it answered no — the
 * row stays out of the menu: a row that opens a page which can only say "not
 * connected" teaches people the feature is broken. The page itself stays
 * reachable by its address either way.
 */
export function useItSupportConnected(): boolean {
  const q = useQuery<{ connected: boolean }>(
    "/api/it-support/status",
    () => api.get<{ connected: boolean }>("/api/it-support/status"),
    [],
    { staleTime: 5 * 60_000 },
  );
  return q.data?.connected === true;
}

/** Drops the IT Support row from a list of menu rows unless IT Support is connected. */
export function withoutUnconnectedItSupport<T extends { to?: string }>(tabs: T[], connected: boolean): T[] {
  return connected ? tabs : tabs.filter((t) => t.to !== "/it-support");
}
