/* runScmPgCommand for route tests over an in-memory fake client: runs the command on the same client and, when it
   answers non-2xx or throws, puts every table back as it was - the transaction's rollback. The fake client must
   expose its tables as `__tables`. The real commit and rollback are runScmPgCommand's own (sql.begin). */
type Row = Record<string, unknown>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a Hono context and a fake PostgREST client, as in the route tests
export async function fakeRunScmPgCommand(c: any, cmd: (sb: any) => Promise<Response>): Promise<Response> {
  const sb = c.get('supabase');
  const tables = sb.__tables as Record<string, Row[]> | undefined;
  if (!tables) return cmd(sb);
  const snapshot = JSON.parse(JSON.stringify(tables)) as Record<string, Row[]>;
  const rollback = () => {
    for (const k of Object.keys(tables)) tables[k]!.splice(0, tables[k]!.length, ...(snapshot[k] ?? []));
  };
  try {
    const res = await cmd(sb);
    if (!res.ok) rollback();
    return res;
  } catch {
    rollback();
    return c.json({ error: 'command_failed', message: 'The operation was rolled back. Please try again.' }, 500);
  }
}
