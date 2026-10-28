import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChoiceOpts } from '../components/ChoiceDialog';

/* "Which brand is this bill for?" (owner 2026-09-27) -- asked after a save whose
 * products name no brand, answered for the Venture Portal only. These pin what
 * the operator sees and what is written: the suggestion first, Skip writes
 * nothing, and a failed write is shown and asked again rather than lost. */

const { authedFetch, serviceNotify } = vi.hoisted(() => ({
  authedFetch: vi.fn(),
  serviceNotify: vi.fn(),
}));
vi.mock('./authed-fetch', () => ({ authedFetch }));
vi.mock('./dialog-service', () => ({ serviceNotify }));

import { askVpBrand, registerVpBrandPrompt, vpBrandChoice, type VpBrandAsk } from './vp-brand-prompt';

const OPTIONS = ['ZANOTTI', 'DUNLOPILLO', 'AKEMI', 'ERGOTEX'];

let asked: ChoiceOpts[];
let answers: Array<string | null>;

beforeEach(() => {
  asked = [];
  answers = [];
  authedFetch.mockReset().mockResolvedValue({ ok: true });
  serviceNotify.mockReset().mockResolvedValue(undefined);
  registerVpBrandPrompt(async (opts) => {
    asked.push(opts);
    return answers.shift() ?? null;
  });
});

afterEach(() => registerVpBrandPrompt(null));

describe('vpBrandChoice', () => {
  it('puts the linked booth’s brand first and says why, the rest in the company’s order', () => {
    const c = vpBrandChoice('HC-SO-2609-219', { suggested: 'AKEMI', options: OPTIONS });
    expect(c.title).toBe('Which brand is HC-SO-2609-219 for?');
    expect(c.options.map((o) => o.value)).toEqual(['AKEMI', 'ZANOTTI', 'DUNLOPILLO', 'ERGOTEX']);
    expect(c.options[0]!.detail).toMatch(/fair this bill is linked to/);
    expect(c.options.slice(1).every((o) => o.detail === undefined)).toBe(true);
    expect(c.cancelLabel).toBe('Skip');
  });

  it('keeps the list as it is with nothing to suggest, or a suggestion that is not a choice', () => {
    expect(vpBrandChoice('HC-SO-2609-127', { suggested: null, options: OPTIONS }).options.map((o) => o.value)).toEqual(OPTIONS);
    expect(vpBrandChoice('HC-SO-2609-127', { suggested: 'BEDFRAME', options: OPTIONS }).options.map((o) => o.value)).toEqual(OPTIONS);
  });
});

describe('askVpBrand', () => {
  const ask: VpBrandAsk = { suggested: 'AKEMI', options: OPTIONS };

  it('stores the brand picked, for that order', async () => {
    answers = ['AKEMI'];
    await askVpBrand('HC-SO-2609-219', ask);
    expect(asked).toHaveLength(1);
    expect(authedFetch).toHaveBeenCalledWith('/mfg-sales-orders/HC-SO-2609-219/vp-brand', {
      method: 'PUT',
      body: JSON.stringify({ brand: 'AKEMI' }),
    });
  });

  it('writes nothing on Skip', async () => {
    answers = [null];
    await askVpBrand('HC-SO-2609-127', { suggested: null, options: OPTIONS });
    expect(asked).toHaveLength(1);
    expect(authedFetch).not.toHaveBeenCalled();
  });

  it('asks nothing when the save did not ask, offered no choices, or no shell is mounted', async () => {
    await askVpBrand('HC-SO-013218', null);
    await askVpBrand('HC-SO-013218', { suggested: null, options: [] });
    registerVpBrandPrompt(null);
    await askVpBrand('HC-SO-2609-127', ask);
    expect(asked).toHaveLength(0);
    expect(authedFetch).not.toHaveBeenCalled();
  });

  it('says so when the brand could not be saved, and asks again with the pick first', async () => {
    authedFetch.mockRejectedValueOnce(new Error('Network down'));
    answers = ['ERGOTEX', null];
    await askVpBrand('HC-SO-2609-165', { suggested: null, options: OPTIONS });
    expect(serviceNotify).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Brand not saved',
      tone: 'error',
      body: expect.stringContaining('Network down'),
    }));
    expect(asked).toHaveLength(2);
    expect(asked[1]!.options[0]!.value).toBe('ERGOTEX');
    expect(authedFetch).toHaveBeenCalledTimes(1);
  });
});
