// What check-pi-grn-picker-window.mjs CALLS each measured shape. The SQL is
// only runnable against a real database; the sentences are not, and they are
// the part that can turn "the window was never full" into a clean-looking pass.
import { describe, expect, it } from 'vitest';

import {
  ASSUMED_ROW_CEILING,
  PICKER_WINDOW,
  REFUSED_URI_BYTES,
  assessCompany,
  describeCompany,
} from '../scripts/lib/pi-grn-picker-window.mjs';

/* postgres returns COUNT(*) / SUM() as strings, so the fixtures do too. */
const row = (o) => ({
  company_id: '1',
  company_code: 'HOUZS',
  posted_notes: '0',
  posted_lines: '0',
  outstanding_notes: '0',
  outstanding_lines: '0',
  outstanding_notes_outside_window: '0',
  outstanding_lines_outside_window: '0',
  visible_notes_now: '0',
  visible_lines_now: '0',
  lines_in_window: '0',
  boundary_date: null,
  notes_newer_than_boundary: '0',
  lines_newer_than_boundary: '0',
  notes_on_boundary_date: '0',
  outstanding_notes_on_boundary_date: '0',
  outstanding_notes_strictly_older: '0',
  min_lines_on_boundary_window: null,
  max_lines_on_boundary_window: null,
  max_lines_one_note: '0',
  received_at_null: '0',
  line_company_mismatch: '0',
  view_disagreements: '0',
  ...o,
});
const kinds = (r) => assessCompany(r).verdicts.map((v) => v.kind);

