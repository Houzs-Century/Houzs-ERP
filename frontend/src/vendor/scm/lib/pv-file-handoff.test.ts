import { describe, expect, test, vi } from 'vitest';
import { attachTakenFiles, stashPvFiles, takePvFiles } from './pv-file-handoff';

const page = (name: string) => ({ name, mime: 'application/pdf', dataBase64: `b64:${name}` });

describe('pv-file-handoff', () => {
  test('take() hands the stash over once, then it is empty', () => {
    stashPvFiles([page('a.pdf')]);
    expect(takePvFiles().map((f) => f.name)).toEqual(['a.pdf']);
    expect(takePvFiles()).toEqual([]);
  });

  test('attachTakenFiles uploads every page in order', async () => {
    const upload = vi.fn(async (_f: { name: string }) => ({ ok: true }));
    expect(await attachTakenFiles([page('a.pdf'), page('b.pdf')], upload)).toEqual({ attached: 2, failed: 0, error: null });
    expect(upload.mock.calls.map(([f]) => f.name)).toEqual(['a.pdf', 'b.pdf']);
  });

  test('a refused page stops the run and says how many still need adding, without throwing', async () => {
    const upload = vi.fn().mockResolvedValueOnce({ ok: true }).mockRejectedValueOnce(new Error('too big'));
    expect(await attachTakenFiles([page('a.pdf'), page('b.pdf'), page('c.pdf')], upload)).toEqual({ attached: 1, failed: 2, error: 'too big' });
    expect(upload).toHaveBeenCalledTimes(2);
  });
});
