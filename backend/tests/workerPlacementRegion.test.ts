/* Gap review P17: the sister ERP sends its Claude calls through a Singapore
   relay, because Anthropic refuses requests from some Cloudflare locations
   (Hong Kong among them). Houzs places the Worker's fetch handler in
   aws:ap-southeast-1 (Singapore, next to the database; #4998, HC-0167), so
   every Claude call made while answering a request leaves from Singapore.
   This pins that block: deleting it would also move those calls back to
   whichever colo the request entered. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const TOML = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');

describe('production Worker placement (P17)', () => {
  it('places the fetch handler in Singapore', () => {
    const top = TOML.split(/^\[env\./m)[0] ?? '';
    expect(top).toMatch(/^\[placement\]\s*\r?\nregion = "aws:ap-southeast-1"/m);
  });
});
