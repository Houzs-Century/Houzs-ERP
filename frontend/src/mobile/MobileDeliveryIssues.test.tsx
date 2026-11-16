import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { fireEvent } from "@testing-library/dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

// Only the office create call is stubbed; summary/formatting stay real.
const createServiceCaseForIssue = vi.fn(async (..._a: unknown[]) => ({ id: 77, assr_no: "ASSR/2611-050" }));
vi.mock("../vendor/scm/lib/delivery-issue-queries", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  createServiceCaseForIssue: (...a: unknown[]) => createServiceCaseForIssue(...a),
}));

import { MobileDeliveryIssues } from "./DeliveryIssueForm";
import type { DeliveryIssue } from "../vendor/scm/lib/delivery-issue-queries";

afterEach(cleanup);

const unlinked: DeliveryIssue = {
  id: "i9", delivery_order_id: "d1", do_number: "HC-DO-000100", so_doc_no: "HC-SO-000200",
  source_type: null, source_id: null, leg: null, kinds: ["damaged"], note: "Leg cracked",
  photo_keys: ["slips/a"], assr_case_id: null, assr_no: null, reported_by: 1, reported_at: "2026-11-16T02:00:00Z",
};

function renderCard(canCreateCase: boolean, issue: DeliveryIssue = unlinked) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}><MobileDeliveryIssues issues={[issue]} canCreateCase={canCreateCase} /></QueryClientProvider>,
  );
}

describe("MobileDeliveryIssues — office create on the phone", () => {
  it("offers 'Create service case' for an unlinked report and calls the office create", async () => {
    renderCard(true);
    fireEvent.click(screen.getByRole("button", { name: "Create service case" }));
    await waitFor(() => expect(createServiceCaseForIssue).toHaveBeenCalledWith("i9"));
  });

  it("shows no create button without the permission", () => {
    renderCard(false);
    expect(screen.queryByRole("button", { name: "Create service case" })).toBeNull();
  });

  it("shows a link to the case once one is opened, and no button", () => {
    renderCard(true, { ...unlinked, assr_case_id: 77, assr_no: "ASSR/2611-050" });
    expect(screen.getByText(/Service case ASSR\/2611-050/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create service case" })).toBeNull();
  });
});
