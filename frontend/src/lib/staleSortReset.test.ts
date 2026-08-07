// The one-shot that spares every user from finding a Reset button on every list
// page, on every device. Owner, 2026-08-05: "为什么你不是后台 reset 呢？基本上我们
// 只会 reset 一次".
import { afterEach, describe, expect, it } from "vitest";
import { clearStaleTableSorts } from "./staleSortReset";

afterEach(() => localStorage.clear());

describe("clearStaleTableSorts", () => {
  it("removes every persisted table sort", () => {
    localStorage.setItem("dt:sort:delivery-orders", JSON.stringify({ key: "do_number", dir: "asc" }));
    localStorage.setItem("dt:sort:sales-orders", JSON.stringify({ key: "doc_no", dir: "asc" }));
    expect(clearStaleTableSorts()).toBe(2);
    expect(localStorage.getItem("dt:sort:delivery-orders")).toBeNull();
    expect(localStorage.getItem("dt:sort:sales-orders")).toBeNull();
  });

  it("leaves real preferences alone", () => {
    // Column layout, widths and the mobile view choice are things the user
    // actually chose. Wiping those to fix a sort bug would be taking something
    // away to fix something else.
    localStorage.setItem("dt:sort:orders", JSON.stringify({ key: "a", dir: "asc" }));
    localStorage.setItem("dt:hidden:orders", JSON.stringify(["status"]));
    localStorage.setItem("dt:widths:orders", JSON.stringify({ name: 200 }));
    localStorage.setItem("dt:mview:orders", JSON.stringify("table"));
    clearStaleTableSorts();
    expect(localStorage.getItem("dt:hidden:orders")).not.toBeNull();
    expect(localStorage.getItem("dt:widths:orders")).not.toBeNull();
    expect(localStorage.getItem("dt:mview:orders")).not.toBeNull();
  });

  it("runs exactly once — a sort chosen AFTER the fix survives", () => {
    localStorage.setItem("dt:sort:orders", JSON.stringify({ key: "a", dir: "asc" }));
    expect(clearStaleTableSorts()).toBe(1);

    // The user deliberately sorts something later. A second sweep would be the
    // app overriding a person, not cleaning up a bug.
    localStorage.setItem("dt:sort:orders", JSON.stringify({ key: "b", dir: "desc" }));
    expect(clearStaleTableSorts()).toBe(0);
    expect(localStorage.getItem("dt:sort:orders")).not.toBeNull();
  });

  it("is a no-op in a browser that never had one", () => {
    expect(clearStaleTableSorts()).toBe(0);
  });

  it("removes ALL of them, not every other one", () => {
    // Deleting while iterating by index shifts the remaining keys down and
    // silently skips half. Ten keys is enough for that to show.
    for (let i = 0; i < 10; i += 1) {
      localStorage.setItem(`dt:sort:table-${i}`, JSON.stringify({ key: "a", dir: "asc" }));
    }
    expect(clearStaleTableSorts()).toBe(10);
    for (let i = 0; i < 10; i += 1) {
      expect(localStorage.getItem(`dt:sort:table-${i}`)).toBeNull();
    }
  });
});
