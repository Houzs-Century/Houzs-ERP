/* Gap review P18: the History drawer printed an inline picture's base64 and long
   texts in full. A picture now reads "[image]"; text past AUDIT_VALUE_MAX is cut
   with "…" and the full text stays in the tooltip. */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { fmtSen } from '@2990s/shared';
import { AuditHistoryPanel } from './AuditHistoryPanel';
import type { AuditLabelDictionary, AuditLogEntry } from './audit-labels';
import { AUDIT_VALUE_MAX, auditValueShown, auditValueText } from './audit-value';

const DICT: AuditLabelDictionary = { actions: { UPDATE: 'Updated' }, fields: {}, moneyFields: new Set(['total_sen']) };
const PNG = 'data:image/png;base64,' + 'iVBORw0KGgo'.repeat(400);

afterEach(cleanup);

describe('auditValueText / auditValueShown', () => {
  it('a picture reads [image]', () => {
    expect(auditValueText('signature', PNG, DICT)).toBe('[image]');
  });

  it('a picture inside an object value reads [image]', () => {
    expect(auditValueText('photo', { url: PNG, w: 3 }, DICT)).toBe('{"url":"[image]","w":3}');
  });

  it('money, blanks and plain text read as before', () => {
    expect(auditValueText('total_sen', 123456, DICT)).toBe(fmtSen(123456));
    expect(auditValueText('note', '', DICT)).toBe('—');
    expect(auditValueText('status', 'IN_TRANSIT', DICT)).toBe('IN TRANSIT');
  });

  it('long text is cut at AUDIT_VALUE_MAX with an ellipsis; short text is untouched', () => {
    const long = 'x'.repeat(AUDIT_VALUE_MAX + 50);
    expect(auditValueShown(long)).toBe('x'.repeat(AUDIT_VALUE_MAX) + '…');
    expect(auditValueShown('short')).toBe('short');
  });
});

describe('the History drawer', () => {
  it('shows [image] and a cut long text, with the full text as the tooltip', () => {
    const long = 'Customer asked to call first. '.repeat(40).trim();
    const entry: AuditLogEntry = {
      id: '1', action: 'UPDATE', actor_name_snapshot: 'Wei', created_at: '2026-11-10T00:00:00Z',
      source: null, note: null,
      field_changes: [
        { field: 'signature', from: null, to: PNG },
        { field: 'note', from: 'old', to: long },
      ],
    };
    render(<AuditHistoryPanel recordLabel="HC-SO-1" entityName="Sales order" entries={[entry]} labels={DICT} onClose={() => {}} error={null} />);
    fireEvent.click(screen.getByText(/Changes \(2\)/));
    expect(screen.getByText('[image]')).toBeTruthy();
    expect(document.body.textContent).not.toContain('base64');
    const cut = screen.getByTitle(long);
    expect(cut.textContent).toBe(long.slice(0, AUDIT_VALUE_MAX) + '…');
  });
});
