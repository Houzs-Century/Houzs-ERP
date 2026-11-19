import { beforeEach, describe, expect, test, vi } from "vitest";
import { AUTH_TOKEN_KEY } from "../../../lib/authToken";
import { authedFetch } from "./authed-fetch";
import { registerDialogService, type ConfirmOpts } from "./dialog-service";

/* 2990-0065: generating a PO for Sales Order lines that already sit on a live PO
   must ask first, naming the PO, and the operator may continue or stop. */

const soHasPo409 = () => new Response(JSON.stringify({
  error: "so_has_po",
  reason: "This Sales Order already has PO(s): 2990-PO-2611-036.",
  poNumbers: ["2990-PO-2611-036"],
  lines: [
    { soItemId: "a", soDocNo: "2990-SO-2608-042", itemCode: "XAMMAR-1A(LHF)", poNumber: "2990-PO-2611-036" },
    { soItemId: "b", soDocNo: "2990-SO-2608-042", itemCode: "XAMMAR-2A(RHF)", poNumber: "2990-PO-2611-036" },
  ],
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

describe("so_has_po", () => {
  test("Continue replays the same body with confirmDuplicatePo", async () => {
    answer = true;
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(soHasPo409())
      .mockResolvedValueOnce(new Response(JSON.stringify({ created: [{ poNumber: "2990-PO-2611-050" }] }), { status: 201 }));

    const res = await authedFetch<{ created: Array<{ poNumber: string }> }>("/mfg-purchase-orders/from-sos", {
      method: "POST",
      body: JSON.stringify({ picks: [{ soItemId: "a", qty: 1 }, { soItemId: "b", qty: 1 }], fromMrp: true }),
    });

    expect(res.created[0]?.poNumber).toBe("2990-PO-2611-050");
    expect(asked[0]?.title).toBe("PO already generated for this Sales Order");
    expect(asked[0]?.body).toMatch(/already has PO\(s\): 2990-PO-2611-036/);
    expect(asked[0]?.body).toMatch(/XAMMAR-1A\(LHF\) \(2990-SO-2608-042\)/);
    const replay = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as Record<string, unknown>;
    expect(replay).toMatchObject({ fromMrp: true, confirmDuplicatePo: true });
  });

  test("stopping generates no PO and says so", async () => {
    answer = false;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(soHasPo409());

    await expect(authedFetch("/mfg-purchase-orders", {
      method: "POST",
      body: JSON.stringify({ items: [{ soItemId: "a" }] }),
    })).rejects.toThrow(/No purchase order was generated/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
