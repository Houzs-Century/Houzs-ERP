// ----------------------------------------------------------------------------
// JournalDrawer — an entry's card and the manual-journal form in one right
// drawer (the owner's redesign, batch 6 §2.3 a4–a5). The card turns into the
// form on Edit or Copy; the form turns into the saved entry's card. An account
// clicked on the card opens the General ledger on it, with a way back; a
// document opens in its own workspace tab.
// ----------------------------------------------------------------------------

import { useLocation, useNavigate } from 'react-router-dom';
import { ResizableDetailDrawer } from '../../../components/ResizableDetailDrawer';
import { useOpenDocInTab } from '../../../lib/openDocInTab';
import { monthEnd, monthStart } from '../../../lib/dateRangePresets';
import { JeDetailCard, NewJournalForm, type DraftSeed, type EditSeed, type EntryRefs } from '../JournalEntryCards';
import tokens from '../finance/finance-ui.module.css';

export type JournalDrawerState =
  | { mode: 'card'; id: string; refs?: EntryRefs | null }
  | { mode: 'form'; key: number; initial: DraftSeed | null; editing: EditSeed | null; copiedFrom: string | null };

export const newJournalForm = (): JournalDrawerState => ({ mode: 'form', key: Date.now(), initial: null, editing: null, copiedFrom: null });

export function JournalDrawer({ state, onChange, onClose, onToast, backLabel, range }: {
  state: JournalDrawerState | null;
  onChange: (next: JournalDrawerState) => void;
  onClose: () => void;
  onToast: (text: string) => void;
  /** What the General ledger's Back says when an account is opened from here. */
  backLabel: string;
  /** The period an account opens on in the ledger; the entry's month when absent. */
  range?: { from: string; to: string } | null;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const openInTab = useOpenDocInTab();

  const openAccount = (code: string, entryDate: string) => {
    const from = range?.from ?? monthStart(entryDate);
    const to = range?.to ?? monthEnd(entryDate);
    const q = new URLSearchParams({ tab: 'gl', accounts: code, from, to });
    navigate(`/scm/accounting?${q.toString()}`, { state: { back: { to: `${location.pathname}${location.search}`, label: backLabel } } });
  };

  return (
    <ResizableDetailDrawer open={state != null} onClose={onClose} ariaLabel={state?.mode === 'form' ? 'Manual journal' : 'Journal entry'}>
      {state?.mode === 'card' && (
        <div className={tokens.root} style={{ height: '100%' }}>
          <JeDetailCard
            key={state.id}
            id={state.id}
            refs={state.refs ?? null}
            onClose={onClose}
            onToast={onToast}
            onOpenAccount={openAccount}
            onOpenDocument={openInTab}
            onCopy={(seed, from) => onChange({ mode: 'form', key: Date.now(), initial: seed, editing: null, copiedFrom: from })}
            onEdit={(seed) => onChange({ mode: 'form', key: Date.now(), initial: seed, editing: seed, copiedFrom: null })}
          />
        </div>
      )}
      {state?.mode === 'form' && (
        <div className={tokens.root} style={{ height: '100%' }}>
          <NewJournalForm
            key={state.key}
            initial={state.initial}
            editing={state.editing}
            copiedFrom={state.copiedFrom}
            onCancel={onClose}
            onToast={onToast}
            onSaved={(id) => onChange({ mode: 'card', id })}
          />
        </div>
      )}
    </ResizableDetailDrawer>
  );
}
