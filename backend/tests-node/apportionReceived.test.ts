import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';

// @ts-expect-error — plain .mjs helper shared with the cutover scripts.
import { apportionReceived } from '../scripts/lib/apportion-received.mjs';

/* THE REGRESSION THIS PINS DOWN.
 *
 * import-ac-so-linked-pos.mjs used to read AutoCount's GrQty as a per-line
 * receipt (`const recv = Math.round(Number(l.GrQty ?? 0))`). GrQty is really a
 * per-(DocNo, ItemCode) received ROLLUP stamped identically onto every detail
 * line of the group, so every line of a repeated item claimed the WHOLE
 * group's receipt. That produced 65 production PO lines with received_qty >
 * qty and 73 excess units.
 *
 * Each test below computes the OLD rule and the NEW rule over the SAME
 * committed snapshot and asserts both numbers, so the file fails loudly if the
 * apportionment is ever reverted or "simplified" back into a clamp. */

type AcLine = { DocNo: string; DtlKey: number; ItemCode: string; Qty: number; GrQty: number };

/* Read the snapshot through the URL itself, never through a converted string.
   This file is collected by BOTH suites: vitest.pg.config.ts runs tests-node/**
   on real node, and the default vitest.config.mts runs everything in the
   Cloudflare Workers pool. On Windows the workerd shim's fileURLToPath yields
   "/C:/Users/..." (unopenable), and its readFileSync rejects the de-slashed
   "C:/Users/..." with "File path must be a file: URL". Both runtimes accept a
   file: URL object, so that is the one form that works everywhere. */
const snapshot = new URL('../scripts/data/ac-so-linked-pos.json.gz', import.meta.url);
const rows: AcLine[] = JSON.parse(gunzipSync(readFileSync(snapshot)).toString());

/** The snapshot grouped the way the importer processes it: one AutoCount PO at a time. */
function byDoc(): Map<string, AcLine[]> {
  const m = new Map<string, AcLine[]>();
  for (const r of rows) {
    if (!m.has(r.DocNo)) m.set(r.DocNo, []);
    m.get(r.DocNo)!.push(r);
  }
  return m;
}

/** AutoCount's own truth for a (DocNo, ItemCode) group: the rollup, capped by what was ordered. */
function groupTruth(grp: AcLine[]): number {
  const rollup = Math.max(...grp.map((l) => Math.round(Number(l.GrQty ?? 0))));
  const ordered = grp.reduce((s, l) => s + Math.round(Number(l.Qty ?? 0)), 0);
  return Math.min(rollup, ordered);
}

function groups(): AcLine[][] {
  const m = new Map<string, AcLine[]>();
  for (const r of rows) {
    const k = `${r.DocNo}|${String(r.ItemCode).trim().toUpperCase()}`;
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(r);
  }
  return [...m.values()];
}

describe('AutoCount GrQty apportionment', () => {
  test('the snapshot really is a rollup — identical GrQty across every multi-line group', () => {
    const multi = groups().filter((g) => g.length > 1);
    expect(multi.length).toBeGreaterThan(0);
    const identical = multi.filter(
      (g) => new Set(g.map((l) => Math.round(Number(l.GrQty ?? 0)))).size === 1,
    );
    // 38 of 38 — the premise the whole fix rests on.
    expect(identical.length).toBe(multi.length);
  });

  test('OLD rule (raw GrQty per line) over-receives; NEW rule never does', () => {
    let oldOver = 0;
    let oldExcess = 0;
    for (const r of rows) {
      const q = Math.round(Number(r.Qty ?? 0));
      const recv = Math.round(Number(r.GrQty ?? 0));
      if (recv > q) {
        oldOver += 1;
        oldExcess += recv - q;
      }
    }
    // Both numbers, quoted: this is the defect, measured on the source.
    expect(oldOver).toBe(59);
    expect(oldExcess).toBe(67);

    let newOver = 0;
    let newExcess = 0;
    for (const [, lines] of byDoc()) {
      const recvByDtl = apportionReceived(lines);
      for (const l of lines) {
        const q = Math.round(Number(l.Qty ?? 0));
        const recv = recvByDtl.get(String(l.DtlKey)) ?? 0;
        if (recv > q) {
          newOver += 1;
          newExcess += recv - q;
        }
      }
    }
    expect(newOver).toBe(0);
    expect(newExcess).toBe(0);
  });

  test('apportionment preserves each group total exactly — no unit invented, none lost', () => {
    const recvByDtl = new Map<string, number>();
    for (const [, lines] of byDoc()) {
      for (const [k, v] of apportionReceived(lines)) recvByDtl.set(k, v);
    }
    let drift = 0;
    for (const g of groups()) {
      const got = g.reduce((s, l) => s + (recvByDtl.get(String(l.DtlKey)) ?? 0), 0);
      drift += got - groupTruth(g);
    }
    expect(drift).toBe(0);
  });

  test('a blanket min(GrQty, qty) clamp would INVENT a unit — which is why it was rejected', () => {
    /* The clamp holds the ceiling but breaks the total. Keeping this as an
       executable assertion stops a future "simplification" back to the clamp,
       which would silently mark a partially-received PO as fully received. */
    let clampDrift = 0;
    const offenders: string[] = [];
    for (const g of groups()) {
      const truth = groupTruth(g);
      const clamped = g.reduce(
        (s, l) => s + Math.min(Math.round(Number(l.GrQty ?? 0)), Math.round(Number(l.Qty ?? 0))),
        0,
      );
      if (clamped !== truth) {
        clampDrift += clamped - truth;
        offenders.push(`${g[0]!.DocNo}|${g[0]!.ItemCode}`);
      }
    }
    expect(clampDrift).toBe(1);
    expect(offenders).toEqual(['PO-009620|HOK-1052 (Q)']);
  });

  test('PO-009018 — the four-line production shape — resolves to one each', () => {
    const lines = byDoc().get('PO-009018')!;
    expect(lines).toHaveLength(2);
    // Ordered 2 in total, received 2 in total, but each line carries GrQty 2.
    expect(lines.map((l) => Math.round(Number(l.GrQty)))).toEqual([2, 2]);
    const recvByDtl = apportionReceived(lines);
    expect([...recvByDtl.values()]).toEqual([1, 1]);
  });
});
