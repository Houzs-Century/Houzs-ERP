// ----------------------------------------------------------------------------
// useDocChoice — the state behind DocumentChoiceDialog.
//
// A relationship-map slot can stand for several real documents (2 POs, 2 GRNs,
// 2 invoices). Tapping one used to raise a notice that named the doc numbers and
// sent the operator off to a list to find them by hand — and the procurement
// lists search their OWN refs, not the source doc no, so that list would often
// come back empty. Nico, 2026-08-03: "我要可以直接点开，不要只是给我单号".
//
// Shared by all three map hooks (so- / po- / sales-doc-relationship-map) so the
// three maps behave identically. Each hook returns the trio below; the detail
// page renders <DocumentChoiceDialog prompt={choice} … />.
// ----------------------------------------------------------------------------

import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { DocChoice, DocChoicePrompt } from '../../components/scm-v2/DocumentRelationshipMapModal';

export type DocChoiceApi = {
  choice: DocChoicePrompt | null;
  /** Raise the chooser. Callers pass every candidate document + its route. */
  openChoice: (prompt: DocChoicePrompt) => void;
  closeChoice: () => void;
  /** Close and navigate — bound to each row in the dialog. */
  pickChoice: (doc: DocChoice) => void;
};

export function useDocChoice(): DocChoiceApi {
  const navigate = useNavigate();
  const [choice, setChoice] = useState<DocChoicePrompt | null>(null);
  const openChoice = useCallback((prompt: DocChoicePrompt) => setChoice(prompt), []);
  const closeChoice = useCallback(() => setChoice(null), []);
  const pickChoice = useCallback(
    (doc: DocChoice) => {
      setChoice(null);
      navigate(doc.to);
    },
    [navigate],
  );
  return { choice, openChoice, closeChoice, pickChoice };
}
