import { describe, expect, test, vi } from "vitest";
import { buildRowMenu, dangerItem, type RowMenuItem } from "./rowMenu";

const it = (label: string): RowMenuItem => ({ label, onClick: () => {} });
const labels = (m: RowMenuItem[]) => m.map((x) => (x.divider ? "—" : x.label));

describe("buildRowMenu", () => {
  test("separates the groups it was given", () => {
    expect(labels(buildRowMenu([it("Open")], [it("Transfer")], [it("Cancel")])))
      .toEqual(["Open", "—", "Transfer", "—", "Cancel"]);
  });

  /* THE DIVIDER BUGS THIS EXISTS TO REMOVE. A row that does not qualify for a
     group must leave no trace of it — five hand-written menus would each have
     had to remember that, and on the day a status stops qualifying. */
  test("an empty group leaves no divider behind it", () => {
    expect(labels(buildRowMenu([it("Open")], [], [it("Cancel")])))
      .toEqual(["Open", "—", "Cancel"]);
  });

  test("a group emptied by its own predicates is the same as an absent one", () => {
    const draft = false;
    expect(labels(buildRowMenu([it("Open")], [draft && it("Transfer")], [it("Cancel")])))
      .toEqual(["Open", "—", "Cancel"]);
  });

  test("never starts with a divider", () => {
    const m = buildRowMenu([], [it("Transfer")]);
    expect(m[0]?.divider).toBeFalsy();
    expect(labels(m)).toEqual(["Transfer"]);
  });

  test("never ends with a divider", () => {
    const m = buildRowMenu([it("Open")], []);
    expect(m[m.length - 1]?.divider).toBeFalsy();
    expect(labels(m)).toEqual(["Open"]);
  });

  test("never renders two dividers in a row", () => {
    const m = buildRowMenu([it("Open")], [], [], [it("Cancel")]);
    expect(labels(m)).toEqual(["Open", "—", "Cancel"]);
    expect(m.filter((x) => x.divider)).toHaveLength(1);
  });

  test("every group empty is an empty menu, not a menu of separators", () => {
    expect(buildRowMenu([], [], [])).toEqual([]);
    expect(buildRowMenu([null], [false], [undefined])).toEqual([]);
  });

  test("the entries keep their own handlers", () => {
    const spy = vi.fn();
    const m = buildRowMenu([{ label: "Confirm", onClick: spy }]);
    m[0].onClick();
    expect(spy).toHaveBeenCalledOnce();
  });
});

describe("dangerItem", () => {
  test("marks the destructive entry so a red action cannot read as an ordinary one", () => {
    const d = dangerItem("Cancel", () => {});
    expect(d.danger).toBe(true);
    expect(d.label).toBe("Cancel");
  });

  test("survives the builder with its flag intact", () => {
    const m = buildRowMenu([it("Open")], [dangerItem("Cancel", () => {})]);
    expect(m.find((x) => x.label === "Cancel")?.danger).toBe(true);
  });
});
