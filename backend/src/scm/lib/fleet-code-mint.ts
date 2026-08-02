// ---------------------------------------------------------------------------
// fleet-code-mint.ts — allocate the next DRV- / HLP- / 3PL- code.
//
// WHY. Owner, 2026-08-02: "driver code、lorry code、3PL 的 code 应该全部都是自动
// 的。Code 的话，应该是我 add 了之后自动出来的，不是吗?"
//
// It was not. `DRV-xx` was a PLACEHOLDER on a free-text input and the server
// stored whatever came in. Production shows exactly what that costs: DRV-001
// through DRV-007 sitting beside DRV-05, DRV-06, DRV-07 AND DRV-050 — two
// numbering schemes at once — with the same person (same name, same phone)
// entered three times under three different codes.
//
// THE PARSER IS THE WHOLE JOB. A minter that only understands the format it
// writes is worse than none: it would look at DRV-050 and see nothing, mint
// DRV-001, and collide with a row that has existed for months. So nextCode
// reads EVERY `PREFIX-<digits>` form, whatever the padding, and takes the
// highest number it can see. DRV-05 is 5 and DRV-050 is 50; the next code is
// 51, which collides with neither.
//
// PURE. The DB read lives in the caller so this can be unit-tested, and so the
// scope of that read (global for the unified driver roster, per-company for the
// 3PL master) stays the caller's decision — the two are genuinely different and
// hiding that here would make one of them wrong silently.
// ---------------------------------------------------------------------------

/** How wide the numeric part is padded by default. Three matches the widest
 *  form already in production (DRV-050); a number past 999 simply gets longer
 *  rather than wrapping or truncating. */
const PAD = 3;

/** Per-prefix width where it differs from PAD. Breakdown cases and work orders
 *  (mig 0248) are four wide: a fleet accumulates work orders for a decade, and
 *  the migration's backfill LPADs to four — the two MUST agree or the minter
 *  would produce WO-051 beside a backfilled WO-0051 and the "highest existing"
 *  read would still be right while the register looked like two schemes. */
const PAD_BY_PREFIX: Record<string, number> = { BD: 4, WO: 4 };

/**
 * PURE. The next code for a prefix, given every code already in use.
 *
 * Reads any `PREFIX-<digits>` shape case-insensitively and ignores everything
 * else — a hand-typed "DRV-TEMP" or a blank must not stop the sequence, and it
 * must not be counted as zero either.
 */
export function nextCode(prefix: string, existing: readonly (string | null | undefined)[]): string {
  const re = new RegExp(`^${prefix}-(\\d+)$`, 'i');
  let highest = 0;
  for (const raw of existing) {
    const m = re.exec(String(raw ?? '').trim());
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isSafeInteger(n) && n > highest) highest = n;
  }
  return `${prefix}-${String(highest + 1).padStart(PAD_BY_PREFIX[prefix.toUpperCase()] ?? PAD, '0')}`;
}

/**
 * Is this a code we minted, or something a human typed?
 *
 * Used to decide whether an incoming code is worth keeping. An import that
 * carries real codes should keep them; a UI that has no code field should not
 * be sending one at all.
 */
export function isMintedShape(prefix: string, code: string | null | undefined): boolean {
  return new RegExp(`^${prefix}-\\d+$`, 'i').test(String(code ?? '').trim());
}

export const CODE_PREFIX = {
  DRIVER: 'DRV',
  HELPER: 'HLP',
  THREEPL: '3PL',
  WORKSHOP: 'WS',
  /* mig 0248. Four digits, unlike the three above: a lorry breaks down a few
     times a year but a fleet accumulates work orders for a decade, and the
     parser reads any padding so widening later would be safe anyway. */
  BREAKDOWN: 'BD',
  WORK_ORDER: 'WO',
} as const;
