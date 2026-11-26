import { Hono } from "hono";
import type { Env, Variables } from "../env";
import { getSupabaseService } from "../../db/supabase";
import {
  BYPASS_PERMS,
  callerBypasses,
  freezeMessage,
  readFreezeUncached,
} from "../lib/write-freeze";
import {
  SCM_AREAS,
  SCM_UNGUARDED_PREFIXES,
  areaLabel,
  prefixesForArea,
} from "../lib/scm-areas";

export const writeFreezeStatus = new Hono<{ Bindings: Env; Variables: Variables }>();

const FREEZE_TTL_MS = 30_000;

function summarise(
  scope: "off" | "all" | number[],
  open: readonly string[],
  malformed: boolean,
): string {
  if (scope === "off") return "OPEN. Every company can save.";
  const who = scope === "all" ? "EVERY company" : `company ${(scope as number[]).join(", ")}`;
  const except = open.length
    ? ` EXCEPT ${open.map(areaLabel).join(", ")}, which can save.`
    : " Every area is frozen.";
  const bad = malformed
    ? " WARNING: the stored value could not be read, so it was treated as a freeze of every company. Fix the row."
    : "";
  return `FROZEN for ${who}.${except}${bad}`;
}

writeFreezeStatus.get("/", async (c) => {
  if (!callerBypasses(c)) {
    return c.json(
      { error: `Forbidden: needs one of ${BYPASS_PERMS.join(" / ")} to read the write-freeze state` },
      403,
    );
  }

  let row: Awaited<ReturnType<typeof readFreezeUncached>>;
  try {
    row = await readFreezeUncached(getSupabaseService(c.env));
  } catch {
    return c.json(
      {
        key: "scm.write_freeze",
        readable: false,
        summary:
          "COULD NOT READ app_config. While it stays unreadable the middleware fails OPEN, so writes are NOT being refused.",
      },
      200,
    );
  }

  const { value, message } = row;
  const staged = value.open.length > 0;

  return c.json({
    key: "scm.write_freeze",
    readable: true,
    summary: summarise(value.scope, value.open, value.malformed),
    frozen: {
      mode: value.scope === "off" ? "off" : value.scope === "all" ? "all" : "companies",
      companies: Array.isArray(value.scope) ? value.scope : null,
    },
    openAreas: value.open.map((a) => ({ area: a, label: areaLabel(a), opens: prefixesForArea(a) })),
    unresolvedTokens: value.unknown,
    malformed: value.malformed,
    staffMessage: freezeMessage(message, null, false),
    operatorMessageRow: message,
    bypass: { perms: [...BYPASS_PERMS], youBypass: true },
    liftable: [...SCM_AREAS].sort().map((a) => ({
      area: a,
      label: areaLabel(a),
      opens: prefixesForArea(a),
    })),
    neverLiftable: [...SCM_UNGUARDED_PREFIXES],
    staged,
    cacheTtlMs: FREEZE_TTL_MS,
    note: `Read direct from the row. Enforcement can trail an UPDATE by up to ${FREEZE_TTL_MS}ms per isolate.`,
  });
});
