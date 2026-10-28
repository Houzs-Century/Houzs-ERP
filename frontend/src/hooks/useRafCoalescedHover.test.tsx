import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useRafCoalescedHover } from "./useRafCoalescedHover";

type Hover = { id: number; x: number; y: number };

describe("useRafCoalescedHover", () => {
  let nextFrameId: number;
  let frames: Map<number, FrameRequestCallback>;
  let cancelAnimationFrame: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    nextFrameId = 1;
    frames = new Map();
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      const id = nextFrameId++;
      frames.set(id, callback);
      return id;
    }));
    cancelAnimationFrame = vi.fn((id: number) => frames.delete(id));
    vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrame);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("publishes entry immediately and coalesces moves to the latest value per frame", () => {
    const { result } = renderHook(() => useRafCoalescedHover<Hover>());

    act(() => result.current.enter({ id: 1, x: 10, y: 20 }));
    expect(result.current.hover).toEqual({ id: 1, x: 10, y: 20 });

    act(() => {
      result.current.move({ id: 1, x: 11, y: 21 });
      result.current.move({ id: 1, x: 12, y: 22 });
      result.current.move({ id: 1, x: 13, y: 23 });
    });

    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    expect(result.current.hover).toEqual({ id: 1, x: 10, y: 20 });

    const [[frameId, callback]] = [...frames.entries()];
    frames.delete(frameId);
    act(() => callback(16));

    expect(result.current.hover).toEqual({ id: 1, x: 13, y: 23 });
  });

  it("cancels a queued move when the pointer leaves", () => {
    const { result } = renderHook(() => useRafCoalescedHover<Hover>());

    act(() => {
      result.current.enter({ id: 1, x: 1, y: 1 });
      result.current.move({ id: 1, x: 2, y: 2 });
      result.current.leave();
    });

    expect(result.current.hover).toBeNull();
    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
    expect(frames).toHaveLength(0);
  });

  it("cancels queued work on unmount so it cannot update an abandoned page", () => {
    const { result, unmount } = renderHook(() => useRafCoalescedHover<Hover>());

    act(() => result.current.move({ id: 1, x: 5, y: 6 }));
    expect(frames).toHaveLength(1);

    unmount();

    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
    expect(frames).toHaveLength(0);
  });
});
