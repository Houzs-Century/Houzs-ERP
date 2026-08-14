import { describe, expect, test } from 'vitest';
import routeSource from '../src/scm/routes/mfg-sales-orders.ts?raw';

/* 2026-08-13, the day the AutoCount write-back went live: two re-queued sales
   orders came back `Foreign Key Error (Constraint Name=FK_SO_SalesAgent)`.
   `mfg_sales_orders.agent` is the only field the write-back reads for the Sales
   Agent, no SO form has ever sent `body.agent`, and nothing else wrote the
   column — so it was empty on every order created since the cutover.

   THE INVARIANT THIS PINS: no SO write may put `body.agent` into the `agent`
   column raw. Every one goes through soAgentToStamp, which falls back to the
   salesperson the order is actually attributed to. The RULE is unit-tested in
   src/scm/lib/so-agent.test.ts and the write-back half in
   src/services/autocount-writeback.test.ts; this file is what stops a refactor
   silently unhooking it, and what fails when a fourth stamp site appears.

   Same source-anchored technique, and same reason, as
   soLocationGateWiring.test.ts: these handlers run on Supabase/Postgres, which
   this suite's environment does not bind. */

/** Strip comments so the assertions read CODE, not the prose explaining it. */
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const code = stripComments(routeSource);

describe('the source loaded', () => {
  test('a silent empty glob must not pass this file', () => {
    expect(routeSource.length).toBeGreaterThan(1000);
    expect(code).toContain('createSalesOrderCore');
  });
});

describe('nothing writes the agent column from body.agent alone', () => {
  test('every `agent:` in the router is the resolved value or the stored one', () => {
    /* Two legitimate shapes and no third:
         • `agentToStamp`  — a CREATE deciding the value (header, goods lines,
           SERVICE lines, and the confirm gate that judges what will be stored;
           they must agree, or the SO list and the Detail Listing disagree with
           the header about who sold the order);
         • `header.agent` / `prev.agent` — a later line INHERITING the value the
           document already carries, which is the same value by construction.
       `body.agent` on its own is the bug: it is the field no form sends. */
    const stamps = code.match(/^\s*agent: .*$/gm) ?? [];
    expect(stamps.length).toBeGreaterThanOrEqual(4);
    for (const s of stamps) {
      expect(s, 'a raw body.agent write is the bug this closes').not.toMatch(/body\.agent/);
      expect(s).toMatch(/agentToStamp|header\.agent|prev\.agent/);
    }
  });

  test('the resolved value comes from the SHARED rule, not a re-inlined copy', () => {
    expect(code).toContain('const agentToStamp = soAgentToStamp(');
    expect(code).toContain("from '../lib/so-agent'");
  });

  test('it derives from the salesperson the order is actually stamped with', () => {
    const readAt = code.indexOf('readStaffForStamp(');
    expect(readAt).toBeGreaterThan(0);
    const block = code.slice(readAt, readAt + 300);
    expect(block).toContain('salespersonIdToStamp');
    expect(block).toContain('soAgentToStamp(body.agent');
  });

  /* One staff row, one read. The venue chain fetched the same row for
     `venue_id` two statements later; two reads of one row is also how the
     route file grew past a ceiling that may only fall. */
  test('the venue chain reuses that read rather than issuing its own', () => {
    expect(code).toContain('stampStaff?.venueId');
    expect(code).not.toMatch(/\.select\('venue_id'\)/);
  });

  test('it is resolved BEFORE every row that carries it', () => {
    const at = code.indexOf('const agentToStamp = soAgentToStamp(');
    const stampAt = code.indexOf('agent: agentToStamp');
    const insertAt = code.indexOf("sb.from('mfg_sales_orders').insert({");
    expect(stampAt).toBeGreaterThan(at);
    expect(insertAt).toBeGreaterThan(at);
  });
});

describe('the header PATCH keeps the two in step', () => {
  /* The create-time stamp is what makes staleness REACHABLE: until it landed
     the column was empty on every new order and the write-back fell back to
     salesperson_id every time. Reassigning the salesperson now has to move the
     agent with it, or the account book keeps naming the previous rep. */
  test('a reassigned salesperson carries the agent with it', () => {
    /* The rule — including that `body` is updated so diffFields() can audit it —
       is asserted in src/scm/lib/so-agent.test.ts. This is the hook. */
    expect(code).toContain('await followSalespersonToAgent(');
  });

  test('it runs before the change-detection read, so a no-op stays a no-op', () => {
    const at = code.indexOf('await followSalespersonToAgent(');
    const beforeRead = code.indexOf("const { data: before, error: beforeError } = await sb.from('mfg_sales_orders')");
    expect(at).toBeGreaterThan(0);
    expect(beforeRead).toBeGreaterThan(0);
    expect(at).toBeLessThan(beforeRead);
  });
});
