/* A zero-cost goods receipt must not be a dead end on the phone.
 *
 * `PATCH /scm/grns/:id/post` refuses a receipt that would open a zero-cost stock
 * layer and NAMES the two ways out: enter the unit price from the supplier's
 * goods-received document, or tick "Received free" on the line. Desktop has both
 * controls (`GoodsReceivedDetail`). Mobile had NEITHER — the receipt screen
 * offered "Post" and "Cancel", `zeroCostAck` appeared nowhere in
 * `frontend/src/mobile`, and the convert wizard's copy of the message told the
 * receiver to open the receipt on desktop. A receiver on the warehouse floor had
 * to go find a PC.
 *
 * FAILS ON THE PRE-FIX CODE — the sheet did not exist.
 *
 * These drive the REAL sheet with only `authedFetch` faked, so they cover the
 * controls AND the two writes they produce (`PATCH /grns/:id/items/:itemId`,
 * then the original `PATCH /grns/:id/post`).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authedFetch } = vi.hoisted(() => ({ authedFetch: vi.fn() }));
vi.mock("../vendor/scm/lib/authed-fetch", () => ({ authedFetch }));

import { MobileGrnZeroCostSheet, lineIsAnswered } from "./MobileGrnZeroCost";
import type { ZeroCostRefusal } from "../vendor/scm/lib/zero-cost-refusal";

afterEach(cleanup);
beforeEach(() => { authedFetch.mockReset(); authedFetch.mockResolvedValue({}); });

const REFUSAL: ZeroCostRefusal = {
  message: 'These lines would receive stock at zero cost, but the item has been purchased at a real price before.',
  remedy: ['Enter the unit price…', 'or tick "Received free"…'],
  lines: [
    { id: 'gi-1', itemCode: 'AKEMI-QD', qtyAccepted: 2, knownUnitCostSen: 45000 },
    { id: 'gi-2', itemCode: 'TRION-KD', qtyAccepted: 1, knownUnitCostSen: 120050 },
  ],
};

const wrap = (ui: React.ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
};

const sheet = (over: Partial<ZeroCostRefusal> = {}, onPosted = vi.fn()) => {
  wrap(
    <MobileGrnZeroCostSheet
      grnId="grn-1"
      refusal={{ ...REFUSAL, ...over }}
      onClose={vi.fn()}
      onPosted={onPosted}
    />,
  );
  return onPosted;
};

const patches = () =>
  authedFetch.mock.calls
    .filter(([url]) => String(url).includes('/items/'))
    .map(([url, init]) => ({ url: String(url), body: JSON.parse(String((init as { body: string }).body)) }));

describe("the remedy the refusal names is ON THE SCREEN", () => {
  it("names each refused line and what it normally costs", () => {
    sheet();
    /* The server's sentence lists them AND each line gets its own card, so both
       spellings of the code are on screen — that is the point, not a duplicate. */
    expect(screen.getAllByText(/AKEMI-QD/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/normally about RM450\.00 each/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/normally about RM1200\.50 each/).length).toBeGreaterThan(0);
  });

  it("offers BOTH ways out per line — a price and a Received-free tick", () => {
    sheet();
    expect(screen.getByLabelText("Unit price for AKEMI-QD")).toBeTruthy();
    expect(screen.getByLabelText("Received free: AKEMI-QD")).toBeTruthy();
    expect(screen.getByLabelText("Unit price for TRION-KD")).toBeTruthy();
  });
});

