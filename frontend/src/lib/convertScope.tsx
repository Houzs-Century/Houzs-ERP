// ---------------------------------------------------------------------------
// convertScope — the ONE place a transfer link's scope parameter is named, and
// the ONE place its LABEL is generated.
//
// Every conversion in this ERP is a picker page owned by the DESTINATION
// document (`/scm/grns/from-po`, `/scm/sales-invoices/from-do`, …). A
// source-side "Transfer to X" button navigates to that picker and has to say
// WHICH source document the operator came from, or they land on a global list
// of everything and hunt for the document they were just looking at.
//
// Two ways that failed, both found on 2026-08-16:
//   1. The caller appended a scope parameter and the picker never read it —
//      `?do=`, `?grn=`, `?so=` were constructed, navigated with, and discarded.
//   2. The caller and the destination spelled it differently — the GRN screens
//      sent `?fromGrn=` while PurchaseReturnNew read `grnId`, so "Transfer to
//      Purchase Return" always opened blank.
//
// Both are invisible at compile time when each site invents its own string. So
// the name is written ONCE, here, keyed by the conversion PAIR, and both sides
// import it: the caller builds with `convertToLink()`, the destination reads
// with `readConvertScope()`. A misspelt pair is a type error.
//
// And an unrecognised parameter is REPORTED, never dropped: `readConvertScope`
// returns the parameters the screen does not understand and
// `<UnrecognisedScopeNotice>` puts them on the operator's screen. A silently
// ignored parameter is precisely how (2) survived — the screen looked like a
// normal blank form.
// ---------------------------------------------------------------------------

/* Every source→destination convert that carries a SCOPE (which source document
   am I converting?). Keyed by pair, not by route, because one destination can
   legitimately be scoped by more than one kind of source: a Purchase Return is
   raised either from a GRN or straight from a PO, and those are two parameters
   on one route.

   NOT in this table, deliberately: `appendTo…`-style parameters
   (`/scm/grns/from-po?appendToGrn=`, `/scm/purchase-orders/from-so?poId=`).
   Those name an existing DESTINATION document to append the picked lines into
   — the opposite direction — and mixing the two concepts in one table is how
   the next reader gets it backwards.

   `key` is the value the picker matches its rows on, and it is NOT always a
   UUID: the SO→DO picker's rows are keyed on the SO document number, because
   `deliverable-so-lines` returns `docNo` and no order id. The parameter is
   named for what it actually carries. */
export const CONVERT_LINKS = {
  poToGrn:  { path: '/scm/grns/from-po',               param: 'poId'    },
  grnToPi:  { path: '/scm/purchase-invoices/from-grn', param: 'grnId'   },
  grnToPr:  { path: '/scm/purchase-returns/new',       param: 'grnId'   },
  poToPr:   { path: '/scm/purchase-returns/new',       param: 'poId'    },
  doToSi:   { path: '/scm/sales-invoices/from-do',     param: 'doId'    },
  doToDr:   { path: '/scm/delivery-returns/from-do',   param: 'doId'    },
  soToDo:   { path: '/scm/delivery-orders/from-so',    param: 'soDocNo' },
} as const;

export type ConvertPair = keyof typeof CONVERT_LINKS;

/* ── The LABEL rule (owner-approved 2026-08-17) ────────────────────────────
   The rule and its words MOVED on 2026-08-18 to
   `frontend/src/vendor/shared/transfer-vocabulary.ts` — the mirrored tree, whose
   backend twin is `backend/src/scm/shared/transfer-vocabulary.ts`. Read that
   file for the rule itself; it is unchanged, and this is not a second home.

   WHY IT MOVED. The rule lived here, in a frontend .tsx, so it could only ever
   reach BUTTONS. Two surfaces speak the same vocabulary and could not call it:

     · the PROVENANCE NOTE the backend stamps into `purchase_orders.notes` when
       MRP raises a PO — backend code, cannot import a frontend .tsx;
     · the ~15 lineage COLUMN HEADERS, which are 110-160px wide and needed a
       SHORT form the rule did not have.

   Both were therefore hand-written, and both drifted — which is the exact
   defect #2370 was raised to end. The rule now covers all three surfaces, and
   the words are one object, not three tables that agree today.

   Re-exported here so every existing `from '../../lib/convertScope'` import
   keeps working: this module remains the door, it just no longer owns the room.
   `transfer-vocabulary.canonical.test.ts` fails if this becomes a copy. */
