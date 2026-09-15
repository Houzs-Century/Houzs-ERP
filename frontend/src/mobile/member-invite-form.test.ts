import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { FORM_MEMBERS, FORM_MEMBERS_EDIT } from "./MobileModuleList";
import {
  memberEditFormFor,
  memberInviteFormFor,
  SCOPED_DIRECTOR_EDITABLE_MEMBER_FIELDS,
} from "./member-invite-form";
import { stripComments } from "../auth/sourceScan.testutil";

const HERE = dirname(fileURLToPath(import.meta.url));
const keys = (f: { fields: { key: string }[] }) => f.fields.map((x) => x.key);

/* docs/bugs/0887 — the phone's Member invite offered a Sales Director a Role
   picker listing every role, and the server stored whatever came back. The
   server now forces the baseline role for that caller; this pins the phone
   half, so the form stops offering a choice the save ignores. */
describe("memberInviteFormFor", () => {
  test("the base invite form really does carry a Role picker (premise)", () => {
    expect(keys(FORM_MEMBERS)).toContain("role_id");
  });

  test("a scoped Sales Director gets no Role field", () => {
    expect(keys(memberInviteFormFor(FORM_MEMBERS, true))).not.toContain("role_id");
  });

  test("only the Role field goes — email, name, department, position and phone stay", () => {
    expect(keys(memberInviteFormFor(FORM_MEMBERS, true))).toEqual(
      keys(FORM_MEMBERS).filter((k) => k !== "role_id"),
    );
  });

  test("everyone else keeps the form unchanged, same object", () => {
    expect(memberInviteFormFor(FORM_MEMBERS, false)).toBe(FORM_MEMBERS);
  });

  test("the shared form itself is not mutated", () => {
    memberInviteFormFor(FORM_MEMBERS, true);
    expect(keys(FORM_MEMBERS)).toContain("role_id");
  });
});

/* docs/bugs/0924-a-sales-director-s-phone-edit-of-a-member-s-role-department.md
   — the phone's Edit Member form offered a scoped Sales Director
   Role, Department, Position and Email. PATCH /api/users/:id deletes all four for
   that caller and still answers ok, so the edit "saved" and nothing changed. */
describe("memberEditFormFor", () => {
  test("the base edit form really does carry the fields the scoped save strips (premise)", () => {
    for (const k of ["role_id", "department_id", "position_id", "email"]) {
      expect(keys(FORM_MEMBERS_EDIT)).toContain(k);
    }
  });

  test("a scoped Sales Director keeps exactly Name, Phone and Status, in form order", () => {
    expect(keys(memberEditFormFor(FORM_MEMBERS_EDIT, true))).toEqual(["name", "phone", "status"]);
  });

  test("every field the scoped form keeps is one the save applies", () => {
    for (const k of keys(memberEditFormFor(FORM_MEMBERS_EDIT, true))) {
      expect(SCOPED_DIRECTOR_EDITABLE_MEMBER_FIELDS).toContain(k);
    }
  });

  test("a field added to the edit form later stays hidden from that caller", () => {
    const withManager = {
      ...FORM_MEMBERS_EDIT,
      fields: [...FORM_MEMBERS_EDIT.fields, { key: "manager_id", label: "Reports to", type: "select" as const }],
    };
    expect(keys(memberEditFormFor(withManager, false))).toContain("manager_id");
    expect(keys(memberEditFormFor(withManager, true))).not.toContain("manager_id");
  });

  test("everyone else keeps the form unchanged, same object", () => {
    expect(memberEditFormFor(FORM_MEMBERS_EDIT, false)).toBe(FORM_MEMBERS_EDIT);
  });

  test("the shared form itself is not mutated", () => {
    memberEditFormFor(FORM_MEMBERS_EDIT, true);
    expect(keys(FORM_MEMBERS_EDIT)).toContain("role_id");
  });
});

/* The list is only right while it matches the server, so derive the server's
   answer from the handler: every `body.<field>` PATCH /:id reads, minus every
   `delete body.<field>` inside its scoped Sales Director branch. */
