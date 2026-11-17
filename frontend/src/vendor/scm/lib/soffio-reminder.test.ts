import { describe, expect, it, vi } from 'vitest';
import { fetchSoItemCodes, passesSoffioReminder, soffioReminder } from './soffio-reminder';

describe('soffioReminder', () => {
  it('returns null when no line carries an 8030 code', () => {
    expect(soffioReminder([])).toBeNull();
    expect(soffioReminder(['5562-1B(LHF)', 'X-8030-1A', null, undefined, ''])).toBeNull();
  });

  it('lists each 8030 code once, case-insensitive, in order', () => {
    const r = soffioReminder(['8030-1A(LHF)', '5562-1B(RHF)', ' 8030-cnr ', '8030-1a(lhf)', '8030-Console']);
    expect(r?.codes).toEqual(['8030-1A(LHF)', '8030-cnr', '8030-Console']);
    expect(r?.dialog.title).toBe('Check the SOFFIO code');
    expect(r?.dialog.body).toContain('8030-1A(LHF), 8030-cnr, 8030-Console');
    expect(r?.dialog.body).toContain('SOFFIO 2.0 (5562 codes)');
    expect(r?.dialog.confirmLabel).toBe('Yes, it is SOFFIO');
    expect(r?.dialog.cancelLabel).toBe('Go back');
  });

  it('does not match 8030 without the dash', () => {
    expect(soffioReminder(['80301A'])).toBeNull();
  });
});

describe('passesSoffioReminder', () => {
  it('does not ask when there is no 8030 line', async () => {
    const ask = vi.fn();
    await expect(passesSoffioReminder(ask, ['5562-1B(LHF)'])).resolves.toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it('returns the operator answer when there is an 8030 line', async () => {
    await expect(passesSoffioReminder(async () => false, ['8030-L(RHF)'])).resolves.toBe(false);
    await expect(passesSoffioReminder(async () => true, ['8030-L(RHF)'])).resolves.toBe(true);
  });
});

describe('fetchSoItemCodes', () => {
  it('reads the live lines of the order, leaving cancelled ones out', async () => {
    const paths: string[] = [];
    const body = { items: [
      { item_code: '8030-CNR', cancelled: false },
      { item_code: '8030-L(RHF)', cancelled: true },
      { item_code: null, cancelled: false },
    ] };
    const fetcher = <T,>(path: string): Promise<T> => { paths.push(path); return Promise.resolve(body as T); };
    await expect(fetchSoItemCodes('SO / 1', fetcher)).resolves.toEqual(['8030-CNR', '']);
    expect(paths).toEqual(['/mfg-sales-orders/SO%20%2F%201']);
  });
});
