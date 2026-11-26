
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { canLogSalesEntry, canWriteProjectFinance } from "./salesAccess";
import type { AuthUser } from "../types";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (rel: string) => readFileSync(resolve(HERE, "..", rel), "utf8");

const u = (over: Partial<AuthUser> = {}): AuthUser =>
  ({
    id: 1,
    email: "t@example.test",
    name: "T",
    role_id: 1,
    role_name: "user",
    status: "active",
    permissions: [],
    position_name: null,
    department_name: null,
    ...over,
  }) as AuthUser;

const canFor = (perms: string[]) => (perm: string) =>
  perms.includes("*") || perms.includes(perm);

describe("canLogSalesEntry — mirrors requirePageAccess('sales') on POST /api/sales/entries", () => {
  it("admits any level at or above partial, and refuses none", () => {
    expect(canLogSalesEntry("full")).toBe(true);
    expect(canLogSalesEntry("edit")).toBe(true);
    expect(canLogSalesEntry("partial")).toBe(true);
    expect(canLogSalesEntry("view")).toBe(true);
    expect(canLogSalesEntry("none")).toBe(false);
  });

  it("does NOT admit a Sales Director who has no 'sales' matrix row", () => {
    expect(canLogSalesEntry("none")).toBe(false);
  });
});

describe("canWriteProjectFinance — mirrors projects.write + denyFinance on PATCH /:id/finance", () => {
  it("needs projects.write — sales.write is not a term in that rule", () => {
    const salesRep = u({ position_id: 7, position_name: "Sales Executive" });
    expect(canWriteProjectFinance(salesRep, canFor(["sales.write"]))).toBe(false);
  });

  it("needs finance visibility — a positioned non-viewer is refused by denyFinance", () => {
    const positionedNonViewer = u({ position_id: 7, project_finance_viewer: false });
    expect(canWriteProjectFinance(positionedNonViewer, canFor(["projects.write"]))).toBe(false);
  });

  it("admits a finance viewer holding projects.write, with no sales grant at all", () => {
    const financeUser = u({ position_id: 3, project_finance_viewer: true });
    expect(canWriteProjectFinance(financeUser, canFor(["projects.write"]))).toBe(true);
  });

  it("keeps the backend's un-positioned legacy arm: position_id null is not hidden", () => {
    const unmigrated = u({ position_id: null });
    expect(canWriteProjectFinance(unmigrated, canFor(["projects.write"]))).toBe(true);
  });

  it("fails closed on no user", () => {
    expect(canWriteProjectFinance(null, canFor(["*"]))).toBe(false);
  });
});

const projects = () => src("pages/Projects.tsx");

const windowBefore = (needle: string, chars: number): string => {
  const text = projects();
  const at = text.indexOf(needle);
  expect(at, `anchor disappeared from Projects.tsx: ${needle}`).toBeGreaterThan(-1);
  return text.slice(Math.max(0, at - chars), at);
};

describe("Projects.tsx — the desktop control is gated on what the server enforces", () => {
  it("Archive / Restore asks for projects.manage", () => {
    expect(windowBefore('setArchiveMenuOpen((o) => !o)', 500)).toContain('"projects.manage"');
  });

  it("the STATUS dropdown asks for projects.write AND the PMS edit section", () => {
    const w = windowBefore("<ProjectStatusSelect", 400);
    expect(w).toContain('"projects.write"');
    // Same second term mobile carries (owner 2026-07-20: a project-level edit
    // needs the PMS EDIT section, so a sales PIC stays read-only).
    expect(w).toContain("canEditDetail");
  });

  it("+ Total Sales asks the finance-write helper, not a sales permission", () => {
    const w = windowBefore("> Total Sales", 1100);
    expect(w).toContain("canSetTotalSales");
    expect(w).not.toContain('can("sales.write")');
  });

  it("+ Quick Log asks the sales PAGE-ACCESS helper, not sales.write", () => {
    const w = windowBefore("> Quick Log", 700);
    expect(w).toContain("canLogSale");
    expect(w).not.toContain('can("sales.write")');
  });

  it("the sales section no longer derives either gate from can('sales.write')", () => {
    expect(projects()).not.toContain('can("sales.write")');
  });
});

const allWindowsBefore = (needle: string, chars: number): string[] => {
  const text = projects();
  let at = text.indexOf(needle);
  expect(at, `anchor disappeared from Projects.tsx: ${needle}`).toBeGreaterThan(-1);
  const out: string[] = [];
  while (at > -1) {
    out.push(text.slice(Math.max(0, at - chars), at));
    at = text.indexOf(needle, at + needle.length);
  }
  return out;
};

