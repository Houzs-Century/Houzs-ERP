import type { NavTab } from "../components/Sidebar";

/**
 * Which part of the ERP an IT request is about, named as the sidebar names it:
 * the top-level entry, plus the group under it when there is one
 * ("Supply Chain · Procurement", "Finance · Money in", "Projects"). The IT hub
 * groups requests by it, so its Reports can say which module has the most
 * problems. Built from the sidebar, so a new page is covered without a list to
 * keep up to date.
 */
export type ItModuleIndex = {
  /** The module of a page path ("/scm/grns?x=1"); "" when no sidebar entry covers it. */
  moduleFor: (path: string) => string;
  /** Every module, in sidebar order, for the picker. */
  options: string[];
};

type Entry = { path: string; module: string; depth: number };

const pathOf = (to: string) => to.split(/[?#]/)[0].replace(/\/+$/, "") || "/";

export function itModuleIndex(tabs: NavTab[]): ItModuleIndex {
  const entries: Entry[] = [];
  const walk = (list: NavTab[], trail: string[]) => {
    for (const t of list) {
      const here = [...trail, t.label];
      // A page is never its own module: a leaf takes its parents' name, a group its own.
      const named = t.children?.length ? here : here.length > 1 ? trail : here;
      const module = named.slice(0, 2).join(" · ");
      if (t.to) entries.push({ path: pathOf(t.to), module, depth: here.length });
      if (t.children) walk(t.children, here);
    }
  };
  walk(tabs, []);

  const moduleFor = (raw: string) => {
    const path = pathOf(raw);
    let best: Entry | null = null;
    for (const e of entries) {
      const covers = e.path === path || (e.path !== "/" && path.startsWith(`${e.path}/`));
      if (!covers) continue;
      // The longest path wins; on a tie the deeper entry, so a top-level
      // shortcut ("Sales Orders") reads as the group it belongs to.
      if (!best || e.path.length > best.path.length || (e.path.length === best.path.length && e.depth > best.depth)) best = e;
    }
    return best?.module ?? "";
  };

  // Options come from what each page resolves to, so a shortcut adds no extra name.
  const options: string[] = [];
  for (const e of entries) {
    const m = moduleFor(e.path);
    if (m && !options.includes(m)) options.push(m);
  }
  return { moduleFor, options };
}
