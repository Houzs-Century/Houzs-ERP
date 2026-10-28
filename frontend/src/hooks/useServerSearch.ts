import { useEffect, useRef } from "react";
import { useDebouncedValue } from "../vendor/scm/lib/hooks";

const normalize = (value: string) => value.trim();

export function useDebouncedSearchTerm(inputTerm: string, delayMs = 300) {
  const requestTerm = useDebouncedValue(inputTerm, delayMs);
  return {
    inputTerm,
    requestTerm,
    isDebouncing: normalize(inputTerm) !== normalize(requestTerm),
  };
}

type SearchResultTransitionInput = {
  inputTerm: string;
  requestTerm: string;
  isFetching: boolean;
  isPlaceholderData?: boolean;
  hasData: boolean;
  hasError?: boolean;
};

/**
 * Separates search transitions from ordinary background refreshes and paging.
 * A placeholder page for the same settled term is safe to keep visible; rows
 * from a previous term are not.
 */
export function useSearchResultTransition({
  inputTerm,
  requestTerm,
  isFetching,
  isPlaceholderData = false,
  hasData,
  hasError = false,
}: SearchResultTransitionInput) {
  const input = normalize(inputTerm);
  const request = normalize(requestTerm);
  const lastSettledTerm = useRef(request);

  const requestHasCurrentData = hasData && !isPlaceholderData;
  const isDebouncing = input !== request;
  const waitingForCurrentTerm = input === request && lastSettledTerm.current !== request && !requestHasCurrentData;
  const resultsAreStale = isDebouncing || waitingForCurrentTerm;

  useEffect(() => {
    if (requestHasCurrentData) lastSettledTerm.current = request;
  }, [request, requestHasCurrentData]);

  return {
    isSearching:
      resultsAreStale &&
      !hasError &&
      (isDebouncing || isFetching || isPlaceholderData || !hasData),
    resultsAreStale,
    statusText: input ? `Searching for “${inputTerm.trim()}”…` : "Loading results…",
  };
}
