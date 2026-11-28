import type { HowtoGate } from "./mcp-howto-types";

/** One button, menu item, tab, link or toggle on a page. `label` is the exact UI text (checked against frontend/src). */
export type ScreenAction = {
  label: string;
  kind: "button" | "menu" | "tab" | "link" | "toggle" | "field";
  does: string;
  permission: string;
  gate: HowtoGate | null;
  sideEffects: string;
};

/** One page of the ERP router: what it is for, how to reach it, and every action on it. */
export type ScreenPage = {
  path: string;
  title: string;
  purpose: string;
  sidebar: string | null;
  gate: HowtoGate;
  keywords: string[];
  sections: string[];
  tabs: string[];
  actions: ScreenAction[];
  detail: "full" | "basic";
};
