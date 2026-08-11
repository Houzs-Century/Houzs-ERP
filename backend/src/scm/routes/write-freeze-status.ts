// ----------------------------------------------------------------------------
// GET /api/scm/write-freeze — what the write freeze is doing, right now.
//
// WHY THIS EXISTS. The freeze is the single switch between "staff cannot save"
// and "staff can save", and until this endpoint the only way to read it was a
// SELECT against production — so the answer to "what is frozen?" cost either a
// database console or an agent. That is the wrong shape for a switch the owner
// flips during go-live: he is making live go/no-go calls on this value and must
// be able to see it himself. (Repo rule: build the check, never ask the owner to
// run a query. The workflow twin of this endpoint is
// .github/workflows/check-write-freeze.yml, for when he would rather click a
// button than hold a session.)
//
// READ-ONLY AND UNCACHED. One SELECT, no writes. It deliberately bypasses the
// middleware's 30s cache so the operator sees the ROW, not an isolate's stale
// copy — and reports cacheTtlMs so he knows enforcement can trail his UPDATE by
// that much. It is a GET, so the freeze itself never blocks it.
//
// GATED to the same cohort that can act on the answer (`*` / `scm.admin`) —
// the bypass holders. Everyone else gets 403: the refusal message already tells
// ordinary staff what they need, and the area inventory here is operational
// detail, not floor information.
// ----------------------------------------------------------------------------
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

/** One line an operator can read without decoding the JSON below it. */
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
    /* Mirrors the middleware's OUTAGE behaviour, and says so rather than
       reporting a state we did not read. The middleware fails OPEN here. */
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
    /* Surfaced, never silently dropped: an area token we could not resolve did
       NOT lift anything, and an operator who thinks he reopened sales orders
       needs to see his typo here rather than infer it from staff still being
       stuck. */
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
    /* Honest about the ceiling of a staged lift: these routers carry no L2 key,
       so no exception can name them and they stay frozen until the whole
       company is unfrozen. Several accept writes (hr, categories, localities,
       currencies, state-warehouse-mappings, staff, pos-cart,
       personal-quick-picks, sales-analysis). */
    neverLiftable: [...SCM_UNGUARDED_PREFIXES],
    staged,
    cacheTtlMs: FREEZE_TTL_MS,
    note: `Read direct from the row. Enforcement can trail an UPDATE by up to ${FREEZE_TTL_MS}ms per isolate.`,
  });
});