describe('assessCompany', () => {
  it('a company under the window is NOT_HIDDEN_YET, never a bare pass', () => {
    const a = assessCompany(row({
      posted_notes: '320', posted_lines: '610', outstanding_notes: '197', outstanding_lines: '494',
      visible_notes_now: '197', visible_lines_now: '494', lines_in_window: '610',
    }));
    expect(a.verdicts.map((v) => v.kind)).toEqual(['NOT_HIDDEN_YET']);
    expect(a.verdicts[0].text).toContain(`starts hiding notes at ${PICKER_WINDOW + 1}`);
    expect(a.facts).toMatchObject({ windowFull: false, hiddenNotesMin: 0, hiddenNotesMax: 0, windowLinesMin: 610, windowLinesMax: 610 });
  });

  it('exactly 500 notes is still not full — the 501st is the first one that falls out', () => {
    expect(kinds(row({ posted_notes: '500', lines_in_window: '800', notes_newer_than_boundary: '480', notes_on_boundary_date: '20' })))
      .toEqual(['NOT_HIDDEN_YET', 'URI_AT_REFUSED_SIZE']);
  });

  it('counts notes strictly older than the window edge as HIDDEN, with no range when no tie is involved', () => {
    const a = assessCompany(row({
      posted_notes: '612', outstanding_notes: '230',
      outstanding_notes_outside_window: '12', outstanding_lines_outside_window: '31',
      boundary_date: '2026-07-02',
      notes_newer_than_boundary: '497', notes_on_boundary_date: '3', outstanding_notes_on_boundary_date: '0',
      outstanding_notes_strictly_older: '12',
      lines_in_window: '900', lines_newer_than_boundary: '894',
      min_lines_on_boundary_window: '6', max_lines_on_boundary_window: '6',
    }));
    const hidden = a.verdicts.find((v) => v.kind === 'HIDDEN');
    expect(hidden?.text).toMatch(/^12 goods-received note\(s\)/);
    expect(hidden?.text).toContain('31 line(s)');
    expect(a.facts).toMatchObject({ hiddenNotesMin: 12, hiddenNotesMax: 12 });
  });

  it('a tie on the edge date can hide notes; it must not read as NOT_HIDDEN', () => {
    // 495 notes newer than the edge date, 15 on it: 5 fit, 10 fall out, 3 of
    // the 15 have unbilled lines — anywhere from none to all three are hidden.
    const a = assessCompany(row({
      posted_notes: '510', outstanding_notes: '40',
      boundary_date: '2026-06-30',
      notes_newer_than_boundary: '495', notes_on_boundary_date: '15', outstanding_notes_on_boundary_date: '3',
      outstanding_notes_strictly_older: '0',
      outstanding_notes_outside_window: '1',
      lines_in_window: '700', lines_newer_than_boundary: '690',
      min_lines_on_boundary_window: '5', max_lines_on_boundary_window: '14',
    }));
    expect(a.facts).toMatchObject({ hiddenNotesMin: 0, hiddenNotesMax: 3, windowLinesMin: 695, windowLinesMax: 704 });
    expect(a.verdicts.map((v) => v.kind)).toContain('HIDDEN_BY_TIE');
    expect(a.verdicts.map((v) => v.kind)).not.toContain('NOT_HIDDEN');
  });

  it('a tie cannot hide more outstanding notes than actually fall out', () => {
    // 499 newer, 4 on the edge date (1 slot, 3 out), all 4 outstanding: at least 3 hidden, at most 3.
    const a = assessCompany(row({
      posted_notes: '503', notes_newer_than_boundary: '499', notes_on_boundary_date: '4',
      outstanding_notes_on_boundary_date: '4', outstanding_notes_strictly_older: '0',
      outstanding_notes_outside_window: '3',
    }));
    expect(a.facts).toMatchObject({ hiddenNotesMin: 3, hiddenNotesMax: 3 });
    expect(a.verdicts[0].kind).toBe('HIDDEN');
  });

  it('a full window with every unbilled note inside it is NOT_HIDDEN', () => {
    expect(kinds(row({
      posted_notes: '700', notes_newer_than_boundary: '499', notes_on_boundary_date: '2',
      outstanding_notes_on_boundary_date: '0', outstanding_notes_strictly_older: '0',
    }))[0]).toBe('NOT_HIDDEN');
  });

  it('flags the unpaged line read against the assumed row ceiling, exactly and as a range', () => {
    expect(kinds(row({ posted_notes: '300', lines_in_window: String(ASSUMED_ROW_CEILING + 1) })))
      .toContain('ROW_CEILING_EXCEEDED');
    expect(kinds(row({ posted_notes: '300', lines_in_window: String(ASSUMED_ROW_CEILING) })))
      .not.toContain('ROW_CEILING_EXCEEDED');
    expect(kinds(row({
      posted_notes: '520', notes_newer_than_boundary: '490', notes_on_boundary_date: '30',
      lines_newer_than_boundary: '950', min_lines_on_boundary_window: '10', max_lines_on_boundary_window: '80',
    }))).toContain('ROW_CEILING_AT_RISK');
  });

  it('sizes the id list off the notes actually sent, capped at the window', () => {
    expect(assessCompany(row({ posted_notes: '400' })).facts.idListBytes).toBe(400 * 39);
    expect(kinds(row({ posted_notes: '400' }))).not.toContain('URI_AT_REFUSED_SIZE');
    const full = assessCompany(row({ posted_notes: '9000', notes_newer_than_boundary: '499', notes_on_boundary_date: '1' }));
    expect(full.facts.idListBytes).toBe(PICKER_WINDOW * 39);
    expect(full.facts.idListBytes).toBeGreaterThanOrEqual(REFUSED_URI_BYTES);
  });

  it('an empty company is EMPTY, not a pass', () => {
    expect(kinds(row({ posted_notes: '0' }))).toEqual(['EMPTY']);
  });

  it('reports the two facts a fix leans on, and an absent view is not "0 disagreements"', () => {
    expect(kinds(row({ posted_notes: '10', line_company_mismatch: '2' }))).toContain('LINE_COMPANY_MISMATCH');
    expect(kinds(row({ posted_notes: '10', view_disagreements: '1' }))).toContain('VIEW_DISAGREES');
    const noView = assessCompany(row({ posted_notes: '10', view_disagreements: null }));
    expect(noView.facts.viewDisagreements).toBeNull();
    expect(describeCompany(noView).join('\n')).toContain('view absent, not compared');
  });
});

describe('describeCompany', () => {
  it('prints counts and dates only', () => {
    const text = describeCompany(assessCompany(row({ posted_notes: '12', posted_lines: '30', boundary_date: '2026-09-01' }))).join('\n');
    expect(text).toContain('company 1 (HOUZS)');
    expect(text).toContain('posted, not-held GRNs                  : 12 (lines: 30)');
    // No field this module is handed is a document number, a name or money;
    // pin that the output does not grow one by accident.
    expect(text).not.toMatch(/GRN-\d|RM\s?\d|_sen\b/);
  });
});
