import { describe, it, expect, beforeEach } from "vitest";
import { findHighlightTarget, normLabel, withoutHighlight } from "./highlight-match";

describe("findHighlightTarget", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <h1>Purchase Orders</h1>
      <button id="new"><svg></svg><span> New   Purchase Order </span></button>
      <div hidden><button id="hidden">Post</button></div>
      <button id="post">Post</button>
      <label id="lab" for="w">From Warehouse <span>*</span></label><select id="w"></select>
      <button id="icon" aria-label="Print PDF"><svg></svg></button>
      <p>Click New Purchase Order to start.</p>`;
  });

  it("matches trimmed, case-insensitive text and returns the button, not the inner span", () => {
    expect(findHighlightTarget(document, "new purchase order")?.id).toBe("new");
  });

  it("skips hidden elements", () => {
    expect(findHighlightTarget(document, "Post")?.id).toBe("post");
  });

  it("matches a required-field label with its asterisk", () => {
    expect(findHighlightTarget(document, "From Warehouse *")?.id).toBe("lab");
  });

  it("matches an icon button by aria-label", () => {
    expect(findHighlightTarget(document, "Print PDF")?.id).toBe("icon");
  });

  it("returns null for no match or an empty label, and never matches a sentence containing it", () => {
    expect(findHighlightTarget(document, "Delete everything")).toBeNull();
    expect(findHighlightTarget(document, "   ")).toBeNull();
    expect(findHighlightTarget(document, "Click")).toBeNull();
  });

  it("drops only the highlight parameter", () => {
    expect(withoutHighlight("https://erp.test/assr?view=cases&highlight=New%20Case#x")).toBe("/assr?view=cases#x");
    expect(normLabel("  New 	  Case ")).toBe("new case");
  });
});
