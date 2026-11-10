// A rack as staff read it: the label without the word "Rack" (owner 2026-11-10:
// "不需要 show rack，直接 show R12.1"). "Rack R12.1" -> "R12.1", "RACK 3" -> "3";
// a label that is only the word stays as typed. Desktop, phone, printed DO and the
// packing list all go through this.
export const shortRackLabel = (label: string): string => label.replace(/^\s*rack\s*/i, '').trim() || label.trim();

export const shortRackLabels = (labels: readonly string[] | null | undefined): string[] => (labels ?? []).map(shortRackLabel);
