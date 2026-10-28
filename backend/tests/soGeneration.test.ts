import { describe, expect, test } from 'vitest';
import { advanceSoGeneration } from '../src/scm/lib/so-generation';

type Row = Record<string, unknown>;

function fakeSb(row: Row) {
  let writes = 0;
  return {
    get writes() { return writes; },
    from() {
      let patch: Row | null = null;
      const predicates: Array<(candidate: Row) => boolean> = [];
      const query: any = {
        select: () => query,
        update: (next: Row) => { patch = next; return query; },
        eq: (key: string, value: unknown) => {
          predicates.push((candidate) => String(candidate[key]) === String(value));
          return query;
        },
        or: () => query,
        maybeSingle: async () => {
          if (!predicates.every((predicate) => predicate(row))) return { data: null, error: null };
          if (patch) { Object.assign(row, patch); writes += 1; }
          return { data: row, error: null };
        },
      };
      return query;
    },
  };
}

describe('canonical SO system generation writer', () => {
  test('two writers proving the same generation produce one winner and one conflict', async () => {
    const row = {
      doc_no: 'SO-1', status: 'CONFIRMED', version: 4,
      edit_lease_token: null, edit_lease_expires_at: null,
    };
    const sb = fakeSb(row);

    const first = await advanceSoGeneration(sb, 'SO-1', { status: 'READY_TO_SHIP' }, { version: 4 });
    const stale = await advanceSoGeneration(sb, 'SO-1', { status: 'DELIVERED' }, { version: 4 });

    expect(first).toMatchObject({ applied: true, version: 5 });
    expect(stale).toMatchObject({ applied: false, reason: 'conflict', currentVersion: 5 });
    expect(row).toMatchObject({ status: 'READY_TO_SHIP', version: 5 });
    expect(sb.writes).toBe(1);
  });

  test('an active human edit lease makes the system writer perform zero writes', async () => {
    const row = {
      doc_no: 'SO-1', status: 'CONFIRMED', version: 4,
      edit_lease_token: 'human-editor',
      edit_lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
    };
    const sb = fakeSb(row);

    await expect(advanceSoGeneration(sb, 'SO-1', { status: 'READY_TO_SHIP' }))
      .resolves.toMatchObject({ applied: false, reason: 'lease' });
    expect(sb.writes).toBe(0);
    expect(row).toMatchObject({ status: 'CONFIRMED', version: 4 });
  });
});
