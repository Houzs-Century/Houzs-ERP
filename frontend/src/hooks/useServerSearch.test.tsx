import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDebouncedSearchTerm, useSearchResultTransition } from "./useServerSearch";

afterEach(() => {
  vi.useRealTimers();
});

describe("server search transition", () => {
  it("marks A results stale immediately while A1 is still debouncing", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ term }) => useDebouncedSearchTerm(term, 300),
      { initialProps: { term: "A" } },
    );

    rerender({ term: "A1" });
    expect(result.current.requestTerm).toBe("A");
    expect(result.current.isDebouncing).toBe(true);

    act(() => vi.advanceTimersByTime(300));
    expect(result.current.requestTerm).toBe("A1");
    expect(result.current.isDebouncing).toBe(false);
  });

  it("hides placeholder rows from an old term but keeps same-term paging rows", () => {
    const { result, rerender } = renderHook(
      (props: Parameters<typeof useSearchResultTransition>[0]) => useSearchResultTransition(props),
      {
        initialProps: {
          inputTerm: "A",
          requestTerm: "A",
          isFetching: false,
          isPlaceholderData: false,
          hasData: true,
          hasError: false,
        },
      },
    );

    rerender({
      inputTerm: "A1",
      requestTerm: "A",
      isFetching: false,
      isPlaceholderData: false,
      hasData: true,
      hasError: false,
    });
    expect(result.current.resultsAreStale).toBe(true);

    rerender({
      inputTerm: "A1",
      requestTerm: "A1",
      isFetching: true,
      isPlaceholderData: true,
      hasData: true,
      hasError: false,
    });
    expect(result.current.resultsAreStale).toBe(true);

    rerender({
      inputTerm: "A1",
      requestTerm: "A1",
      isFetching: false,
      isPlaceholderData: false,
      hasData: true,
      hasError: false,
    });
    expect(result.current.resultsAreStale).toBe(false);

    rerender({
      inputTerm: "A1",
      requestTerm: "A1",
      isFetching: true,
      isPlaceholderData: true,
      hasData: true,
      hasError: false,
    });
    expect(result.current.resultsAreStale).toBe(false);

    rerender({
      inputTerm: "A2",
      requestTerm: "A2",
      isFetching: false,
      isPlaceholderData: true,
      hasData: true,
      hasError: true,
    });
    expect(result.current.resultsAreStale).toBe(true);
    expect(result.current.isSearching).toBe(false);
  });
});
