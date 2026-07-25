import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";

// Owner UX contract: the first character starts a real server search. The UI
// enters the searching state immediately; the short debounce only coalesces
// network traffic and never asks the operator to type a second character.
export const GLOBAL_SEARCH_MIN_LENGTH = 1;
export const GLOBAL_SEARCH_DEBOUNCE_MS = 250;

export type SearchHitType =
  | "project"
  | "assr_case"
  | "user"
  | "sales_order"
  | "product"
  | "purchase_order"
  | "grn"
  | "delivery_order"
  | "sales_invoice"
  | "purchase_invoice";

export interface SearchHit {
  type: SearchHitType;
  id: string | number;
  title: string;
  subtitle?: string | null;
  date?: string | null;
  link: string;
}

type SearchState =
  | { term: string; status: "idle" | "loading"; hits: SearchHit[]; error: null }
  | { term: string; status: "success"; hits: SearchHit[]; error: null }
  | { term: string; status: "error"; hits: SearchHit[]; error: string };

/**
 * Shared request state for desktop and mobile global search.
 *
 * Results are always bound to the normalized term that produced them. This is
 * more than an abort helper: the derived state hides an older term's hits in
 * the render that immediately follows a keystroke, before the effect cleanup
 * has had a chance to abort its request.
 */
export function useGlobalSearchResults(query: string) {
  const term = useMemo(() => query.trim(), [query]);
  const [state, setState] = useState<SearchState>({
    term: "",
    status: "idle",
    hits: [],
    error: null,
  });

  useEffect(() => {
    if (term.length < GLOBAL_SEARCH_MIN_LENGTH) {
      setState({ term, status: "idle", hits: [], error: null });
      return;
    }

    setState({ term, status: "loading", hits: [], error: null });
    const ctrl = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const response = await api.get<{ hits: SearchHit[] }>(
          `/api/search?q=${encodeURIComponent(term)}`,
          { signal: ctrl.signal },
        );
        if (!ctrl.signal.aborted) {
          setState({
            term,
            status: "success",
            hits: response.hits ?? [],
            error: null,
          });
        }
      } catch (error) {
        if (ctrl.signal.aborted) return;
        setState({
          term,
          status: "error",
          hits: [],
          error:
            error instanceof Error
              ? error.message
              : "Search isn't working right now. Please try again.",
        });
      }
    }, GLOBAL_SEARCH_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      ctrl.abort();
    };
  }, [term]);

  // Effects run after render. Never expose a previous term's state during that
  // small gap: it could otherwise still be selected with Enter.
  const current: SearchState =
    state.term === term
      ? state
      : term.length >= GLOBAL_SEARCH_MIN_LENGTH
        ? { term, status: "loading", hits: [], error: null }
        : { term, status: "idle", hits: [], error: null };

  return {
    term,
    hits: current.hits,
    loading: current.status === "loading",
    error: current.status === "error" ? current.error : null,
  };
}
