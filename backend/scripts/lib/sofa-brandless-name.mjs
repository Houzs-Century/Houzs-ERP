/* A sofa SKU name with its brand glued on the front, and the name it should
   have. Before #4376 the Model save and Generate SKUs built
   `{branding} SOFA {model name} {compartment}`, so a 2990 model branded
   "2990s Sofa" minted "2990S SOFA SOFA BANGGAU 1A(LHF)" and a Houzs one
   "ZANOTTI SOFA SOFFIO 2B(LHF)". The house name is `SOFA {model name}
   {compartment}`; the brand lives in the branding column.

   Returns null when the name does not carry the brand prefix (nothing to do),
   { ok: true, to } when stripping it gives exactly the house name, and
   { ok: false, why } when it does not: a name that strips to something else is
   left for a person, not guessed at. */
export function brandlessSofaName({ name, branding, modelName, code }) {
  const n = String(name ?? '').trim().toUpperCase();
  const b = String(branding ?? '').trim().toUpperCase();
  if (!b || !n.startsWith(`${b} `)) return null;
  const rest = n.slice(b.length + 1).trim();
  if (!rest.startsWith('SOFA ')) return null;

  const dash = String(code ?? '').indexOf('-');
  const model = String(modelName ?? '').trim().toUpperCase();
  if (dash < 0 || !model) return { ok: false, why: `cannot derive the house name (code "${code}", model name "${modelName ?? ''}")` };
  const expected = `SOFA ${model} ${String(code).slice(dash + 1).toUpperCase()}`;
  if (rest !== expected) return { ok: false, why: `strips to "${rest}" but the house name is "${expected}"` };
  return { ok: true, to: rest };
}
