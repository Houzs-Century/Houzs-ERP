// base_model is the model CODE copied onto the SKU and never follows a rename
// (pricing matches sofa combos on it). The model's live name rides the list as
// model_name; the SKU Master shows and filters on that, code as the fallback.
export const modelLabelOf = (r: { base_model?: string | null; model_name?: string | null }): string =>
  r.model_name || r.base_model || '';

/** Dropdown label: the name, plus the code in brackets so typing the code still finds it. */
export const modelFilterLabel = (name: string, code: string | null | undefined): string =>
  code && code !== name ? `${name} (${code})` : name;
