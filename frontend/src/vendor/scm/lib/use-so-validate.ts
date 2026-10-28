// ----------------------------------------------------------------------------
// useSoValidate — the frontend's ONE way to know what is blocking a Sales Order
// submit, asked of the BACKEND (owner 2026-09-16: 「跟 backend 串通, frontend 只是
// 显示问题」). It posts the DRAFT the operator is filling in to the dry-run
// POST /mfg-sales-orders/validate endpoint, debounced, and returns the backend's
// problems[] verbatim. The frontend holds NO validation rules of its own: the
// problem set AND the wording are collectSoSubmitProblems' on the server.
//
// The validate endpoint writes nothing and reads nothing (it runs a pure
// collector on the posted draft), so calling it on every edit burst is cheap.
// Debounced so a fast typist fires one request per pause, not per keystroke
// (R103 — polling / debounced fetch, no websockets). A failed / in-flight
// validate never blocks: it keeps the last answer and the real submit is still
// the authoritative gate that returns the same problems[] shape.
// ----------------------------------------------------------------------------
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { authedFetch, type SaveProblem } from './authed-fetch';
import { useDebouncedValue } from './hooks';

/** The draft is an opaque JSON payload (the surface builds it from its form
 *  state); the backend decides what each field means. Kept as a plain record so
 *  a surface adds a field without a shared-type change on both sides. */
export type SoValidateDraft = Record<string, unknown>;

export interface SoValidateResult {
  /** The backend's blocking reasons, in the order it returns them. [] = the
   *  draft clears every gate the server can see (the real submit still runs the
   *  authoritative gates). */
  problems: SaveProblem[];
  /** True while a validate request for the latest draft is in flight. */
  loading: boolean;
}

/**
 * Debounced backend validation of an SO draft.
 *
 * @param draft   the form state to validate (rebuild it with useMemo so its
 *                identity only changes when a relevant field changes).
 * @param enabled false to skip validation entirely (e.g. the form is not ready).
 * @param delayMs debounce window; 400ms by default.
 */
export function useSoValidate(
  draft: SoValidateDraft,
  enabled: boolean,
  delayMs = 400,
): SoValidateResult {
  const body = JSON.stringify(draft);
  const debouncedBody = useDebouncedValue(body, delayMs);
  const q = useQuery({
    queryKey: ['so-validate', debouncedBody],
    queryFn: ({ signal }) =>
      authedFetch<{ problems: SaveProblem[] }>('/mfg-sales-orders/validate', {
        method: 'POST',
        body: debouncedBody,
        signal,
      }),
    enabled,
    retry: false,
    // Keep the previous answer visible while the next one loads, so the count
    // does not flicker to zero between keystrokes.
    placeholderData: keepPreviousData,
  });
  return { problems: q.data?.problems ?? [], loading: q.isFetching };
}
