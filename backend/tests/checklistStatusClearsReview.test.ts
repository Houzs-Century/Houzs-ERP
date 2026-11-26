// Regression (owner 2026-11-25 "approved stock-outs still on pending list"):
// ticking a checklist item done / N/A must clear any review flag, so a submitted
// item does not sit in the Inbox Review Queue forever. setChecklistStatus used to
// set status without touching review_status; ~46 completed Stock In/Out records
// kept a dangling 'pending_review'. pending / blocked are NOT completions, so they
// leave review state alone.
import { describe, expect, test } from 'vitest';
import { setChecklistStatus } from '../src/services/projects';

type Ran = { sql: string; args: unknown[] };

function fakeEnv(ran: Ran[], row: Record<string, unknown> | null) {
  const DB = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const stmt = {
        bind(...a: unknown[]) { args = a; return stmt; },
        async first() { return row; },
        async run() { ran.push({ sql: sql.replace(/\s+/g, ' ').trim(), args }); return { meta: {} }; },
      };
      return stmt;
    },
  };
  return { DB } as unknown as Parameters<typeof setChecklistStatus>[0];
}

const checklistUpdate = (ran: Ran[]) =>
  ran.find((r) => r.sql.startsWith('UPDATE project_checklist'));

describe('setChecklistStatus clears the review flag on completion', () => {
  for (const status of ['done', 'na'] as const) {
    test(`${status} clears review_status and rejection_reason`, async () => {
      const ran: Ran[] = [];
      const env = fakeEnv(ran, { project_id: 1, title: 'Stock Out Transfer Record', status: 'pending' });
      await setChecklistStatus(env, 42, status, 7);
      const upd = checklistUpdate(ran);
      expect(upd).toBeDefined();
      expect(upd!.sql).toContain('review_status = NULL');
      expect(upd!.sql).toContain('rejection_reason = NULL');
    });
  }

  for (const status of ['pending', 'blocked'] as const) {
    test(`${status} leaves review state untouched`, async () => {
      const ran: Ran[] = [];
      const env = fakeEnv(ran, { project_id: 1, title: 'Stock Out Transfer Record', status: 'done' });
      await setChecklistStatus(env, 42, status, 7);
      const upd = checklistUpdate(ran);
      expect(upd).toBeDefined();
      expect(upd!.sql).not.toContain('review_status');
      expect(upd!.sql).not.toContain('rejection_reason');
    });
  }
});
