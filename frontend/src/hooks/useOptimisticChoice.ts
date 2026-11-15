import { useState } from "react";

interface PendingChoice {
  value: string | null;
  basedOnSavedValue: string | null;
}

export interface OptimisticChoice {
  shownValue: string | null;
  choose: (nextValue: string | null, save: () => Promise<boolean>) => Promise<void>;
}

// A toggle shows the picked option at once instead of after the save and reload
// round trips (about 1.7 s on staging). The pick is dropped when the save fails,
// or once the saved value it was based on changes (the reload landed).
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
