import { describe, expect, test } from 'vitest';
import {
  soAgentToStamp,
  readStaffAgentName,
  readStaffForStamp,
  followSalespersonToAgent,
} from './so-agent';

describe('soAgentToStamp', () => {
  test('a create with a salesperson stamps the salesperson NAME', () => {
    expect(soAgentToStamp(undefined, 'Chang Shi Ting')).toBe('Chang Shi Ting');
  });

  test('an explicitly supplied agent still wins over the salesperson', () => {
    expect(soAgentToStamp('KINGSLEY', 'Chang Shi Ting')).toBe('KINGSLEY');
  });

  test('a blank supplied agent is not a supplied agent', () => {
    expect(soAgentToStamp('', 'Chang Shi Ting')).toBe('Chang Shi Ting');
    expect(soAgentToStamp('   ', 'Chang Shi Ting')).toBe('Chang Shi Ting');
  });

  test('both sides are trimmed, so the stored spelling is the sent spelling', () => {
    expect(soAgentToStamp('  KINGSLEY ', null)).toBe('KINGSLEY');
    expect(soAgentToStamp(null, '  Chang Shi Ting  ')).toBe('Chang Shi Ting');
  });

  test('neither source leaves the column NULL rather than empty', () => {
    expect(soAgentToStamp(undefined, null)).toBeNull();
    expect(soAgentToStamp('', '')).toBeNull();
  });

  test('a non-string body.agent is ignored, not stringified', () => {
    expect(soAgentToStamp(42, 'Chang Shi Ting')).toBe('Chang Shi Ting');
    expect(soAgentToStamp({ name: 'X' }, null)).toBeNull();
  });
});

describe('readStaffAgentName', () => {
  const staffSb = (rows: Array<Record<string, unknown>>, throws = false) => ({
    from: () => ({
      select: () => ({
        eq: (_col: string, val: unknown) => ({
          maybeSingle: async () => {
            if (throws) throw new Error('connection refused');
            return { data: rows.find((r) => r.id === val) ?? null };
          },
        }),
      }),
    }),
  });

  test('resolves the staff row to its display name', async () => {
    const sb = staffSb([{ id: 'staff-1', name: 'Chang Shi Ting' }]);
    expect(await readStaffAgentName(sb, 'staff-1')).toBe('Chang Shi Ting');
  });

  test('no id is not a lookup — a blank one must never reach .eq()', async () => {
    let asked = false;
    const sb = {
      from: () => { asked = true; return staffSb([]).from(); },
    } as never;
    expect(await readStaffAgentName(sb, null)).toBeNull();
    expect(await readStaffAgentName(sb, '   ')).toBeNull();
    expect(asked).toBe(false);
  });

  test('a staff row with no name resolves to null, not to an empty agent', async () => {
    const sb = staffSb([{ id: 'staff-1', name: '  ' }]);
    expect(await readStaffAgentName(sb, 'staff-1')).toBeNull();
  });

  test('a failed lookup returns null instead of throwing into the create', async () => {
    const sb = staffSb([], true);
    await expect(readStaffAgentName(sb, 'staff-1')).resolves.toBeNull();
  });

  test('readStaffForStamp carries the venue off the SAME row', async () => {
    const sb = staffSb([{ id: 'staff-1', name: 'Chang Shi Ting', venue_id: 'venue-7' }]);
    expect(await readStaffForStamp(sb, 'staff-1')).toEqual({
      name: 'Chang Shi Ting', venueId: 'venue-7',
    });
    const noVenue = staffSb([{ id: 'staff-2', name: 'Admin' }]);
    expect(await readStaffForStamp(noVenue, 'staff-2')).toEqual({ name: 'Admin', venueId: null });
    expect(await readStaffForStamp(sb, 'nobody')).toBeNull();
  });
});

describe('followSalespersonToAgent — the header PATCH', () => {
  const staffSb = (rows: Array<Record<string, unknown>>) => ({
    from: () => ({
      select: () => ({
        eq: (_col: string, val: unknown) => ({
          maybeSingle: async () => ({ data: rows.find((r) => r.id === val) ?? null }),
        }),
      }),
    }),
  });
  const sb = staffSb([{ id: 'staff-2', name: 'Nurul Hidayah' }]) as never;

  test('reassigning the salesperson moves the agent with it', async () => {
    const updates: Record<string, unknown> = { salesperson_id: 'staff-2' };
    const body: Record<string, unknown> = { salespersonId: 'staff-2' };
    await followSalespersonToAgent(sb, updates, body);
    expect(updates.agent).toBe('Nurul Hidayah');
    expect(body.agent).toBe('Nurul Hidayah');
  });

  test('a PATCH that names the agent itself still wins', async () => {
    const updates: Record<string, unknown> = { salesperson_id: 'staff-2', agent: 'KINGSLEY' };
    const body: Record<string, unknown> = { agent: 'KINGSLEY' };
    await followSalespersonToAgent(sb, updates, body);
    expect(updates.agent).toBe('KINGSLEY');
  });

  test('clearing the salesperson, or an unreadable name, leaves the agent alone', async () => {
    const cleared: Record<string, unknown> = { salesperson_id: null };
    await followSalespersonToAgent(sb, cleared, {});
    expect(cleared.agent).toBeUndefined();

    const unknown: Record<string, unknown> = { salesperson_id: 'staff-gone' };
    await followSalespersonToAgent(sb, unknown, {});
    expect(unknown.agent).toBeUndefined();
  });

  test('a PATCH that does not touch the salesperson touches nothing', async () => {
    const updates: Record<string, unknown> = { phone: '012' };
    await followSalespersonToAgent(sb, updates, {});
    expect(updates).toEqual({ phone: '012' });
  });
});
