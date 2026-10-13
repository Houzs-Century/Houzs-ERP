// BUG-111 (Sim, 2026-10-13): 2990-PO-2609-042 printed the "Houzs Century Sdn
// Bhd" letterhead. The PDF letterhead reads the module-level branding cache,
// which useBranding fills from GET /api/branding. That answer depends on the
// tab's X-Company-Id header, but the query key did not carry the company: an
// answer fetched before the tab adopted 2990 (no header -> hostname default
// HOUZS) stayed "fresh" for 10 minutes and every PDF in that window printed
// Houzs.
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const apiGet = vi.fn();
vi.mock("../api/client", () => ({ api: { get: (...a: unknown[]) => apiGet(...a) } }));

import { queryClient } from "../lib/queryClient";
import { getActiveCompanyId, setActiveCompanyId } from "../lib/activeCompany";
import { DEFAULT_BRANDING, getBrandingCache, setBrandingCache } from "../lib/branding";
import { ensureBrandingForActiveCompany, useBranding } from "./useBranding";

const HOUZS = { companyCode: "HOUZS", branding: { companyName: "Houzs Century Sdn Bhd" } };
const H2990 = {
  companyCode: "2990",
  branding: { companyName: "2990 HOME SDN. BHD.", registrationNo: "202501060667" },
};

function Probe() {
  useBranding();
  return null;
}

beforeEach(() => {
  apiGet.mockReset();
  // The backend resolves the company from this tab's X-Company-Id header.
  apiGet.mockImplementation(async () => (getActiveCompanyId() === 2 ? H2990 : HOUZS));
  queryClient.clear();
  setActiveCompanyId(null);
  setBrandingCache({ ...DEFAULT_BRANDING }, "HOUZS");
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no logo in tests"));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setActiveCompanyId(null);
});

describe("BUG-111 letterhead follows the tab's company", () => {
  test("an answer fetched before the tab adopted 2990 is not reused for it", async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <Probe />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(getBrandingCache().companyName).toBe("Houzs Century Sdn Bhd"));

    act(() => setActiveCompanyId(2));

    await waitFor(() => expect(getBrandingCache().companyName).toBe("2990 HOME SDN. BHD."));
    expect(getBrandingCache().registrationNo).toBe("202501060667");
  });

  test("printing fetches the active company's letterhead when the cache has not caught up", async () => {
    setActiveCompanyId(2);
    expect(getBrandingCache().companyName).toBe("Houzs Century Sdn Bhd");

    await ensureBrandingForActiveCompany();

    expect(getBrandingCache().companyName).toBe("2990 HOME SDN. BHD.");
  });

  test("printing refuses rather than guessing when the letterhead cannot be loaded", async () => {
    setActiveCompanyId(2);
    apiGet.mockRejectedValue(new Error("network down"));

    await expect(ensureBrandingForActiveCompany()).rejects.toThrow(/letterhead/i);
    expect(getBrandingCache().companyName).toBe("Houzs Century Sdn Bhd");
  });
});
