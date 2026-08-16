/**
 * SO pricing envelope — the hinge is the PERSON, not the door.
 *
 * Owner ruling 2026-08-16, stated three times:
 * 「为什么我们要跟着 POS 的规矩?进了这个 ERP 就跟这个 ERP 的规矩。」
 *
 * Before this, all three answers came from `sessionOrigin === 'pos'`, so the
 * SAME PERSON was allowed to reduce a bill in the ERP and refused on the
 * tablet. These tests pin the property that makes the ruling true rather than
 * incidentally true: for the two AUTHORITY questions the origin is not read at
 * all, so every assertion below is made TWICE — once from a POS-origin session
 * and once from an origin-less ERP session — and both must agree.
 *
 * The third question (`pricing_drift`) is deliberately still origin-shaped: it
 * asks whether the CLIENT's submitted price came from a stale catalog cache,
 * which is a fact about the POS cart app and not about the person. It is pinned
 * here too, in the opposite direction — permissions must NOT move it — because
 * a later sweep "finishing the job" would break it in both directions at once.
 */
import { describe, expect, test } from 'vitest';
import { maySetSellingPrice, mayReduceSoTotal } from '../src/scm/lib/houzs-perms';
import { isPosAppClient } from '../src/scm/routes/mfg-sales-orders';
import { isValidPermission } from '../src/services/permissions';

const POS = 'pos';
const ERP = undefined;

/** A caller source carrying BOTH facts the envelope can consult — the granted
 *  permission keys and the door the session was minted at. Shaped to satisfy
 *  houzs-perms' HouzsUserSource and mfg-sales-orders' PosCallerSource at once,
 *  which is the whole point: a single object that both questions can be asked
 *  of, so a test can vary one fact while holding the other still. */
function caller(perms: string[], sessionOrigin: string | undefined) {
  return {
    get(key: 'houzsUser' | 'sessionOrigin') {
      if (key === 'sessionOrigin') return sessionOrigin;
      return { id: 1, permissions: perms };
    },
  } as unknown as Parameters<typeof maySetSellingPrice>[0] & Parameters<typeof isPosAppClient>[0];
}

/** Every door a session can be minted at, paired with the label the failure
 *  message should read. `pos` is /api/pos/pin-login; undefined is every other
 *  session (desktop ERP, mobile, invite, TOTP, exchanged web session). */
const DOORS: Array<[string, string | undefined]> = [
  ['a POS-origin session (PIN door)', POS],
  ['an ERP session (no origin)', ERP],
];

describe('scm.so.price_authority is declared and grantable', () => {
  test('the key exists in the catalogue, so Team > Positions can offer it', () => {
    // A gate on an UNDECLARED key is silently Owner/IT-only forever and no
    // amount of clicking in the matrix can change it — the exact trap
    // service_cases.approve sat in until 2026-08-13.
    expect(isValidPermission('scm.so.price_authority')).toBe(true);
  });
});

describe('question 2 — may this person reduce a customer\'s bill (so_total_below_original)', () => {
  for (const [label, origin] of DOORS) {
    test(`a holder of scm.so.price_authority MAY reduce, from ${label}`, () => {
      expect(mayReduceSoTotal(caller(['scm.access', 'scm.so.price_authority'], origin))).toBe(true);
    });

    test(`a non-holder may NOT reduce, from ${label}`, () => {
      expect(mayReduceSoTotal(caller(['scm.access'], origin))).toBe(false);
    });
  }

  test('the answer does not depend on the door — that IS the ruling', () => {
    const holderOnPos = mayReduceSoTotal(caller(['scm.so.price_authority'], POS));
    const holderOnErp = mayReduceSoTotal(caller(['scm.so.price_authority'], ERP));
    const repOnPos = mayReduceSoTotal(caller(['scm.access'], POS));
    const repOnErp = mayReduceSoTotal(caller(['scm.access'], ERP));
    expect(holderOnPos).toBe(holderOnErp);
    expect(repOnPos).toBe(repOnErp);
    // ...and the two rows are genuinely different, so the assertion above is
    // not passing because everything returns the same constant.
    expect(holderOnErp).not.toBe(repOnErp);
  });
});

describe('question 1 — may this person author a selling price (trustOperatorSelling)', () => {
  for (const [label, origin] of DOORS) {
    test(`a holder MAY author a price, from ${label}`, () => {
      expect(maySetSellingPrice(caller(['scm.so.price_authority'], origin))).toBe(true);
    });

    test(`a non-holder may NOT author a price, from ${label}`, () => {
      expect(maySetSellingPrice(caller(['scm.access'], origin))).toBe(false);
    });
  }
});

describe('the day-one grant — nobody the owner already trusted loses pricing', () => {
  for (const [label, origin] of DOORS) {
    test(`the Owner / IT Admin '*' wildcard carries both authorities, from ${label}`, () => {
      expect(maySetSellingPrice(caller(['*'], origin))).toBe(true);
      expect(mayReduceSoTotal(caller(['*'], origin))).toBe(true);
    });

    test(`an existing scm.so.price_override holder carries both, from ${label}`, () => {
      // The OR that keeps this deploy from taking pricing away from a position
      // the owner had already trusted with the audited hand-override route.
      expect(maySetSellingPrice(caller(['scm.so.price_override'], origin))).toBe(true);
      expect(mayReduceSoTotal(caller(['scm.so.price_override'], origin))).toBe(true);
    });
  }

  test('fails CLOSED when no permissions were stashed at all', () => {
    const noStash = { get: () => undefined } as unknown as Parameters<typeof mayReduceSoTotal>[0];
    expect(maySetSellingPrice(noStash)).toBe(false);
    expect(mayReduceSoTotal(noStash)).toBe(false);
  });
});

describe('question 3 — pricing_drift stays CLIENT-shaped, not permission-shaped', () => {
  test('the POS cart client is identified by its door, whatever it may do', () => {
    expect(isPosAppClient(caller(['scm.access'], POS))).toBe(true);
    expect(isPosAppClient(caller(['scm.so.price_authority'], POS))).toBe(true);
    expect(isPosAppClient(caller(['*'], POS))).toBe(true);
  });

  test('no ERP session is ever drift-checked, whatever it may NOT do', () => {
    expect(isPosAppClient(caller([], ERP))).toBe(false);
    expect(isPosAppClient(caller(['scm.access'], ERP))).toBe(false);
  });

  test('granting price authority does not silence the stale-cache check', () => {
    // If a later sweep moved drift onto the permission too, an authorised
    // person's stale cart would save silently at the wrong price. This is the
    // assertion that would catch it.
    expect(isPosAppClient(caller(['scm.so.price_authority', '*'], POS))).toBe(true);
  });
});
