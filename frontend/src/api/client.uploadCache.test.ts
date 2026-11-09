// B24: the four upload calls never cleared the 15-second read cache that the
// JSON writes clear, so a photo or file just uploaded looked missing until the
// cache expired, and staff uploaded it again.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AUTH_TOKEN_KEY } from "../lib/authToken";
import { setActiveCompanyId } from "../lib/activeCompany";
import { clearAll } from "./cache";
import { api } from "./client";

let photos = 0;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem(AUTH_TOKEN_KEY, "test-token");
  setActiveCompanyId(null);
  clearAll();
  photos = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "GET") photos += 1;
    return new Response(JSON.stringify({ photos }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const blob = () => new Blob(["x"], { type: "image/png" });
const file = () => new File(["x"], "a.png", { type: "image/png" });

const uploads: Array<[string, () => Promise<unknown>]> = [
  ["putBinary", () => api.putBinary("/api/delivery-orders/7/pod-photo", blob(), "image/png")],
  ["postBinary", () => api.postBinary("/api/delivery-orders/7/pod-photo", blob(), "image/png")],
  ["uploadFiles", () => api.uploadFiles("/api/delivery-orders/7/photos", [file()])],
  ["uploadFile", () => api.uploadFile("/api/delivery-orders/7/photos", file())],
  ["postForm", () => { const f = new FormData(); f.append("file", file()); return api.postForm("/api/delivery-orders/7/photos", f); }],
];

describe("an upload clears the cached read of its resource", () => {
  test.each(uploads)("%s", async (_name, upload) => {
    await expect(api.get("/api/delivery-orders/7")).resolves.toEqual({ photos: 0 });
    await upload();
    await expect(api.get("/api/delivery-orders/7")).resolves.toEqual({ photos: 1 });
  });

  test("a failed upload leaves the cache alone, like a failed JSON write", async () => {
    await api.get("/api/delivery-orders/7");
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(new Response("nope", { status: 500 }));
    await expect(api.putBinary("/api/delivery-orders/7/pod-photo", blob(), "image/png")).rejects.toThrow();
    const calls = vi.mocked(globalThis.fetch).mock.calls.length;
    await api.get("/api/delivery-orders/7");
    expect(vi.mocked(globalThis.fetch).mock.calls.length).toBe(calls);
  });
});
