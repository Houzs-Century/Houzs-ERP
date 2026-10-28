import { beforeEach, describe, expect, test, vi } from "vitest";
import { AUTH_TOKEN_KEY } from "../lib/authToken";
import { api } from "./client";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem(AUTH_TOKEN_KEY, "test-token");
  vi.restoreAllMocks();
});

describe("core API cancellation", () => {
  test("cancelling after a 503 prevents a retry after backoff", async () => {
    const caller = new AbortController();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      queueMicrotask(() => caller.abort(new DOMException("Aborted", "AbortError")));
      return new Response("temporarily unavailable", { status: 503 });
    });

    await expect(api.get("/api/projects?search=A", { signal: caller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
