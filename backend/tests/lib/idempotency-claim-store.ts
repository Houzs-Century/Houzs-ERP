/* A stand-in for the idempotency_keys table: the five statements
   middleware/idempotency.ts issues, and nothing else — an unrecognised query
   throws, so a middleware change cannot quietly stop being tested. The unique
   index on (key, scope) is honoured, so a racing second claim collides. */
import type { Env } from '../../src/types';

export type ClaimRow = {
  key: string; scope: string; user_id: number; tenant_scope: string;
  request_hash: string; status_code: number | null; response_body: string | null;
};

export function claimStore(): { rows: ClaimRow[]; env: Env } {
  const rows: ClaimRow[] = [];
  const owner = (userId: number, tenant: string, key: string, scope: string) =>
    rows.find((r) => r.user_id === userId && r.tenant_scope === tenant && r.key === key && r.scope === scope);
  const DB = {
    prepare(sql: string) {
      const norm = sql.replace(/\s+/g, ' ').trim();
      return {
        bind(...args: unknown[]) {
          const reject = () => new Error(`claimStore has no handler for: ${norm}`);
          return {
            async first() {
              if (norm.startsWith('SELECT status_code, response_body, request_hash FROM idempotency_keys')) {
                const [userId, tenant, key, scope] = args as [number, string, string, string];
                const row = owner(userId, tenant, key, scope);
                return row ? { status_code: row.status_code, response_body: row.response_body, request_hash: row.request_hash } : null;
              }
              throw reject();
            },
            async run() {
              if (norm.startsWith('INSERT INTO app_settings')) return { success: true };
              if (norm.startsWith('INSERT INTO idempotency_keys')) {
                const [key, scope, userId, tenant, hash] = args as [string, string, number, string, string];
                if (rows.some((r) => r.key === key && r.scope === scope)) {
                  throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
                }
                rows.push({ key, scope, user_id: userId, tenant_scope: tenant, request_hash: hash, status_code: null, response_body: null });
                return { success: true };
              }
              if (norm.startsWith('DELETE FROM idempotency_keys')) {
                const [userId, tenant, key, scope, hash] = args as [number, string, string, string, string];
                const row = owner(userId, tenant, key, scope);
                if (row && row.request_hash === hash) rows.splice(rows.indexOf(row), 1);
                return { success: true };
              }
              if (norm.startsWith('UPDATE idempotency_keys')) {
                const [status, bodyText, userId, tenant, key, scope, hash] = args as
                  [number, string, number, string, string, string, string];
                const row = owner(userId, tenant, key, scope);
                if (row && row.request_hash === hash) { row.status_code = status; row.response_body = bodyText; }
                return { success: true };
              }
              throw reject();
            },
          };
        },
      };
    },
  };
  return { rows, env: { DB } as unknown as Env };
}
