import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AUTH_TOKEN_KEY } from "../lib/authToken";
import { setActiveCompanyId } from "../lib/activeCompany";
import { api } from "./client";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem(AUTH_TOKEN_KEY, "test-token");
  setActiveCompanyId(null);
});

afterEach(() => {
  vi.restoreAllMocks();
  setActiveCompanyId(null);
});

describe("api.get cache is per company", () => {
  test("a read made before the tab adopted its company does not answer for it", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const company = new Headers(init?.headers).get("X-Company-Id");
      const body = { companyCode: company === "2" ? "2990" : "HOUZS" };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    await expect(api.get("/api/branding")).resolves.toEqual({ companyCode: "HOUZS" });
    setActiveCompanyId(2);
    await expect(api.get("/api/branding")).resolves.toEqual({ companyCode: "2990" });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await expect(api.get("/api/branding")).resolves.toEqual({ companyCode: "2990" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
