/* runScmPgCommand for route tests over an in-memory fake client: runs the command on the same client, rolls every
   table back when it answers non-2xx or throws (the transaction's rollback), and runs the after-commit effects only
   on success. The fake client must expose its tables as `tables`. Real commit / rollback is the database's. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- route context and fake client are untyped here
type Any = any;
type Row = Record<string, unknown>;

export const afterCommitRan: Array<() => Promise<void>> = [];

export async function fakeRunScmPgCommand(c: Any, cmd: (sb: Any) => Promise<Response>): Promise<Response> {
  const sb = c.get('supabase');
  const tables = sb.tables as Record<string, Row[]>;
  const snapshot = JSON.parse(JSON.stringify(tables)) as Record<string, Row[]>;
  const rollback = () => {
    for (const k of Object.keys(tables)) tables[k]!.splice(0, tables[k]!.length, ...(snapshot[k] ?? []));
  };
  const effects: Array<() => Promise<void>> = [];
  c.__fakeAfterCommit = effects;
  try {
    const res = await cmd(sb);
    if (!res.ok) { rollback(); return res; }
    for (const e of effects) { afterCommitRan.push(e); await e(); }
    return res;
  } catch {
    rollback();
    return c.json({ error: 'command_failed', message: 'The operation was rolled back. Please try again.' }, 500);
  }
}

export function fakeDeferScmAfterCommit(c: Any, effect: () => Promise<void>): void {
  (c.__fakeAfterCommit as Array<() => Promise<void>>).push(effect);
}