describe("posting again after the correction", () => {
  it("writes each line's unit price, then re-runs the post", async () => {
    const user = userEvent.setup();
    const onPosted = sheet();

    await user.type(screen.getByLabelText("Unit price for AKEMI-QD"), "450");
    await user.type(screen.getByLabelText("Unit price for TRION-KD"), "1200.50");
    await user.click(screen.getByRole("button", { name: /Save costs & post/ }));

    await vi.waitFor(() => expect(onPosted).toHaveBeenCalled());
    expect(patches()).toEqual([
      { url: "/grns/grn-1/items/gi-1", body: { unitPriceSen: 45000 } },
      { url: "/grns/grn-1/items/gi-2", body: { unitPriceSen: 120050 } },
    ]);
    const last = authedFetch.mock.calls.at(-1)!;
    expect(String(last[0])).toBe("/grns/grn-1/post");
    expect((last[1] as { method: string }).method).toBe("PATCH");
  });

  it("a genuinely free line rides as zeroCostAck + its reason, per line", async () => {
    const user = userEvent.setup();
    sheet();

    await user.click(screen.getByLabelText("Received free: AKEMI-QD"));
    await user.type(screen.getByLabelText("Why free: AKEMI-QD"), "GWP pillow");
    await user.type(screen.getByLabelText("Unit price for TRION-KD"), "1200.50");
    await user.click(screen.getByRole("button", { name: /Save costs & post/ }));

    await vi.waitFor(() => expect(authedFetch.mock.calls.length).toBe(3));
    expect(patches()[0]).toEqual({
      url: "/grns/grn-1/items/gi-1",
      body: { zeroCostAck: true, zeroCostReason: "GWP pillow" },
    });
  });

  it("is NOT a one-tap waiver — every line is answered on its own or nothing posts", async () => {
    /* "One click waiving a whole receipt is the reflex the gate exists to
       prevent" (docs/modules/grn.md). There is no waive-all control, and the
       post stays shut while any line is unanswered. */
    const user = userEvent.setup();
    sheet();

    const post = screen.getByRole("button", { name: /Save costs & post/ }) as HTMLButtonElement;
    expect(post.disabled).toBe(true);

    await user.click(screen.getByLabelText("Received free: AKEMI-QD"));
    expect((screen.getByRole("button", { name: /Save costs & post/ }) as HTMLButtonElement).disabled).toBe(true);

    await user.type(screen.getByLabelText("Unit price for TRION-KD"), "1200.50");
    expect((screen.getByRole("button", { name: /Save costs & post/ }) as HTMLButtonElement).disabled).toBe(false);
    expect(authedFetch).not.toHaveBeenCalled();
  });

  it("a second refusal is shown, not swallowed", async () => {
    const user = userEvent.setup();
    sheet();
    authedFetch.mockRejectedValue(new Error("TRION-KD is still at zero cost."));

    await user.type(screen.getByLabelText("Unit price for AKEMI-QD"), "450");
    await user.type(screen.getByLabelText("Unit price for TRION-KD"), "1200.50");
    await user.click(screen.getByRole("button", { name: /Save costs & post/ }));

    await vi.waitFor(() =>
      expect(screen.getByText("TRION-KD is still at zero cost.")).toBeTruthy());
  });
});

describe("a line the server could not identify", () => {
  it("says so instead of offering a control that writes nothing", () => {
    sheet({ lines: [{ id: null, itemCode: 'MYSTERY', qtyAccepted: 1, knownUnitCostSen: 999 }] });
    expect(screen.getByText(/cannot be corrected from here/)).toBeTruthy();
    expect((screen.getByRole("button", { name: /Save costs & post/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("the receipt screen in the receiver's hand reaches it", () => {
  const detail = readFileSync(resolve(process.cwd(), 'src/mobile/MobileModuleDetail.tsx'), 'utf8');

  it("the mobile document footer captures the refusal and opens the remedy", () => {
    /* Post and Cancel were the whole of the GRN footer's vocabulary. */
    expect(detail).toContain('useGrnZeroCostRemedy');
    expect(detail).toContain('zeroCost.capture(e)');
    expect(detail).toContain('{zeroCost.sheet}');
  });

  it("the convert wizard no longer sends the receiver to a PC", () => {
    const wizard = readFileSync(resolve(process.cwd(), 'src/mobile/MobileConvertWizard.tsx'), 'utf8');
    const line = wizard.slice(wizard.indexOf('zero_cost_receipt:'), wizard.indexOf('zero_cost_receipt:') + 400);
    expect(line).not.toContain('open the receipt on desktop');
  });
});

describe("lineIsAnswered mirrors the server's own condition", () => {
  it("a real price or an explicit tick, and nothing else", () => {
    expect(lineIsAnswered({ price: "", ack: false, reason: "" })).toBe(false);
    expect(lineIsAnswered({ price: "0", ack: false, reason: "" })).toBe(false);
    expect(lineIsAnswered({ price: "0.00", ack: false, reason: "" })).toBe(false);
    expect(lineIsAnswered({ price: "abc", ack: false, reason: "" })).toBe(false);
    expect(lineIsAnswered({ price: "0.01", ack: false, reason: "" })).toBe(true);
    expect(lineIsAnswered({ price: "", ack: true, reason: "" })).toBe(true);
  });
});
