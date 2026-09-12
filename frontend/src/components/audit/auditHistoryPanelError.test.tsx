/* A CHANGE LOG THAT CANNOT LOAD MUST NOT SAY "No history yet."
 *
 * Found on staging, 2026-09-13, with the drawer open on HC-GRN-2609-067. The
 * drawer read "No history yet." The endpoint, asked directly with the same
 * session, answered:
 *
 *   500 {"error":"load_failed","reason":"permission denied for table entity_audit_log"}
 *
 * The server refused and the screen reported emptiness. On an audit trail that
 * is the worst possible wrong answer — "nobody has touched this document" is
 * exactly what somebody checks a change log to find out, and it was a lie
 * produced by a `?? []`.
 *
 * The backend already refuses to make this mistake. `routes/entity-audit-log.ts`
 * rejects an unknown entity type with a 400 rather than an empty list,
 * "because answering it with `{ entries: [] }` reads as 'this document has no
 * history' — the single most misleading answer an audit endpoint can give."
 * The frontend then produced that answer anyway, one layer up.
 *
 * It is also the third time this file's own host pages have paid for the same
 * `?? []`: SalesOrderDetail.tsx:1749 and SalesOrderDetailV2.tsx:757 both carry
 * a comment about a FAILED payments read leaving `isLoading` false and `data`
 * undefined, so the guard fell through and painted an empty panel. The audit
 * drawer never got that lesson.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { AuditHistoryPanel } from './AuditHistoryPanel';
import type { AuditLabelDictionary, AuditLogEntry } from './audit-labels';

/* `frontend/src`, found by walking UP from the working directory: this suite is
   run both from the repo root and from `frontend/` (CI uses
   `working-directory: frontend`), so no fixed `../` count is right in both. */
const findSrc = (): string => {
  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    const candidate = resolve(dir, 'frontend/src');
    if (existsSync(candidate)) return candidate;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(`frontend/src not found above ${process.cwd()} — this scan must never pass on an empty read`);
};
const SRC = findSrc();

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [path] : [];
  });

const LABELS: AuditLabelDictionary = {
  actions: { CREATE: 'Created', UPDATE: 'Updated' },
  fields: { status: 'Status' },
};

const panel = (props: Partial<Parameters<typeof AuditHistoryPanel>[0]>) =>
  render(
    <AuditHistoryPanel
      recordLabel="HC-GRN-2609-067"
      entityName="Goods receipt"
      entries={[]}
      labels={LABELS}
      onClose={() => {}}
      {...props}
    />,
  );

afterEach(cleanup);

describe('a refused history is not an empty history', () => {
  it('says the history could not be loaded, and does NOT say there is none', () => {
    panel({ error: new Error('permission denied for table entity_audit_log') });
    expect(screen.queryByText(/No history yet/i)).toBeNull();
    expect(screen.getByText(/could not be loaded/i)).toBeTruthy();
  });

  it('shows the reason the server gave, so the refusal is diagnosable', () => {
    panel({ error: new Error('permission denied for table entity_audit_log') });
    expect(screen.getByText(/permission denied for table entity_audit_log/i)).toBeTruthy();
  });

  it('an error wins over emptiness even while a retry is in flight', () => {
    /* react-query keeps the last error while refetching. Reading `isLoading`
       first would flip the panel back to "Loading…" and then to "No history
       yet." on the next failure, which is how a permanent refusal reads as a
       flicker rather than a fault. */
    panel({ error: new Error('boom'), isLoading: true });
    expect(screen.queryByText(/No history yet/i)).toBeNull();
    expect(screen.getByText(/could not be loaded/i)).toBeTruthy();
  });

  it('a genuinely empty history still says so', () => {
    panel({ entries: [], error: null });
    expect(screen.getByText(/No history yet/i)).toBeTruthy();
  });

  it('entries render whether or not an error prop is passed', () => {
    const entry: AuditLogEntry = {
      id: '1', action: 'CREATE', actor_name_snapshot: 'Wei',
      field_changes: [], created_at: '2026-09-13T00:00:00Z',
      source: null, note: null,
    };
    panel({ entries: [entry] });
    expect(screen.queryByText(/No history yet/i)).toBeNull();
    expect(screen.getByText(/Created/)).toBeTruthy();
  });
});

describe('every binding passes the error through', () => {
  /* The prop is optional in the TYPE (so the panel still renders for a caller
     with nothing to report), which means the compiler cannot enforce this. A
     binding that forgets it is silently back to reporting a refusal as an empty
     history — so the enforcement is this scan, over whoever mounts the panel
     today and whoever mounts it next. */
  it('no <AuditHistoryPanel ...> is mounted without error=', () => {
    const roots = [resolve(SRC, 'pages'), resolve(SRC, 'mobile'), resolve(SRC, 'components')];
    const files = roots.flatMap((r) => (existsSync(r) ? walk(r) : []));
    const mounts = files.flatMap((path) => {
      const src = readFileSync(path, 'utf8');
      return [...src.matchAll(/<AuditHistoryPanel\b[\s\S]*?\/>/g)]
        .filter((m) => !/\berror=/.test(m[0]))
        .map(() => relative(SRC, path).split(String.fromCharCode(92)).join('/'));
    });
    expect(mounts).toEqual([]);
  });

  it('the scan actually finds the mounts, so an empty result is not a dead matcher', () => {
    const roots = [resolve(SRC, 'pages'), resolve(SRC, 'mobile'), resolve(SRC, 'components')];
    const files = roots.flatMap((r) => (existsSync(r) ? walk(r) : []));
    const total = files.reduce(
      (n, path) => n + [...readFileSync(path, 'utf8').matchAll(/<AuditHistoryPanel\b/g)].length,
      0,
    );
    expect(total).toBeGreaterThanOrEqual(3);
  });
});