export {
  TRANSFER_DOC,
  transferToLabel,
  transferFromLabel,
  TRANSFER_DOC_SHORT,
  transferToColumnLabel,
  transferFromColumnLabel,
  type TransferDoc,
} from '../vendor/shared/transfer-vocabulary';

import type { TransferDoc } from '../vendor/shared/transfer-vocabulary';

/* Every transfer flow this ERP recognises, as source → destination. This is the
   VOCABULARY table, not a capability table: a row here says what the pair is
   CALLED, not that both buttons exist. `docs/modules/document-conversion.md` §2
   is the capability grid, and §9 records which of these have no button yet. */
export const TRANSFER_FLOWS: readonly { from: TransferDoc; to: TransferDoc }[] = [
  { from: 'so',  to: 'do'  },
  { from: 'so',  to: 'po'  },
  { from: 'do',  to: 'si'  },
  { from: 'do',  to: 'dr'  },
  { from: 'po',  to: 'grn' },
  { from: 'po',  to: 'pr'  },
  { from: 'grn', to: 'pi'  },
  { from: 'grn', to: 'pr'  },
  { from: 'co',  to: 'cn'  },
  { from: 'cn',  to: 'cr'  },
  { from: 'pco', to: 'pcr' },
] as const;

/* Build the transfer URL. `keys` may be one source key or many — the
   multi-source form is what the PO list's bulk "Transfer to Goods Received" bar
   sends, and every picker below understands it. */
export function convertToLink(pair: ConvertPair, keys: string | readonly string[]): string {
  const { path, param } = CONVERT_LINKS[pair];
  const list = (typeof keys === 'string' ? [keys] : keys)
    .map((k) => String(k).trim())
    .filter(Boolean);
  if (list.length === 0) return path;
  return `${path}?${param}=${encodeURIComponent(list.join(','))}`;
}

export type ConvertScope = {
  /* The source keys this screen was scoped to. EMPTY means "no scope was
     asked for" — the full, global picker, which is a legitimate entry point
     (the list toolbar's unscoped "Transfer from Purchase Order" button). */
  keys: Set<string>;
  /* Parameters in the URL that this screen does not understand. Non-empty
     means a caller is talking to this screen in a language it does not speak,
     and the operator is about to be handed the wrong thing quietly. */
  unknown: string[];
};

/* Read the scope a transfer link carried.
 *
 * `alsoKnown` is REQUIRED, not optional, and that is the repo rule about a
 * parameter that DECIDES something: it decides whether a parameter counts as
 * unrecognised. An optional list would default to "" at every call site that
 * forgot it, and every one of those screens would then shout about its own
 * legitimate parameters — so the guard would be turned off again, by hand, one
 * screen at a time. Pass `[]` when the screen takes nothing else; that reads as
 * a decision.
 */
export function readConvertScope(
  pair: ConvertPair,
  search: URLSearchParams,
  alsoKnown: readonly string[],
): ConvertScope {
  const { param } = CONVERT_LINKS[pair];
  const raw = search.get(param);
  const keys = new Set(
    (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  );
  const known = new Set<string>([param, ...alsoKnown]);
  const unknown: string[] = [];
  for (const name of search.keys()) {
    if (known.has(name) || unknown.includes(name)) continue;
    unknown.push(name);
  }
  return { keys, unknown };
}

/* The loud half. A parameter this screen cannot act on is shown to the operator
   rather than dropped, because the failure it hides looks exactly like normal
   use: a blank form, or a picker listing everything. */
export const UnrecognisedScopeNotice = ({ unknown }: { unknown: string[] }) => {
  if (unknown.length === 0) return null;
  return (
    <p
      role="alert"
      style={{
        margin: '0 0 var(--space-2)',
        padding: 'var(--space-2) var(--space-3)',
        border: '1px solid var(--c-burnt)',
        borderRadius: 'var(--radius-sm)',
        fontSize: 'var(--fs-12)',
        color: 'var(--c-burnt)',
      }}
    >
      This link carried {unknown.map((u) => `"${u}"`).join(', ')}, which this
      screen does not understand — it has NOT been applied, so nothing below is
      narrowed by it. The button that sent you here is out of date; please
      report it.
    </p>
  );
};
