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
  moduleFor: (path: string) => string;
  options: string[];
};

type Entry = { path: string; module: string; depth: number };

const pathOf = (to: string) => to.split(/[?#]/)[0].replace(/\/+$/, "") || "/";

export function itModuleIndex(tabs: NavTab[]): ItModuleIndex {
  const entries: Entry[] = [];
  const walk = (list: NavTab[], trail: string[]) => {
    for (const t of list) {
      const here = [...trail, t.label];
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
      if (!best || e.path.length > best.path.length || (e.path.length === best.path.length && e.depth > best.depth)) best = e;
    }
    return best?.module ?? "";
  };

  const options: string[] = [];
  for (const e of entries) {
    const m = moduleFor(e.path);
    if (m && !options.includes(m)) options.push(m);
  }
  return { moduleFor, options };
}
