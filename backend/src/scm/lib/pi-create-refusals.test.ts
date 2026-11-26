import { describe, expect, it, vi } from 'vitest';

import { insertFailed, loadFailed, rollbackPi, committedAnyway } from './pi-create-refusals';

const survivesTheClient = (s: string) =>
  !!s && s.length < 200 && !s.trim().startsWith('{')
  && !/^[a-z][a-z0-9_]*$/.test(s.trim())
  && !/violates|constraint|null value|column|relation|syntax|PGRST|error_code|\b\d{5}\b/i.test(s);

describe('the bodies say something an operator can act on', () => {
  it('insertFailed reaches the screen, and says nothing was recorded', () => {
    const b = insertFailed('null value in column "material_kind" violates not-null constraint');
    expect(b.error).toBe('insert_failed');
    expect(survivesTheClient(b.message)).toBe(true);
    expect(b.message).toContain('nothing was recorded');
    expect(b.reason).toContain('material_kind');
  });

  it('insertFailed carries the line-insert code when the header was rolled back', () => {
    expect(insertFailed('boom', 'items_insert_failed').error).toBe('items_insert_failed');
  });

  it('a missing driver message leaves an explicit null, not an absent field', () => {
    const b = insertFailed(undefined);
    expect(b.reason).toBeNull();
    expect(JSON.parse(JSON.stringify(b))).toHaveProperty('reason', null);
  });

  it('loadFailed names what could not be checked, and still fits', () => {
    const b = loadFailed(
      'relation "scm.grns" does not exist',
      'check whether this receipt was carried over from the account book',
    );
    expect(b.error).toBe('load_failed');
    expect(survivesTheClient(b.message)).toBe(true);
    expect(b.message).toContain('NOT saved');
    expect(b.message).toContain('carried over from the account book');
  });

  it('the message stays under the client\'s 200-character cliff', () => {
    expect(loadFailed('x', 'check whether this receipt was carried over from the account book').message.length)
      .toBeLessThan(200);
    expect(insertFailed('x').message.length).toBeLessThan(200);
  });
});

describe('rollbackPi answers whether the undo actually happened', () => {
  const sb = (error: { message: string } | null) => {
    const calls: Array<{ table: string; id: unknown }> = [];
    return {
      calls,
      from: (table: string) => ({
        delete: () => ({ eq: async (_col: string, id: unknown) => { calls.push({ table, id }); return { error }; } }),
      }),
    };
  };

  it('deletes the header and reports a PROVEN undo', async () => {
    const client = sb(null);
    await expect(rollbackPi(client, 'pi-1', 'HC-PI-2608-001')).resolves.toBe(true);
    expect(client.calls).toEqual([{ table: 'purchase_invoices', id: 'pi-1' }]);
  });

  it('reports false when the delete errored, so the caller keeps the claim', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(rollbackPi(sb({ message: 'deadlock detected' }), 'pi-1', 'HC-PI-2608-001'))
      .resolves.toBe(false);
    expect(err.mock.calls[0]?.[0]).toContain('HC-PI-2608-001');
    err.mockRestore();
  });
});

describe('committedAnyway keeps a saved invoice from being reported as a failure', () => {
  it('swallows a throw and names the document in the log', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(committedAnyway('HC-PI-2608-001', async () => {
      throw new TypeError("Cannot read properties of undefined (reading 'id')");
    })).resolves.toBeUndefined();
    expect(err.mock.calls[0]?.[0]).toContain('HC-PI-2608-001');
    expect(err.mock.calls[0]?.[0]).toContain('the invoice IS saved');
    err.mockRestore();
  });

  it('runs the work and stays silent when nothing goes wrong', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let ran = 0;
    await committedAnyway('HC-PI-2608-001', async () => { ran += 1; });
    expect(ran).toBe(1);
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });
});
