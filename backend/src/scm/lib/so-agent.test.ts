// What lands in `mfg_sales_orders.agent`, and where it comes from.
//
// The column was empty on every order created since the cutover, because no SO
// form sends `body.agent` and nothing else wrote it. That emptiness is what the
// live AED_HOUZS book answered on 2026-08-13 with
// `Foreign Key Error (Constraint Name=FK_SO_SalesAgent)`.
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

  /* A form control that was never touched posts '', not undefined. Storing it
     would put the column straight back where it was — non-null, still empty,
     still FK_SO_SalesAgent. */
  test('a blank supplied agent is not a supplied agent', () => {
    expect(soAgentToStamp('', 'Chang Shi Ting')).toBe('Chang Shi Ting');
    expect(soAgentToStamp('   ', 'Chang Shi Ting')).toBe('Chang Shi Ting');
  });

  test('both sides are trimmed, so the stored spelling is the sent spelling', () => {
    expect(soAgentToStamp('  KINGSLEY ', null)).toBe('KINGSLEY');
    expect(soAgentToStamp(null, '  Chang Shi Ting  ')).toBe('Chang Shi Ting');
  });

  /* NULL, not ''. The confirm gate treats blank as "no salesperson" and so does
     the write-back; a stored empty string would read as a value to both. */
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
    /* `.eq('id', null)` is not "no salesperson", it is a malformed filter that
       matches whatever the edge decides to match. The SO router already learned
       this on the venue lookup beside this one. */
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

  /* Best-effort, because this runs inside a create that has already priced,
     gated and reserved. A dead staff lookup costs the order its agent text; it
     must never cost the salesperson their save. */
  test('a failed lookup returns null instead of throwing into the create', async () => {
    const sb = staffSb([], true);
    await expect(readStaffAgentName(sb, 'staff-1')).resolves.toBeNull();
  });

  /* One row, one read: the venue chain fetched the same staff row two
     statements after the agent needed it. */
  test('readStaffForStamp carries the venue off the SAME row', async () => {
    const sb = staffSb([{ id: 'staff-1', name: 'Chang Shi Ting', venue_id: 'venue-7' }]);
    expect(await readStaffForStamp(sb, 'staff-1')).toEqual({
      name: 'Chang Shi Ting', venueId: 'venue-7',
    });
    /* A venue-less salesperson (an admin under their own name) stays NULL —
       admins oversee every venue by design. */
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
    /* diffFields() audits from `body` through the same field map, so a column
       written with no entry there changes the order with nothing in its
       history to say so. */
    expect(body.agent).toBe('Nurul Hidayah');
  });

  test('a PATCH that names the agent itself still wins', async () => {
    const updates: Record<string, unknown> = { salesperson_id: 'staff-2', agent: 'KINGSLEY' };
    const body: Record<string, unknown> = { agent: 'KINGSLEY' };
    await followSalespersonToAgent(sb, updates, body);
    expect(updates.agent).toBe('KINGSLEY');
  });

  /* `agent` is the LAST record of who sold the order, and the write-back reads
     it exactly when salesperson_id is empty — clearing both would throw that
     away. A name that cannot be read is the same call: stale beats none. */
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
