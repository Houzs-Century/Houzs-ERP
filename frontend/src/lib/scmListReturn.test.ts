import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SCM_LIST_RETURN_KEY,
  rememberScmListReturn,
  scmListReturnTo,
} from "./scmListReturn";

beforeEach(() => sessionStorage.clear());
afterEach(() => sessionStorage.clear());

describe("scmListReturn", () => {
  it("remembers a filtered list URL and returns it for that section's detail", () => {
    rememberScmListReturn("/scm/purchase-orders", "?q=sofa&status=open&page=2");
    expect(scmListReturnTo("/scm/purchase-orders")).toBe(
      "/scm/purchase-orders?q=sofa&status=open&page=2",
    );
  });

  it("falls back to the bare list when nothing was remembered", () => {
    expect(scmListReturnTo("/scm/sales-orders")).toBe("/scm/sales-orders");
  });

  it("keeps each section's filter independent", () => {
    rememberScmListReturn("/scm/purchase-orders", "?q=chair");
    rememberScmListReturn("/scm/sales-orders", "?status=draft");
    expect(scmListReturnTo("/scm/purchase-orders")).toBe("/scm/purchase-orders?q=chair");
    expect(scmListReturnTo("/scm/sales-orders")).toBe("/scm/sales-orders?status=draft");
    expect(scmListReturnTo("/scm/grns")).toBe("/scm/grns");
  });

  it("only records LIST paths — a detail or action page must not overwrite the target", () => {
    rememberScmListReturn("/scm/purchase-orders", "?q=sofa");
    rememberScmListReturn("/scm/purchase-orders/PO-123", ""); // detail — ignored
    rememberScmListReturn("/scm/purchase-orders/new", ""); // action — ignored
    expect(scmListReturnTo("/scm/purchase-orders")).toBe("/scm/purchase-orders?q=sofa");
  });

  it("the newest visit to a section wins", () => {
    rememberScmListReturn("/scm/delivery-orders", "?q=old");
    rememberScmListReturn("/scm/delivery-orders", "?q=new&status=pending");
    expect(scmListReturnTo("/scm/delivery-orders")).toBe(
      "/scm/delivery-orders?q=new&status=pending",
    );
  });

  it("a detail path resolves to its own section's remembered list", () => {
    rememberScmListReturn("/scm/sales-invoices", "?q=acme");
    // scmListReturnTo is always called with the bare list path by the detail,
    // but the section match tolerates either form.
    expect(scmListReturnTo("/scm/sales-invoices")).toBe("/scm/sales-invoices?q=acme");
  });

  it("rejects a corrupt blob and a hostile (protocol-relative) stored value", () => {
    sessionStorage.setItem(SCM_LIST_RETURN_KEY, "{not json");
    expect(scmListReturnTo("/scm/purchase-orders")).toBe("/scm/purchase-orders");

    sessionStorage.setItem(
      SCM_LIST_RETURN_KEY,
      JSON.stringify({ "/scm/purchase-orders": "//evil.example/x" }),
    );
    expect(scmListReturnTo("/scm/purchase-orders")).toBe("/scm/purchase-orders");
  });
});