describe("the editable list is what PATCH /api/users/:id applies for a scoped Sales Director", () => {
  const route = readFileSync(resolve(HERE, "../../../backend/src/routes/users.ts"), "utf8");
  const REGISTRATION = 'app.patch("/:id"';

  function patchHandler(): string {
    const start = route.indexOf(REGISTRATION);
    expect(start, `${REGISTRATION} not found in routes/users.ts`).toBeGreaterThan(-1);
    const rest = route.slice(start + REGISTRATION.length);
    const next = rest.search(/\napp\.(post|get|patch|put|delete)\(/);
    return stripComments(next === -1 ? rest : rest.slice(0, next));
  }

  function scopedBranch(handler: string): string {
    const m = /if\s*\(\s*dirScope\.scoped\s*\)/.exec(handler);
    expect(m, "the scoped Sales Director branch was not found in PATCH /:id").not.toBeNull();
    const from = handler.indexOf("{", m!.index);
    let depth = 0;
    for (let i = from; i < handler.length; i++) {
      if (handler[i] === "{") depth++;
      else if (handler[i] === "}" && --depth === 0) return handler.slice(from, i + 1);
    }
    throw new Error("unbalanced scoped branch in PATCH /:id");
  }

  const fieldsIn = (src: string, pattern: RegExp) => new Set([...src.matchAll(pattern)].map((m) => m[1]));

  test("the handler and its scoped branch were really read (guards an empty scan)", () => {
    const handler = patchHandler();
    const stripped = fieldsIn(scopedBranch(handler), /delete\s+body\.(\w+)\s*;/g);
    expect(stripped).toContain("role_id");
    expect(fieldsIn(handler, /\bbody\.(\w+)/g).size).toBeGreaterThan(stripped.size);
  });

  test("the list equals the fields read minus the fields stripped", () => {
    const handler = patchHandler();
    const stripped = fieldsIn(scopedBranch(handler), /delete\s+body\.(\w+)\s*;/g);
    const applied = [...fieldsIn(handler, /\bbody\.(\w+)/g)].filter((k) => !stripped.has(k));
    expect([...SCOPED_DIRECTOR_EDITABLE_MEMBER_FIELDS].sort()).toEqual(applied.sort());
  });
});

describe("MobileApp routes both members forms through the helpers", () => {
  const app = stripComments(readFileSync(resolve(HERE, "MobileApp.tsx"), "utf8"));

  test("one scoped-director answer: the Sales Director position without users.manage", () => {
    expect(app).toMatch(
      /const scopedSalesDirector\s*=\s*isSalesDirectorUser\(user\)\s*&&\s*!can\("users\.manage"\)\s*;/,
    );
  });

  test("the create branch calls memberInviteFormFor with it", () => {
    expect(app).toMatch(/memberInviteFormFor\(\s*baseForm\s*,\s*scopedSalesDirector\s*\)/);
  });

  test("the edit branch calls memberEditFormFor with it", () => {
    expect(app).toMatch(/memberEditFormFor\(\s*FORM_MEMBERS_EDIT\s*,\s*scopedSalesDirector\s*\)/);
  });

  test("FORM_MEMBERS_EDIT never reaches the form unfiltered", () => {
    const code = app.replace(/^import[\s\S]*?;$/gm, "");
    const uses = code.match(/\bFORM_MEMBERS_EDIT\b/g) ?? [];
    const filtered = code.match(/memberEditFormFor\(\s*FORM_MEMBERS_EDIT\b/g) ?? [];
    expect(uses.length).toBeGreaterThan(0);
    expect(filtered.length).toBe(uses.length);
  });
});

/* Desktop and phone must agree on WHO is scoped: the desktop Team page derives
   salesDirScoped from the same two facts and hands the member profile
   canManage && !salesDirScoped, which locks every assignment field. */
describe("the desktop Team page decides scoped from the same two facts", () => {
  const team = stripComments(readFileSync(resolve(HERE, "../pages/Team.tsx"), "utf8"));
  const directory = stripComments(readFileSync(resolve(HERE, "../pages/team/TeamDirectory.tsx"), "utf8"));

  test("salesDirScoped is the Sales Director position without users.manage", () => {
    expect(team).toMatch(/const canManageUsers\s*=\s*can\("users\.manage"\)\s*;/);
    expect(team).toMatch(/const isSalesDir\s*=\s*isSalesDirectorUser\(user\)\s*;/);
    expect(team).toMatch(/const salesDirScoped\s*=\s*isSalesDir\s*&&\s*!canManageUsers\s*;/);
  });

  test("the desktop member profile gets no manage rights for that caller", () => {
    expect(directory).toMatch(/canManage=\{\s*canManage\s*&&\s*!salesDirScoped\s*\}/);
  });
});
