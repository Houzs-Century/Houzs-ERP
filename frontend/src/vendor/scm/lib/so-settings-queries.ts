
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { writeFailedAs } from './mutation-error';

export type SoSetting = { key: string; enabled: boolean; label: string; updated_at?: string | null };

/** "Venue differs" on a scanned order refuses Confirm while ON (owner
 *  2026-10-19). Owner or Finance only; the backend enforces and logs it. */
export const VENUE_DIFFERS_BLOCKS_KEY = 'fair_venue_differs_blocks';

export function useSoSettings() {
  return useQuery({
    queryKey: ['so-settings'],
    queryFn: () => authedFetch<{ settings: SoSetting[] }>('/so-settings').then((r) => r.settings),
    staleTime: 30_000,
  });
}

export function useSetSoSetting() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key, enabled }: { key: string; enabled: boolean }) =>
      authedFetch<{ setting: SoSetting }>(`/so-settings/${encodeURIComponent(key)}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['so-settings'] }); },
    onError: writeFailedAs('Fair rule not changed'),
  });
}
