import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { FORM_MEMBERS } from "./MobileModuleList";
import { memberInviteFormFor } from "./member-invite-form";
import { stripComments } from "../auth/sourceScan.testutil";

const HERE = dirname(fileURLToPath(import.meta.url));

/* docs/bugs/0887 — the phone's Member invite offered a Sales Director a Role
   picker listing every role, and the server stored whatever came back. The
   server now forces the baseline role for that caller; this pins the phone
   half, so the form stops offering a choice the save ignores. */
describe("memberInviteFormFor", () => {
  const keys = (f: { fields: { key: string }[] }) => f.fields.map((x) => x.key);

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

describe("MobileApp routes the members create form through the helper", () => {
  const app = stripComments(readFileSync(resolve(HERE, "MobileApp.tsx"), "utf8"));

  test("the module-form branch calls memberInviteFormFor with the scoped-director answer", () => {
    expect(app).toMatch(
      /memberInviteFormFor\(\s*baseForm\s*,\s*isSalesDirectorUser\(user\)\s*&&\s*!can\("users\.manage"\)\s*\)/,
    );
  });
});