describe("Projects.tsx — Attach is offered to every role the server admits (0546)", () => {
  it("both surfaces read the badge rule from the one shared module", () => {
    for (const f of ["pages/Projects.tsx", "mobile/MobilePMS.tsx"]) {
      expect(src(f), `${f} no longer imports the shared badge rule`)
        .toContain('from "../auth/roleLabelAdmits"');
      expect(src(f), `${f} re-inlined its own copy of the rule`)
        .not.toContain("function roleLabelAdmitsRole(");
    }
  });

  it("every desktop Attach button reads a role-aware predicate, not projects.write alone", () => {
    const wins = allWindowsBefore("void startAttach()", 160);
    expect(wins.length).toBeGreaterThanOrEqual(2);
    for (const w of wins) expect(w).toMatch(/mayAttachRow/);
  });

  it("the document-table gate admits a tick-only role on its OWN badged row", () => {
    const w = windowBefore("canTick && roleLabelAdmitsRole(it.role_label", 500);
    expect(w).toContain("mayAttach");
    // The Sales Director exception (owner 2026-08-10) must survive beside it.
    expect(w).toContain("isSalesDirectorPos");
  });

  it("file DELETE follows ATTACH on BOTH surfaces (owner 2026-09-03)", () => {
    const text = projects();
    const w = windowBefore("aria-label=\"Remove attachment\"", 900);
    expect(w).toContain("mayDeleteFile");
    expect(text).toContain("roleLabelAdmitsRole(roleLabel, user?.role_name)");
    expect(text).toContain("mayAttachRow && !readOnlyAttach && a.id > 0");
    expect(text).toContain("attachment.id > 0 &&");

    const mobile = src("mobile/MobilePMS.tsx") + src("mobile/MobilePmsDocCard.tsx");
    const mobileCode = mobile
      .split(/\r?\n/)
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    expect(mobileCode).toContain("const canRemoveFile = canAttach;");
    expect(mobileCode).toContain("const canDeleteFiles = canTick;");
    expect(mobileCode).toContain("const canDeleteFiles = canWrite;");
    const mobileDeleteGates =
      mobileCode.match(/const (?:canDeleteFiles|canRemoveFile) = [^;]*/g) ?? [];
    expect(mobileDeleteGates.length).toBe(3);
    for (const gate of mobileDeleteGates) {
      expect(
        gate,
        "a mobile delete gate re-introduced projects.manage — the surfaces have drifted again",
      ).not.toContain("projects.manage");
    }
  });

  it("the file-card knows which task badge it is rendering", () => {
    const uses = (projects().match(/<TaskAttachmentRow/g) ?? []).length;
    const passes = (projects().match(/roleLabel=\{item\.role_label\}/g) ?? []).length;
    expect(passes, "a TaskAttachmentRow renders without its role badge").toBe(uses);
  });
});

describe("Projects.tsx — every list filter param is sticky", () => {
  it("PROJECTS_LIST_FILTER_KEYS covers each param the toolbar reads", () => {
    const text = projects();
    const keys = text.slice(
      text.indexOf("const PROJECTS_LIST_FILTER_KEYS = ["),
      text.indexOf("] as const;", text.indexOf("const PROJECTS_LIST_FILTER_KEYS = [")),
    );
    // Owner 2026-08-24: "once i filter here and click in project, then i back to
    // project list back all my filter gone". from/to (the date range that
    // replaced year+month) were missing, so useStickyFilters' pluck() dropped
    // them and the range alone did not survive the round-trip.
    for (const p of ["section", "task", "brand", "from", "to", "status", "page"]) {
      expect(keys, `${p} is read from the URL but never mirrored`).toContain(`"${p}"`);
    }
  });

  it("EXPORT sends every filter the on-screen list sends", () => {
    // Owner 2026-09-02: filtered Setup & Dismantle + My pending tasks to 10
    // rows, exported, and got every confirmed event — the export omitted
    // my_pending on purpose ("export is the full filtered list"). An export
    // that disagrees with the screen is a wrong document, so the two parameter
    // sets are now asserted equal rather than kept in step by hand.
    const text = projects();
    const between = (a: string, b: string) => {
      const i = text.indexOf(a);
      expect(i, `anchor disappeared: ${a}`).toBeGreaterThan(-1);
      return text.slice(i, text.indexOf(b, i));
    };
    const keysOf = (block: string) =>
      [...new Set((block.match(/^\s{10,14}([a-z_]+):/gm) ?? []).map((k) => k.trim().replace(":", "")))];
    const listKeys = keysOf(between("const list = useQuery", "per_page: perPage,"));
    const exportKeys = keysOf(between("const exportProjects = async", "per_page: per,"));
    expect(listKeys.length).toBeGreaterThan(8);
    for (const k of listKeys) {
      expect(exportKeys, `the export drops "${k}", so its rows differ from the screen`).toContain(k);
    }
  });
});

/* docs/bugs/0893 — owner 2026-09-14 (D4, 「根据最新的version」): an archived
   project stays editable on BOTH surfaces, which is what the desktop and the
   server already did. The phone had ANDed `!archived` into 23 edit, tick,
   upload, assign and P&L gates, so an event closed with late costs or a missing
   photo could not be finished from a phone. The status dropdown is the one
   control both surfaces withhold on an archived project. */
describe("an archived project withholds only its status, on both surfaces", () => {
  const code = (rel: string) =>
    src(rel)
      .split(/\r?\n/)
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");

  it("the phone gates exactly one control on archived — the status select", () => {
    const mobile = code("mobile/MobilePMS.tsx");
    const gates = mobile.match(/!archived\b/g) ?? [];
    expect(gates.length, "the phone re-locked something on an archived project").toBe(1);
    const at = mobile.indexOf("!archived");
    expect(mobile.slice(at, at + 400)).toContain('aria-label="Change status"');
  });

  it("the desktop gates the same one control", () => {
    const desk = code("pages/Projects.tsx");
    const gates = desk.match(/&& !p\.archived_at/g) ?? [];
    expect(gates.length).toBe(1);
    const at = desk.indexOf("&& !p.archived_at");
    expect(desk.slice(at, at + 200)).toContain("<ProjectStatusSelect");
  });
});
