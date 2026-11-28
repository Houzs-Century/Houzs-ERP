import { describe, expect, test, vi } from 'vitest';

const useQuery = vi.fn((opts: unknown) => opts);
vi.mock('@tanstack/react-query', () => ({ useQuery }));
vi.mock('./authed-fetch', () => ({ authedFetch: vi.fn() }));

const { packingPlateKey, packingScanStatusPath, packingScanTimesFor, usePackingScanStatus } = await import('./packing-list-queries');
const { fmtScanTime } = await import('./packing-list-model');

describe('packing list scan times (owner 2026-11-28)', () => {
  test('the office polls the day every 30 seconds, and not without a date', () => {
    const opts = usePackingScanStatus('2026-11-28') as unknown as { refetchInterval: number; enabled: boolean; queryKey: unknown[] };
    expect(opts.refetchInterval).toBe(30_000);
    expect(opts.enabled).toBe(true);
    expect(opts.queryKey).toEqual(['packing-scan-status', '2026-11-28']);
    expect((usePackingScanStatus(null) as unknown as { enabled: boolean }).enabled).toBe(false);
    expect(packingScanStatusPath('2026-11-28')).toBe('/trips/packing-scan-status?date=2026-11-28');
  });

  test('a lorry matches by the server plate key; a region by its key', () => {
    const sheets = [
      { kind: 'lorry' as const, key: 'VJK8821', prepared_at: 'p', loaded_at: null },
      { kind: 'region' as const, key: 'KL', prepared_at: 'r', loaded_at: null },
    ];
    expect(packingPlateKey(' vjk-8821 ')).toBe('VJK8821');
    expect(packingScanTimesFor(sheets, 'lorry', 'VJK 8821')?.prepared_at).toBe('p');
    expect(packingScanTimesFor(sheets, 'region', 'KL')?.prepared_at).toBe('r');
    expect(packingScanTimesFor(sheets, 'lorry', 'KL')).toBeNull();
    expect(packingScanTimesFor(undefined, 'lorry', 'VJK 8821')).toBeNull();
    expect(packingScanTimesFor(sheets, 'lorry', null)).toBeNull();
  });

  test('the time shows as HH:mm on the delivery day, with the date otherwise, dash when none', () => {
    expect(fmtScanTime('2026-11-28T01:42:00Z', '2026-11-28')).toBe('09:42');
    expect(fmtScanTime('2026-11-27T10:15:00Z', '2026-11-28')).toBe('2026/11/27 18:15');
    expect(fmtScanTime('2026-11-27T17:30:00Z', '2026-11-28')).toBe('01:30');
    expect(fmtScanTime(null, '2026-11-28')).toBe('—');
  });
});
