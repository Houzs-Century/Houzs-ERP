import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useGuardedBack, useLeaveGuard } from "./useLeaveGuard";
import { leaveGuardActive, resetLeaveGuardForTests, setLeaveGuardAsker } from "../lib/leaveGuard";
import { hasUnsavedWork } from "../lib/unsavedWork";

afterEach(() => resetLeaveGuardForTests());

const nowhere = { pathname: "/", search: "" };

describe("useLeaveGuard", () => {
  it("holds while dirty, for leaving and for automatic reloads, and lets go when clean", () => {
    const { rerender } = renderHook(({ dirty }) => useLeaveGuard(dirty, null), { initialProps: { dirty: false } });
    expect(leaveGuardActive()).toBe(false);
    rerender({ dirty: true });
    expect(leaveGuardActive()).toBe(true);
    expect(hasUnsavedWork(nowhere)).toBe(true);
    rerender({ dirty: false });
    expect(leaveGuardActive()).toBe(false);
    expect(hasUnsavedWork(nowhere)).toBe(false);
  });

  it("allowLeave lets go at once, before the dirty flag catches up", () => {
    const { result } = renderHook(() => useLeaveGuard(true, null));
    expect(leaveGuardActive()).toBe(true);
    act(() => result.current.allowLeave());
    expect(leaveGuardActive()).toBe(false);
    expect(hasUnsavedWork(nowhere)).toBe(false);
  });
});

describe("useGuardedBack (the mobile screens' own Back)", () => {
  it("goes straight back when nothing is held", async () => {
    const onBack = vi.fn();
    const { result } = renderHook(() => useGuardedBack(onBack));
    await act(async () => result.current());
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("asks while a form is dirty, and stays when the person says stay", async () => {
    const ask = vi.fn(async () => false);
    setLeaveGuardAsker(ask);
    const onBack = vi.fn();
    renderHook(() => useLeaveGuard(true, null));
    const { result } = renderHook(() => useGuardedBack(onBack));
    await act(async () => result.current());
    expect(ask).toHaveBeenCalledTimes(1);
    expect(onBack).not.toHaveBeenCalled();
  });

  it("goes back when the person chooses to leave", async () => {
    setLeaveGuardAsker(async () => true);
    const onBack = vi.fn();
    renderHook(() => useLeaveGuard(true, null));
    const { result } = renderHook(() => useGuardedBack(onBack));
    await act(async () => result.current());
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
