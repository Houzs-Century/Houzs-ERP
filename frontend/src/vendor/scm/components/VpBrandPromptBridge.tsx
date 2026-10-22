// VpBrandPromptBridge -- hands the live pick-one dialog to vp-brand-prompt.ts
// so a save in the query layer can ask "which brand is this bill for?"
// (owner 2026-09-27). Renders nothing. Mount inside a <ChoiceProvider>, once per
// shell: desktop Scm2990Shell and mobile MobileApp.

import { useEffect } from 'react';
import { useChoice } from './ChoiceDialog';
import { registerVpBrandPrompt } from '../lib/vp-brand-prompt';

export function VpBrandPromptBridge() {
  const choose = useChoice();
  useEffect(() => {
    registerVpBrandPrompt(choose);
    return () => registerVpBrandPrompt(null);
  }, [choose]);
  return null;
}
