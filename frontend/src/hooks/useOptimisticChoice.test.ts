import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useOptimisticChoice } from "./useOptimisticChoice";

const deferredSave = () => {
  let finish: (isSaved: boolean) => void = () => undefined;
  const save = () => new Promise<boolean>((resolve) => { finish = resolve; });
  return { save, finish: (isSaved: boolean) => finish(isSaved) };
};

describe("useOptimisticChoice", () => {
  it("showsThePickBeforeTheSaveFinishes", () => {
    const { result } = renderHook(({ saved }) => useOptimisticChoice(saved), { initialProps: { saved: null as string | null } });
    const { save } = deferredSave();

    act(() => { void result.current.choose("customer", save); });

    expect(result.current.shownValue).toBe("customer");
  });

  it("goesBackToTheSavedValueWhenTheSaveFails", async () => {
    const { result } = renderHook(({ saved }) => useOptimisticChoice(saved), { initialProps: { saved: "supplier" as string | null } });
    const { save, finish } = deferredSave();

    let choosing: Promise<void> = Promise.resolve();
    act(() => { choosing = result.current.choose("customer", save); });
    await act(async () => { finish(false); await choosing; });

    expect(result.current.shownValue).toBe("supplier");
  });

  it("followsTheSavedValueOnceTheReloadLands", async () => {
    const { result, rerender } = renderHook(({ saved }) => useOptimisticChoice(saved), { initialProps: { saved: null as string | null } });
    const { save, finish } = deferredSave();

    let choosing: Promise<void> = Promise.resolve();
    act(() => { choosing = result.current.choose("customer", save); });
    await act(async () => { finish(true); await choosing; });
    rerender({ saved: "customer" });
    rerender({ saved: "supplier" });

    expect(result.current.shownValue).toBe("supplier");
  });
});
