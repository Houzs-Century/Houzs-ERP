// SQL for repair-hc0173-model-special-codes.mjs, split out so tests-pg can run
// it against a real postgres.

/** The pool after the swap: FROM becomes TO in FROM's place, and a TO already
 *  in the pool keeps its earlier place (no duplicate). Mirrors the UPDATE. */
export const swapInPool = (pool, from, to) => {
  const out = [];
  for (const s of pool) {
    const v = s === from ? to : s;
    if (!out.includes(v)) out.push(v);
  }
  return out;
};

export const readAddons = (tx, co, codes) => tx`
  SELECT code, active, categories
    FROM scm.special_addons
   WHERE company_id = ${co} AND code = ANY(${codes}::text[])`;

export const readModels = (tx, co, from) => tx`
  SELECT id, category, model_code, name, active, allowed_options->'specials' AS specials
    FROM scm.product_models
   WHERE company_id = ${co}
     AND jsonb_typeof(allowed_options->'specials') = 'array'
     AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(allowed_options->'specials') e WHERE e = ${from}::text)
   ORDER BY category, model_code`;

/** Plan: every Model pool naming FROM, minus the ones whose category TO does
 *  not cover (TO would be filtered out of that Model's line editor anyway). */
export const planModels = (models, from, to, toCategories) => {
  const cats = new Set((toCategories ?? []).map((c) => String(c).toUpperCase()));
  const work = [], refused = [];
  for (const m of models) {
    if (!cats.has(String(m.category).toUpperCase())) {
      refused.push({ ...m, why: `${to} is not offered for ${m.category}` });
      continue;
    }
    work.push({ ...m, hadTo: m.specials.includes(to), next: swapInPool(m.specials, from, to) });
  }
  return { work, refused };
};

export const writeModels = (tx, co, ids, from, to) => tx`
  UPDATE scm.product_models m
     SET allowed_options = jsonb_set(m.allowed_options, '{specials}', (
           SELECT COALESCE(jsonb_agg(x.v ORDER BY x.o), '[]'::jsonb)
             FROM (SELECT CASE WHEN e.v = ${from}::text THEN ${to}::text ELSE e.v END AS v, min(e.o) AS o
                     FROM jsonb_array_elements_text(m.allowed_options->'specials') WITH ORDINALITY e(v, o)
                    GROUP BY 1) x)),
         updated_at = now()
   WHERE m.company_id = ${co}
     AND m.id = ANY(${ids}::uuid[])
     AND jsonb_typeof(m.allowed_options->'specials') = 'array'
     AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(m.allowed_options->'specials') e WHERE e = ${from}::text)
  RETURNING m.id`;

export const readPools = (tx, co, ids) => tx`
  SELECT id, allowed_options->'specials' AS specials
    FROM scm.product_models
   WHERE company_id = ${co} AND id = ANY(${ids}::uuid[])`;
