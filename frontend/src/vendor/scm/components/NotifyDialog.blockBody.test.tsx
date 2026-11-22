/* A message dialog whose body holds a list (the save-problems list, for one) threw a console error: the body was
   wrapped in a <p>, and a <ul> inside a <p> is invalid HTML (React: "<ul> cannot be a descendant of <p>").
   Ported from Conts ERP #1125. */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotifyDialog } from "./NotifyDialog";

afterEach(cleanup);

describe("NotifyDialog body", () => {
  it("a list body renders without a nesting error and is not inside a paragraph", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { container } = render(
      <NotifyDialog title="Can't save" body={<ul><li>Line 1 has no product</li></ul>} onClose={() => {}} />,
    );
    expect(container.querySelector("p ul")).toBeNull();
    expect(container.querySelector("ul")).not.toBeNull();
    expect(err.mock.calls.some((c) => String(c[0]).includes("cannot be a descendant") || String(c[0]).includes("validateDOMNesting"))).toBe(false);
    err.mockRestore();
  });
});
