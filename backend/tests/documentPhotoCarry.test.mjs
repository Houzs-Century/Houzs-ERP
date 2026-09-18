// The pure planner behind the PO/DO photo backfill
// (backend/scripts/backfill-document-line-photos.mjs). The script's DB I/O is
// verified by dispatch (plan first); this pins the decision that matters —
// which of two "missing a key" shapes is a DEFECT and which is a printing
// decision the owner makes.
//
// The regression case is the second describe block: on 2026-09-11 the first
// draft of this repair planned 310 PO lines because it asked "is any source key
// absent?". 193 of those already showed the book's own photograph on the
// purchase order and would have gained a second sketch on an already-received
// document. docs/bugs/0819.
import { describe, it, expect } from 'vitest';
import { planPhotoCarry, verifyPhotoCarry } from '../scripts/lib/document-photo-carry.mjs';

const SO_A = 'so-items/HC-SO-013422/L1/ac-919030-1.jpg';
const SO_B = 'so-items/HC-SO-013422/L1/ac-919030-2.jpg';
const PO_OWN = 'po-items/HC-PO-001696/L1/ac-222080-1.jpg';

const row = (o) => ({
  id: 'L1', companyId: 1, table: 'purchase_order_items', docNo: 'HC-PO-010148',
  itemCode: '9058-1A(LHF)', docKeys: [], soKeys: [SO_A], erpMinted: false, ...o,
});

describe('planPhotoCarry — a line showing NO photo is filled', () => {
  it('fills an empty line with every source key', () => {
    const { fills, mirrors, writes } = planPhotoCarry(
      [row({ docKeys: [], soKeys: [SO_A, SO_B] })], { includeMirror: false },
    );
    expect(fills.map((f) => f.next)).toEqual([[SO_A, SO_B]]);
    expect(mirrors).toEqual([]);
    expect(writes).toHaveLength(1);
  });

  it('leaves a line that already carries everything alone', () => {
    const { fills, mirrors, complete, writes } = planPhotoCarry(
      [row({ docKeys: [SO_A], soKeys: [SO_A] })], { includeMirror: true },
    );
    expect([fills, mirrors, writes]).toEqual([[], [], []]);
    expect(complete).toHaveLength(1);
  });
});

describe('planPhotoCarry — a line already showing its OWN photo is held back', () => {
  it('does NOT write the 193-line shape by default', () => {
    const { fills, mirrors, writes } = planPhotoCarry(
      [row({ docKeys: [PO_OWN], soKeys: [SO_A] })], { includeMirror: false },
    );
    expect(fills).toEqual([]);
    expect(mirrors).toHaveLength(1);          // counted and reported
    expect(writes).toEqual([]);               // but not written
  });

  it('writes it only when INCLUDE_MIRROR asked for it, own key FIRST', () => {
    const { writes } = planPhotoCarry(
      [row({ docKeys: [PO_OWN], soKeys: [SO_A] })], { includeMirror: true },
    );
    expect(writes[0].next).toEqual([PO_OWN, SO_A]);
  });

  it('never drops the line own key, whichever way the flag goes', () => {
    for (const includeMirror of [true, false]) {
      const { fills, mirrors } = planPhotoCarry(
        [row({ docKeys: [PO_OWN], soKeys: [SO_A] })], { includeMirror },
      );
      for (const p of [...fills, ...mirrors]) expect(p.next).toContain(PO_OWN);
    }
  });

  it('refuses to decide includeMirror on the caller behalf', () => {
    expect(() => planPhotoCarry([row({})], {})).toThrow(/includeMirror/);
    expect(() => planPhotoCarry([row({})], undefined)).toThrow(/includeMirror/);
  });
});

describe('verifyPhotoCarry — the SHAPE, not a row count', () => {
  const written = [{ ...row({ docKeys: [PO_OWN], soKeys: [SO_A] }), next: [PO_OWN, SO_A] }];

  it('passes when the line carries both', () => {
    expect(verifyPhotoCarry(written, new Map([['L1', { docKeys: [PO_OWN, SO_A] }]])))
      .toEqual([]);
  });

  it('catches a source key that never landed', () => {
    expect(verifyPhotoCarry(written, new Map([['L1', { docKeys: [PO_OWN] }]])))
      .toEqual(['HC-PO-010148 9058-1A(LHF): 1 source key(s) still absent']);
  });

  it('catches the line own key being lost — an UPDATE that overwrote', () => {
    expect(verifyPhotoCarry(written, new Map([['L1', { docKeys: [SO_A] }]])))
      .toEqual(['HC-PO-010148 9058-1A(LHF): LOST 1 key(s) of its own']);
  });

  it('catches a row that is gone rather than reading it as clean', () => {
    expect(verifyPhotoCarry(written, new Map())).toEqual(['HC-PO-010148 9058-1A(LHF): row is gone']);
  });
});
