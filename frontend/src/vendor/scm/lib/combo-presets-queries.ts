
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { writeFailedAs } from './mutation-error';
import { getActiveCompanyId } from '../../../lib/activeCompany';

export type ComboPreset = { id: string; name: string; slots: string[][]; sortOrder: number; active: boolean };

const KEY = 'sofa-combo-presets';
const companyKey = (): string => String(getActiveCompanyId() ?? 'default');

export function useComboPresets() {
  return useQuery({
    queryKey: [KEY, companyKey()],
    queryFn: () => authedFetch<{ presets: ComboPreset[] }>('/sofa-combo-presets').then((r) => r.presets),
    staleTime: 30_000,
  });
}

const usePresetWrite = <T,>(title: string, write: (body: T) => Promise<unknown>) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: write,
    onSuccess: () => { void qc.invalidateQueries({ queryKey: [KEY] }); },
    onError: writeFailedAs(title),
  });
};

export const useCreateComboPreset = () =>
  usePresetWrite("Couldn't add this combo", (body: { name: string; slots: string[][] }) =>
    authedFetch('/sofa-combo-presets', { method: 'POST', body: JSON.stringify(body) }));

export const useUpdateComboPreset = () =>
  usePresetWrite("Couldn't save this combo", ({ id, ...patch }: { id: string; name?: string; slots?: string[][]; active?: boolean }) =>
    authedFetch(`/sofa-combo-presets/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }));

export const useReorderComboPresets = () =>
  usePresetWrite("Couldn't change the order", (ids: string[]) =>
    authedFetch('/sofa-combo-presets/reorder', { method: 'POST', body: JSON.stringify({ ids }) }));

export const useDeleteComboPreset = () =>
  usePresetWrite("Couldn't delete this combo", (id: string) =>
    authedFetch(`/sofa-combo-presets/${encodeURIComponent(id)}`, { method: 'DELETE' }));
