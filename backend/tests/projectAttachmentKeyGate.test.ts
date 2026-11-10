// GET /api/projects/attachments/:key streamed ANY object in the shared
// POD_BUCKET to any signed-in user: an outbound email's PDF at
// mail-outbox/<outboxId>/1, an HR punch selfie, a service-case photo the
// service-case route itself refuses out of scope. The gate in
// routes/lib/project-company-gate.ts refuses other modules' keys and other
// companies' project files. Sister finding: Conts #166.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";
import {
  FOREIGN_ATTACHMENT_PREFIXES,
  classifyAttachmentKey,
  refuseForeignAttachmentKey,
} from "../src/routes/lib/project-company-gate";

const SRC = join(__dirname, "..", "src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.ts$/.test(n) && !/\.test\.ts$/.test(n) ? [p] : [];
  });
}

/* Files that BUILD a POD_BUCKET key for a writer elsewhere. A writer that calls
   one of these has no template literal of its own to scan. */
const KEY_HELPER_FILES = ["services/assr.ts", "scm/lib/fleet-coerce.ts"];
const PROJECT_MODULE = "routes/projects.ts";
const MIME_PREFIX = /^(image|video|audio|application|text)$/;

function keyPrefixes(file: string): string[] {
  const src = readFileSync(join(SRC, file), "utf8");
  const out = new Set<string>();
  for (const m of src.matchAll(/`([a-z][a-z-]*)\/\$\{/g)) if (!MIME_PREFIX.test(m[1]!)) out.add(`${m[1]}/`);
  return [...out];
}

describe("classifyAttachmentKey", () => {
  test("an outbound email attachment is another module's object", () => {
    expect(classifyAttachmentKey("mail-outbox/123/1")).toEqual({ kind: "foreign" });
  });

  test.each(FOREIGN_ATTACHMENT_PREFIXES.map((p) => [p]))("%s is foreign", (p) => {
    expect(classifyAttachmentKey(`${p}9/x.jpg`)).toEqual({ kind: "foreign" });
  });

  test("a project key names its project, a task attachment its checklist item", () => {
    expect(classifyAttachmentKey("projects/42/ledger-1.pdf")).toEqual({ kind: "project", projectId: 42 });
    expect(classifyAttachmentKey("project-phase-photos/7/setup/1-a.jpg")).toEqual({ kind: "project", projectId: 7 });
    expect(classifyAttachmentKey("projects/42/defect-1.jpg.thumb")).toEqual({ kind: "project", projectId: 42 });
    expect(classifyAttachmentKey("task-attach/9/1-x.pdf")).toEqual({ kind: "checklist", itemId: 9 });
  });

  test("a path climbing out of its folder is refused", () => {
    expect(classifyAttachmentKey("projects/1/../../mail-outbox/3/1")).toEqual({ kind: "foreign" });
  });

  test("a layout this file does not know is served as before", () => {
    expect(classifyAttachmentKey("brands/logo-3-1.png")).toEqual({ kind: "other" });
  });
});

describe("every other POD_BUCKET writer's key prefix is refused", () => {
  const writers = walk(SRC)
    .map((p) => relative(SRC, p).split("\\").join("/"))
    .filter((f) => f !== PROJECT_MODULE && /POD_BUCKET\.put\(/.test(readFileSync(join(SRC, f), "utf8")));

  test("the scan found the writers", () => {
    expect(writers.length).toBeGreaterThanOrEqual(10);
    expect(writers).toContain("services/email.ts");
  });

  test.each([...writers, ...KEY_HELPER_FILES].map((f) => [f]))("%s", (file) => {
    for (const prefix of keyPrefixes(file)) {
      expect(FOREIGN_ATTACHMENT_PREFIXES, `${file} writes ${prefix}... into POD_BUCKET; add it to FOREIGN_ATTACHMENT_PREFIXES`).toContain(prefix);
    }
  });
});

type Bound = { sql: string; binds: unknown[] };

function fakeCtx(companyId: number | undefined, rowExists: boolean) {
  const seen: Bound[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          return { first: async () => { seen.push({ sql, binds }); return rowExists ? { ok: 1 } : null; } };
        },
      };
    },
  };
  const c = {
    env: { DB: db } as never,
    get: (k: string) => (k === "companyId" ? companyId : undefined),
    json: (body: unknown, status?: number) => new Response(JSON.stringify(body), { status: status ?? 200 }),
  };
  return { c: c as never, seen };
}

describe("refuseForeignAttachmentKey", () => {
  test("another module's key is 404 without a database read", async () => {
    const { c, seen } = fakeCtx(1, true);
    const res = await refuseForeignAttachmentKey(c, "mail-outbox/55/1");
    expect(res?.status).toBe(404);
    expect(seen).toHaveLength(0);
  });

  test("another company's project file is 404", async () => {
    const { c, seen } = fakeCtx(2, false);
    const res = await refuseForeignAttachmentKey(c, "projects/42/payment-1.pdf");
    expect(res?.status).toBe(404);
    expect(seen[0]!.binds).toEqual([42]);
    expect(seen[0]!.sql).toContain("company_id = 2");
  });

  test("the caller's own project file is served", async () => {
    const { c } = fakeCtx(1, true);
    expect(await refuseForeignAttachmentKey(c, "project-phase-photos/42/setup/1-a.jpg")).toBeNull();
  });

  test("a task attachment is checked against its checklist item", async () => {
    const { c, seen } = fakeCtx(1, false);
    const res = await refuseForeignAttachmentKey(c, "task-attach/9/1-x.pdf");
    expect(res?.status).toBe(404);
    expect(seen[0]!.sql).toContain("FROM project_checklist WHERE id = ?");
    expect(seen[0]!.binds).toEqual([9]);
  });
});

describe("the route runs the gate before it reads the bucket", () => {
  test("GET /attachments/:key calls refuseForeignAttachmentKey first", () => {
    const src = readFileSync(join(SRC, PROJECT_MODULE), "utf8");
    const start = src.indexOf('app.get("/attachments/:key{.+}"');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("POD_BUCKET.get(", start));
    expect(body).toContain("refuseForeignAttachmentKey(c, key)");
  });
});
