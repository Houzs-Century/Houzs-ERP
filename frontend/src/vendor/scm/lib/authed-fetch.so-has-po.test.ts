import { beforeEach, describe, expect, test, vi } from "vitest";
import { AUTH_TOKEN_KEY } from "../../../lib/authToken";
import { authedFetch, soHasPoMessage } from "./authed-fetch";
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
    expect(asked[0]?.body).toMatch(/already raised on PO\(s\): 2990-PO-2611-036/);
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

describe("the prompt says where MRP is sending each PO now (owner 2026-11-19)", () => {
  const body = (lines: unknown[], extra: Record<string, unknown> = {}) =>
    `409 ${JSON.stringify({ error: "so_has_po", poNumbers: ["HC-PO-2611-143", "HC-PO-2611-256"], lines, ...extra })}`;
  test("POs given to other orders are named with the order they went to", () => {
    const msg = soHasPoMessage(body([
      { itemCode: "AKEMI ULTIMATE MATT (SK)", soDocNo: "HC-SO-003726", poNumber: "HC-PO-2611-143", assignedTo: ["HC-SO-012294"], coversThisSo: false },
      { itemCode: "AKEMI ULTIMATE MATT (SK)", soDocNo: "HC-SO-003726", poNumber: "HC-PO-2611-256", assignedTo: ["HC-SO-2611-174"], coversThisSo: false },
    ]));
    expect(msg).toContain("raised on HC-PO-2611-143 - MRP has given it to HC-SO-012294");
    expect(msg).toContain("raised on HC-PO-2611-256 - MRP has given it to HC-SO-2611-174");
    expect(msg).toContain("this order is short again");
  });
  test("a PO still covering this order warns of a double order", () => {
    const msg = soHasPoMessage(body([
      { itemCode: "XAMMAR-1A(LHF)", soDocNo: "2990-SO-2608-042", poNumber: "2990-PO-2611-036", assignedTo: ["2990-SO-2608-042"], coversThisSo: true },
    ]));
    expect(msg).toContain("still covering this order");
    expect(msg).toContain("order the same goods twice");
  });
  test("an unread assignment keeps the prompt and says so", () => {
    const msg = soHasPoMessage(body([{ itemCode: "X", soDocNo: "S", poNumber: "P", assignedTo: null, coversThisSo: null }], { assignmentError: "mrp_load_failed" }));
    expect(msg).toContain("Could not read where MRP is sending these POs (mrp_load_failed)");
  });
});
