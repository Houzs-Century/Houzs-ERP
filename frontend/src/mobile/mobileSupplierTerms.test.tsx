/* The phone's supplier form picks Payment Terms from the desktop forms' list
 * (owner 2026-11-24: 「这里有些应该是选的吧？例如term这些」). Drives the REAL form
 * with FORM_SUPPLIERS. Pinned: a stored term on the list in another spelling
 * shows and saves as the list's entry; one off the list shows in the Custom box
 * and saves back as it is, never blanked; a picked term is what Save sends.
 * Faked: authedFetch (the currency list, and the PATCH it records).
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authedFetch } = vi.hoisted(() => ({ authedFetch: vi.fn() }));
vi.mock("../vendor/scm/lib/authed-fetch", () => ({ authedFetch }));

import { MobileModuleForm, PICK_LISTS } from "./MobileModuleForm";
import { FORM_SUPPLIERS } from "./MobileModuleList";
import { PAYMENT_TERMS, PAYMENT_TERMS_CUSTOM } from "../vendor/shared/pick-lists";

const SUPPLIER = { id: "s-1", code: "400-X001", name: "MADE UP SDN BHD", currency: "MYR", status: "ACTIVE" };

function openEdit(paymentTerms: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MobileModuleForm schema={FORM_SUPPLIERS} mode="edit" initial={{ ...SUPPLIER, payment_terms: paymentTerms }} onBack={() => {}} onSaved={() => {}} />
    </QueryClientProvider>,
  );
}
const terms = () => screen.getByLabelText("Payment Terms") as HTMLSelectElement;
const patchedBody = async (): Promise<Record<string, unknown>> => {
  fireEvent.click(screen.getByText("Save Changes"));
  await waitFor(() => expect(authedFetch.mock.calls.some((c) => c[1]?.method === "PATCH")).toBe(true));
  const call = authedFetch.mock.calls.find((c) => c[1]?.method === "PATCH")!;
  return JSON.parse(String(call[1].body));
};

beforeEach(() => {
  authedFetch.mockReset();
  authedFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
    if (init?.method === "PATCH") return { supplier: { id: SUPPLIER.id } };
    if (path.startsWith("/currencies")) return { currencies: [{ code: "MYR" }] };
    return {};
  });
});
afterEach(() => cleanup());

describe("the phone supplier form's Payment Terms", () => {
  it("is the desktop forms' list, with Custom for free text", () => {
    const f = FORM_SUPPLIERS.fields.find((x) => x.key === "paymentTerms");
    expect(f?.type).toBe("pick");
    expect(f?.pick).toBe("paymentTerms");
    expect(PICK_LISTS.paymentTerms.list).toBe(PAYMENT_TERMS);
    expect(PICK_LISTS.paymentTerms.other).toBe(PAYMENT_TERMS_CUSTOM);
  });

  it("shows a stored term spelled another way as the list's entry, and saves that entry", async () => {
    openEdit("net 30");
    expect(terms().value).toBe("NET 30");
    expect(screen.queryByLabelText("Payment Terms (Custom)")).toBeNull();
    expect((await patchedBody()).paymentTerms).toBe("NET 30");
  });

  it("opens a term the list does not have in the Custom box and saves it back as it is", async () => {
    openEdit("45 days after delivery");
    expect(terms().value).toBe(PAYMENT_TERMS_CUSTOM);
    expect((screen.getByLabelText("Payment Terms (Custom)") as HTMLInputElement).value).toBe("45 days after delivery");
    expect((await patchedBody()).paymentTerms).toBe("45 days after delivery");
  });

  it("saves a picked term", async () => {
    openEdit("45 days after delivery");
    fireEvent.change(terms(), { target: { value: "NET 60" } });
    expect(screen.queryByLabelText("Payment Terms (Custom)")).toBeNull();
    expect((await patchedBody()).paymentTerms).toBe("NET 60");
  });
});
