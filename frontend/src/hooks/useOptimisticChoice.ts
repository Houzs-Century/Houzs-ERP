import { useState } from "react";

interface PendingChoice {
  value: string | null;
  basedOnSavedValue: string | null;
}

export interface OptimisticChoice {
  shownValue: string | null;
  choose: (nextValue: string | null, save: () => Promise<boolean>) => Promise<void>;
}

export function useOptimisticChoice(savedValue: string | null): OptimisticChoice {
  const [pendingChoice, setPendingChoice] = useState<PendingChoice | null>(null);

  const isPendingCurrent = pendingChoice !== null && pendingChoice.basedOnSavedValue === savedValue;
  const shownValue = isPendingCurrent ? pendingChoice.value : savedValue;

  const choose = async (nextValue: string | null, save: () => Promise<boolean>): Promise<void> => {
    setPendingChoice({ value: nextValue, basedOnSavedValue: savedValue });
    const isSaved = await save();
    if (!isSaved) setPendingChoice(null);
  };

  return { shownValue, choose };
}
