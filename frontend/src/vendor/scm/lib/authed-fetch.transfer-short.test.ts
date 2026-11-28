import { beforeEach, describe, expect, test, vi } from "vitest";
import { AUTH_TOKEN_KEY } from "../../../lib/authToken";
import { authedFetch } from "./authed-fetch";
import { registerDialogService, type ConfirmOpts } from "./dialog-service";

const short409 = (canOverride: boolean) => new Response(JSON.stringify({
  error: "insufficient_stock",
  message: "SKU-1: requested 9, only 5 available at the source warehouse",
  shortages: [{ itemCode: "SKU-1", variantKey: "", requested: 9, available: 5 }],
  canOverride,
}), { status: 409 });

const asked: ConfirmOpts[] = [];
let answer = true;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem(AUTH_TOKEN_KEY, "test-token");
  vi.restoreAllMocks();
  asked.length = 0;
  registerDialogService({
    confirm: (o) => { asked.push(o); return Promise.resolve(answer); },
    notify: () => Promise.resolve(),
  });
});

const post = () => authedFetch<{ id: string }>("/stock-transfers", {
  method: "POST",
  body: JSON.stringify({ fromWarehouseId: "wh-1", toWarehouseId: "wh-2", items: [{ itemCode: "SKU-1", qty: 9 }] }),
});

describe("stock transfer short of stock", () => {
  test("Post anyway replays the same body with allowShortStock", async () => {
    answer = true;
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(short409(true))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "st-9" }), { status: 201 }));

    const res = await post();

    expect(res.id).toBe("st-9");
    expect(asked[0]?.confirmLabel).toBe("Post anyway");
    expect(asked[0]?.body).toMatch(/Transfer 9, only 5 at the source warehouse \(short 4\)/);
    const replay = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as Record<string, unknown>;
    expect(replay).toMatchObject({ items: [{ itemCode: "SKU-1", qty: 9 }], allowShortStock: true });
  });

  test("going back posts nothing and says so", async () => {
    answer = false;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(short409(true));
    await expect(post()).rejects.toThrow(/was not posted/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("a caller without the permission is told who can post it, with no confirm offered", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(short409(false));
    await expect(post()).rejects.toThrow(/"Post a stock transfer short of stock" permission/);
    expect(asked).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
