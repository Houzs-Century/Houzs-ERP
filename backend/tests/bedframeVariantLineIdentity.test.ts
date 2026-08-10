import { describe, expect, test } from 'vitest';
// @ts-expect-error - plain .mjs, shared by both importers and both refresh scripts
import { parseBedframe } from '../scripts/lib/parse-bedframe.mjs';

/* The variant-refresh scripts looked their parsed Desc2 up by
   (AutoCount DocNo | ERP item code). That pair is NOT a line identity: one
   order routinely carries several rows of the same SKU in different colours or
   heights, so Map.set kept only the LAST of them and the write then stamped
   that single parse onto EVERY database line sharing the key. 14 bedframe SO
   lines reached production disagreeing with the PO built from them, on
   documents whose Desc2 was byte-identical on both sides. Across the export the
   collision hit 183 keys carrying a genuinely different Desc2, losing 298 lines.

   The three rows below are verbatim from ac-outstanding-so.json.gz - one real
   order, one SKU, three different beds. They are the whole defect in one
   document, and they pin the invariant that justifies keying on DtlKey. */

const SO_006572_NK1046Q = [
  { DtlKey: 450357, DocNo: 'SO-006572', ItemCode: 'NK-1046 (Q)', Desc2: 'mattress gap:10”/divan:8”+4”leg/color:PC151-01' },
  { DtlKey: 506702, DocNo: 'SO-006572', ItemCode: 'NK-1046 (Q)', Desc2: 'mattress gap:10”/divan:8”+4”leg/color:PC151-02' },
  { DtlKey: 506703, DocNo: 'SO-006572', ItemCode: 'NK-1046 (Q)', Desc2: 'mattress gap:12”/divan:8”+4”leg/color:PC151-14' },
];

const build = (d2: string) => {
  const bf = parseBedframe(d2);
  return `${bf.color}|gap${bf.gap}|divan${bf.divan}|leg${bf.leg}`;
};

describe('bedframe variant lookup must key on the LINE, not the document', () => {
  test('DtlKey is a line identity: three rows, three distinct builds', () => {
    const byLine = new Map(SO_006572_NK1046Q.map((r) => [r.DtlKey, build(r.Desc2)]));
    expect(byLine.size).toBe(3);
    expect([...byLine.values()]).toEqual([
      'PC151-01|gap10|divan8|leg4',
      'PC151-02|gap10|divan8|leg4',
      'PC151-14|gap12|divan8|leg4',
    ]);
  });

  test('(DocNo|ItemCode) is NOT a line identity: two builds are lost to the last', () => {
    const collapsed = new Map<string, string>();
    for (const r of SO_006572_NK1046Q) {
      collapsed.set(`${r.DocNo}|${r.ItemCode.toUpperCase()}`, build(r.Desc2));
    }
    expect(collapsed.size).toBe(1);
    // whichever row happens to be last is what every line on the document got
    expect([...collapsed.values()][0]).toBe('PC151-14|gap12|divan8|leg4');
  });

  test('the two keys disagree, which is exactly the production symptom', () => {
    const perLine = new Set(SO_006572_NK1046Q.map((r) => build(r.Desc2)));
    const perDoc = new Set([build(SO_006572_NK1046Q[SO_006572_NK1046Q.length - 1].Desc2)]);
    expect(perLine.size).toBeGreaterThan(perDoc.size);
    // the SO lines that were stamped PC151-14 conflicted with POs built to -01 and -02
    expect(perLine.has('PC151-01|gap10|divan8|leg4')).toBe(true);
    expect(perDoc.has('PC151-01|gap10|divan8|leg4')).toBe(false);
  });
});
