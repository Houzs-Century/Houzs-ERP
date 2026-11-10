// The server half of shared/do-spec-lock.ts: does this line PATCH change the spec
// of a line on a shipped DO? Compares the stock bucket the line shipped under with
// the one the request would put it in, so a request that merely re-sends the same
// spec (the edit form sends the whole line) is not refused.
import { computeVariantKey, type VariantAttrs } from '../shared';
import { DO_SPEC_LOCKED_ERROR, DO_SPEC_LOCKED_MESSAGE, doSpecLocked } from '../shared/do-spec-lock';

type PrevLine = { item_code?: unknown; item_group?: unknown; variants?: unknown };

export function shippedDoSpecRefusal(
  status: string | null, prev: PrevLine, body: Record<string, unknown>,
): { error: string; message: string } | null {
  if (!doSpecLocked(status)) return null;
  const codeChanged = body.itemCode !== undefined
    && String(body.itemCode ?? '').trim() !== String(prev.item_code ?? '').trim();
  const prevGroup = (prev.item_group as string | null | undefined) ?? null;
  const shipped = computeVariantKey(prevGroup, (prev.variants ?? null) as VariantAttrs | null);
  const next = computeVariantKey(
    (body.itemGroup as string | null | undefined) ?? prevGroup,
    (body.variants !== undefined ? body.variants : prev.variants ?? null) as VariantAttrs | null,
  );
  if (!codeChanged && next === shipped) return null;
  return { error: DO_SPEC_LOCKED_ERROR, message: DO_SPEC_LOCKED_MESSAGE };
}
