// ----------------------------------------------------------------------------
// Confirm the ticked drafts of a list in one press (owner 2026-11-04). Each goes
// through the same `/:id/post` the row's own Confirm uses, one after another, and
// one refusal does not stop the rest: the summary names what stayed a draft.
// ----------------------------------------------------------------------------
import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { writeFailed } from './mutation-error';
import { useConfirm } from '../components/ConfirmDialog';
import { useNotify } from '../components/NotifyDialog';

export type ConfirmOutcome = { done: string[]; failed: Array<{ doc: string; reason: string }> };

/** In turn, not at once: a post moves stock and payables, and drafts in a list
 *  often bill the same receipt line, so the second must see the first's result. */
export async function confirmInTurn<R>(rows: readonly R[], docOf: (r: R) => string, post: (r: R) => Promise<string | null>): Promise<ConfirmOutcome> {
  const out: ConfirmOutcome = { done: [], failed: [] };
  for (const r of rows) {
    try {
      const problem = await post(r);
      if (problem) out.failed.push({ doc: docOf(r), reason: problem });
      else out.done.push(docOf(r));
    } catch (e) {
      out.failed.push({ doc: docOf(r), reason: e instanceof Error ? e.message : 'Something went wrong.' });
    }
  }
  return out;
}

export function confirmSummary(noun: string, o: ConfirmOutcome): { title: string; body: string; tone: 'info' | 'error' } {
  const title = `${o.done.length} of ${o.done.length + o.failed.length} confirmed`;
  if (o.failed.length === 0) return { title, body: `Every ticked ${noun} is confirmed.`, tone: 'info' };
  return { title, body: `Not confirmed:\n${o.failed.map((f) => `${f.doc}: ${f.reason}`).join('\n')}`, tone: 'error' };
}

type Spec<R> = {
  noun: string;
  body: string;
  pathOf: (r: R) => string;
  docOf: (r: R) => string;
  /** A post can answer 200 and still report a part that failed. */
  problemOf: (res: unknown) => string | null;
  refresh: QueryKey[];
  onDone: () => void;
};

export function useBatchConfirm<R>(spec: Spec<R>) {
  const qc = useQueryClient();
  const askConfirm = useConfirm();
  const notify = useNotify();
  const run = useMutation({
    mutationFn: (rows: R[]) => confirmInTurn(rows, spec.docOf, async (r) => spec.problemOf(await authedFetch<unknown>(spec.pathOf(r), { method: 'PATCH' }))),
    onSuccess: async (o) => {
      for (const queryKey of spec.refresh) void qc.invalidateQueries({ queryKey });
      spec.onDone();
      await notify(confirmSummary(spec.noun, o));
    },
    onError: writeFailed,
  });
  const confirm = async (rows: R[]) => {
    if (rows.length === 0) return;
    const many = rows.length === 1 ? spec.noun : `${spec.noun}s`;
    if (await askConfirm({ title: `Confirm ${rows.length} ${many}?`, body: spec.body, confirmLabel: `Confirm ${rows.length}` })) run.mutate(rows);
  };
  return { confirm, confirming: run.isPending };
}
