import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { state, get } = vi.hoisted(() => ({
  state: { data: null as { connected: boolean } | null },
  get: vi.fn(),
}));
vi.mock("../api/client", () => ({ api: { get } }));
vi.mock("./useQuery", () => ({
  useQuery: (key: string, fetcher: () => unknown) => {
    void fetcher();
    return { key, data: state.data, loading: false, error: null, reload: () => {} };
  },
}));

import { useItSupportConnected, withoutUnconnectedItSupport } from "./useItSupportConnected";

const TABS = [{ to: "/announcements" }, { to: "/it-support" }, { to: "/settings" }, {}];

beforeEach(() => {
  state.data = null;
  get.mockReset();
});

describe("IT Support menu row follows the connection", () => {
  it("asks the status endpoint, and is true only once the server has said so", () => {
    expect(renderHook(() => useItSupportConnected()).result.current).toBe(false);
    expect(get).toHaveBeenCalledWith("/api/it-support/status");
    state.data = { connected: false };
    expect(renderHook(() => useItSupportConnected()).result.current).toBe(false);
    state.data = { connected: true };
    expect(renderHook(() => useItSupportConnected()).result.current).toBe(true);
  });

  it("drops only the IT Support row, and only when not connected", () => {
    expect(withoutUnconnectedItSupport(TABS, true)).toEqual(TABS);
    expect(withoutUnconnectedItSupport(TABS, false)).toEqual([{ to: "/announcements" }, { to: "/settings" }, {}]);
  });
});
