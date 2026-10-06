import { beforeEach, describe, expect, test, vi } from "vitest";
import { AUTH_TOKEN_KEY } from "../../../lib/authToken";
import { authedFetch } from "./authed-fetch";
import { registerDialogService, type ConfirmOpts } from "./dialog-service";

/* BUG-59: a DO cut from Sales Order lines that are not READY must ask first
   ("Item Not Ready"), and the operator may go back or deliver anyway. */

const notReady409 = () => new Response(JSON.stringify({
  error: "items_not_ready",
  message: "1 line is not ready to deliver: AERO-MP (K).",
  lines: [{ soItemId: "b", docNo: "HC-SO-009191", itemCode: "AERO-MP (K)", status: "PENDING", reason: "No stock has been set aside for this line yet." }],
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

describe("items_not_ready", () => {
  test("Deliver anyway replays the same body with confirmNotReady", async () => {
    answer = true;
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(notReady409())
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "do-1" }), { status: 201 }));

    const res = await authedFetch<{ id: string }>("/delivery-orders-mfg/from-sos", {
      method: "POST",
      body: JSON.stringify({ picks: [{ soItemId: "b", qty: 2 }] }),
    });

    expect(res.id).toBe("do-1");
    expect(asked[0]?.title).toBe("Item Not Ready");
    expect(asked[0]?.body).toMatch(/AERO-MP \(K\) \(HC-SO-009191\)/);
    const replay = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as Record<string, unknown>;
    expect(replay).toMatchObject({ picks: [{ soItemId: "b", qty: 2 }], confirmNotReady: true });
  });

  test("going back creates nothing and says so", async () => {
    answer = false;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(notReady409());

    await expect(authedFetch("/delivery-orders-mfg", {
      method: "POST",
      body: JSON.stringify({ items: [] }),
    })).rejects.toThrow(/not created/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
