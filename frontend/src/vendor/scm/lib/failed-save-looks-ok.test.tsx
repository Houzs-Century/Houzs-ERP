/* A save that half-failed must not read as a clean success (fix/failed-save-looks-ok).
   1. DO status: `movementErrors` on a 200 from PATCH /delivery-orders-mfg/:id/status.
   2. GRN: `recountError` on POST /grns and PATCH /grns/:id/post.
   5. SO edit-lock Override: unlocks only when the server kept the typed reason. */
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, test, vi } from "vitest";

const { serviceNotify, authedFetch } = vi.hoisted(() => ({ serviceNotify: vi.fn(), authedFetch: vi.fn() }));
vi.mock("./dialog-service", () => ({ serviceNotify }));
vi.mock("./authed-fetch", () => ({ authedFetch }));
vi.mock("./so-versioned-mutation", async (orig) => ({
  ...(await orig<typeof import("./so-versioned-mutation")>()),
  resolveLoadedSoVersion: vi.fn(async () => 3),
}));

import { doStatusInBandTitle, useUpdateMfgDeliveryOrderStatus } from "./delivery-order-queries";
import { usePostGrn } from "./grn-queries";
import { grnCreatedOutcome } from "./grn-create-outcome";
import { inBandFailureText } from "./mutation-error";
import { useOverrideSoLock } from "./sales-order-queries";
import { actionDoneNotice } from "../../../mobile/doc-actions";

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
};

beforeEach(() => { serviceNotify.mockReset(); authedFetch.mockReset(); });

describe("1 · a DO shipped with its stock OUT refused says so", () => {
  test("the status hook warns with the server's items", async () => {
    authedFetch.mockResolvedValue({ deliveryOrder: { id: "do-1", status: "LOADED" }, movementErrors: ["OUT DO-2611-001: negative stock on SKU-9"] });
    const { result } = renderHook(() => useUpdateMfgDeliveryOrderStatus(), { wrapper });
    await result.current.mutateAsync({ id: "do-1", status: "LOADED" });
    await waitFor(() => expect(serviceNotify).toHaveBeenCalled());
    const n = serviceNotify.mock.calls[0]![0] as { title: string; body: string; tone: string };
    expect(n.title).toBe("DO confirmed, but stock was NOT deducted");
    expect(n.body).toContain("OUT DO-2611-001: negative stock on SKU-9");
    expect(n.body).toContain("tell IT");
    expect(n.tone).toBe("error");
  });

  test("a clean ship says nothing extra", async () => {
    authedFetch.mockResolvedValue({ deliveryOrder: { id: "do-1", status: "DISPATCHED" } });
    const { result } = renderHook(() => useUpdateMfgDeliveryOrderStatus(), { wrapper });
    await result.current.mutateAsync({ id: "do-1", status: "DISPATCHED" });
    expect(serviceNotify).not.toHaveBeenCalled();
  });

  test("titles name what happened", () => {
    expect(doStatusInBandTitle("DISPATCHED")).toBe("DO shipped, but stock was NOT deducted");
    expect(doStatusInBandTitle("CANCELLED")).toBe("DO cancelled, but stock was NOT returned");
  });

  test("the phone's footer action says it too, not 'Done'", () => {
    expect(actionDoneNotice("Confirm", { movementErrors: ["OUT DO-1: refused"] })).toMatchObject({ title: "Confirm saved, but not everything was recorded", tone: "error" });
    expect(actionDoneNotice("Confirm", { deliveryOrder: {} })).toEqual({ title: "Done" });
    expect(actionDoneNotice("Confirm", undefined)).toEqual({ title: "Done" });
  });
});

describe("2 · a GRN whose PO recount failed does not say 'PO received qty updated'", () => {
  test("the New GRN dialog shows the real outcome", () => {
    const bad = grnCreatedOutcome("GRN-1", false, { recountError: "timeout" });
    expect(bad.title).toContain("NOT everything was recorded");
    expect(bad.body).toContain("received quantity was NOT updated (timeout)");
    expect(bad.body).not.toContain("PO received qty updated");
    expect(grnCreatedOutcome("GRN-1", false, {}).body).toBe("Received & posted — inventory + PO received qty updated.");
    expect(grnCreatedOutcome("GRN-1", true, { recountError: "x" }).title).toBe("GRN GRN-1 saved as draft");
  });

  test("Confirm on a draft GRN warns about the recount", async () => {
    authedFetch.mockResolvedValue({ grn: {}, recountError: "deadlock" });
    const { result } = renderHook(() => usePostGrn(), { wrapper });
    await result.current.mutateAsync("g-1");
    await waitFor(() => expect(serviceNotify).toHaveBeenCalled());
    expect((serviceNotify.mock.calls[0]![0] as { body: string }).body).toContain("(deadlock)");
  });

  test("stock wording is unchanged and both can appear", () => {
    const t = inBandFailureText({ movementErrors: ["IN GRN-1: x"], recountError: "y" })!;
    expect(t).toContain("IN GRN-1: x\n\nThe document is saved. Stock was NOT adjusted");
    expect(t).toContain("NOT updated (y)");
    expect(inBandFailureText({})).toBeNull();
  });
});

describe("5 · SO Override unlocks only on a kept reason", () => {
  test("sends the typed reason", async () => {
    authedFetch.mockResolvedValue({ overrideRecorded: true });
    const { result } = renderHook(() => useOverrideSoLock(), { wrapper });
    await result.current.mutateAsync({ docNo: "SO-1", status: "SHIPPED", reason: "customer moved house" });
    const [url, init] = authedFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/mfg-sales-orders/SO-1/status");
    expect(JSON.parse(String(init.body))).toMatchObject({ status: "SHIPPED", overrideReason: "customer moved house" });
  });

  test("a refused PATCH fails and shows why", async () => {
    authedFetch.mockRejectedValue(new Error("Version conflict"));
    const onSuccess = vi.fn();
    const { result } = renderHook(() => useOverrideSoLock(), { wrapper });
    result.current.mutate({ docNo: "SO-1", status: "SHIPPED", reason: "customer moved house" }, { onSuccess });
    await waitFor(() => expect(serviceNotify).toHaveBeenCalled());
    expect(onSuccess).not.toHaveBeenCalled();
    expect((serviceNotify.mock.calls[0]![0] as { title: string }).title).toBe("Override not saved — the SO stays locked");
  });

  test("an answer that did not keep the reason is a failure", async () => {
    authedFetch.mockResolvedValue({ unchanged: true });
    const { result } = renderHook(() => useOverrideSoLock(), { wrapper });
    await expect(result.current.mutateAsync({ docNo: "SO-1", status: "SHIPPED", reason: "customer moved house" })).rejects.toThrow(/did not record/);
  });
});
