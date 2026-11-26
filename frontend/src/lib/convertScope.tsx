
export const CONVERT_LINKS = {
  poToGrn:  { path: '/scm/grns/from-po',               param: 'poId'    },
  grnToPi:  { path: '/scm/purchase-invoices/from-grn', param: 'grnId'   },
  grnToPr:  { path: '/scm/purchase-returns/new',       param: 'grnId'   },
  poToPr:   { path: '/scm/purchase-returns/new',       param: 'poId'    },
  piToPr:   { path: '/scm/purchase-returns/new',       param: 'piId'    },
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
  { from: 'pi',  to: 'pr'  },
  { from: 'co',  to: 'cn'  },
  { from: 'cn',  to: 'cr'  },
  { from: 'pco', to: 'pcr' },
] as const;

export function convertToLink(pair: ConvertPair, keys: string | readonly string[]): string {
  const { path, param } = CONVERT_LINKS[pair];
  const list = (typeof keys === 'string' ? [keys] : keys)
    .map((k) => String(k).trim())
    .filter(Boolean);
  if (list.length === 0) return path;
  return `${path}?${param}=${encodeURIComponent(list.join(','))}`;
}

export type ConvertScope = {
  keys: Set<string>;
  unknown: string[];
};

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
