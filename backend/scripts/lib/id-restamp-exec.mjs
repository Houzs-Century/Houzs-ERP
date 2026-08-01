// The id-restamp EXECUTOR (repair-2990-doc-refs part `ids`), extracted so the
// real thing — not a re-enactment — runs under the tests-pg suite against a
// real Postgres with a real unique index. Two live APPLY failures taught two
// lessons this file now embodies:
//
//   2026-08-01 round 1: a dangling movement restamped to the real DO id can
//   collide with a movement the document ALREADY carries
//   (uq_inv_mov_do_source) — an import DUPLICATE, not a mis-id.
//
//   2026-08-01 round 2: with per-statement savepoints, ONE collision was
//   classified and a SECOND still surfaced raw and aborted the transaction.
//   The pg-integration suite then REPRODUCED it (dry run green, APPLY raw
//   23505 with no user frames in the trace) and named the true mechanism:
//   postgres.js's `begin` tracks every query error in the transaction, and a
//   MANUAL `SAVEPOINT` statement is invisible to that bookkeeping — the
//   caught-and-recovered 23505 was RETHROWN when the callback resolved and
//   postgres.js went to COMMIT, throwing away the clean rows with it. (The
//   dry run never commits — it throws its own rollback marker — which is why
//   only APPLY died, both live and in the suite.)
//   Three things close it here:
//   (a) savepoints now use postgres.js's NATIVE `tx.savepoint(fn)` — the API
//       that exists precisely so a recovered error does not poison the
//       transaction's commit;
//   (b) the ROW-PAIR is ONE savepoint scope — the movement UPDATE and its
//       consumption UPDATEs commit or roll back TOGETHER;
//   (c) INTRA-BATCH SELF-COLLISION is expected and classified: two dangling
//       rows restamping to the SAME unique key — the first succeeds, the
//       second's 23505 is filed as a duplicate (of a pre-existing real
//       movement OR of a sibling restamped earlier in this run; the report
//       says which is possible), never rethrown.
//   As a belt, after every classified duplicate a SELECT 1 PROVES the
//   transaction is still usable; if that probe fails the transaction is
//   poisoned and the run aborts loudly — a poisoned transaction can no
//   longer masquerade as a clean commit. tests-pg/idRestampExec.pg.test.ts
//   pins ALL of this against a real Postgres and a real partial unique index.
//
// The clean rows COMMIT no matter how many duplicates are classified.
// Duplicates are REPORTED, never deleted (removal is a separate explicit
// decision; those rows keep counting in audit section 4, now classified).
//
// `sql` is a postgres.js instance; `schema` defaults to "scm" and exists so
// the pg test can point the SAME code at a scratch schema. `commit=false`
// exercises the identical writes and rolls back at the end (the dry run's
// verdicts are applied truth, not prediction; the UPDATEs fire no triggers —
// audit section 0a).
const IDENT = /^[a-z_][a-z0-9_]*$/;

export async function execIdRestamp(sql, plan, { commit = false, schema = "scm" } = {}) {
  if (!IDENT.test(schema)) throw new Error(`execIdRestamp: unsafe schema "${schema}"`);
  const M = `"${schema}"."inventory_movements"`;
  const K = `"${schema}"."inventory_lot_consumptions"`;
  const out = {
    movements: 0,
    consumptions: 0,
    duplicates: [], // { table, rowId, group, oldId, resolvedDocId, constraint, consumptionsFollowing, maySelfCollide }
    casSkipped: 0,
  };
  if (plan.length === 0) return out;

  try {
    await sql.begin(async (tx) => {
      for (const p of plan) {
        const danglingIds = p.idWrites.filter((w) => w.action === "restamp").map((w) => w.id);
        const movRows = await tx.unsafe(
          `SELECT id::text AS id, source_doc_id::text AS doc_id
             FROM ${M}
            WHERE company_id = $1 AND source_doc_type = $2 AND source_doc_no = $3
              AND source_doc_id::text = ANY($4)
            ORDER BY id`,
          [p.companyId, p.docType, p.docNo, danglingIds],
        );
        const consRows = await tx.unsafe(
          `SELECT id::text AS id, source_doc_id::text AS doc_id, movement_id::text AS movement_id
             FROM ${K}
            WHERE company_id = $1 AND source_doc_type = $2 AND source_doc_no = $3
              AND source_doc_id::text = ANY($4)
            ORDER BY id`,
          [p.companyId, p.docType, p.docNo, danglingIds],
        );
        const consByMovement = new Map();
        const standaloneCons = [];
        for (const r of consRows) {
          if (r.movement_id != null && movRows.some((m) => m.id === r.movement_id)) {
            const arr = consByMovement.get(r.movement_id) ?? [];
            arr.push(r);
            consByMovement.set(r.movement_id, arr);
          } else {
            standaloneCons.push(r);
          }
        }

        let restampedInGroup = 0;

        /* One NATIVE savepoint per UNIT (a movement with its consumptions, or
           a standalone consumption). tx.savepoint(fn) is postgres.js's own
           API: on an error inside, it issues ROLLBACK TO SAVEPOINT itself and
           rethrows WITHOUT marking the outer transaction failed — the exact
           property a manual SAVEPOINT statement lacks (a caught 23505 was
           being rethrown at COMMIT, discarding the clean rows: both live
           APPLY failures, reproduced by the pg suite). A 23505 anywhere in
           the unit rolls the WHOLE unit back and classifies it, so a pair
           can never split. */
        const runUnit = async (unit) => {
          try {
            const done = await tx.savepoint(async (sp) => {
              let movCount = 0;
              let consCount = 0;
              let cas = 0;
              if (unit.movement) {
                const u = await sp.unsafe(
                  `UPDATE ${M} SET source_doc_id = $1 WHERE id = $2 AND source_doc_id::text = $3`,
                  [p.resolvedDocId, unit.movement.id, unit.movement.doc_id],
                );
                if (u.count !== 1) {
                  return { movCount: 0, consCount: 0, cas: 1 + unit.consumptions.length };
                }
                movCount += 1;
              }
              for (const c of unit.consumptions) {
                const u = await sp.unsafe(
                  `UPDATE ${K} SET source_doc_id = $1 WHERE id = $2 AND source_doc_id::text = $3`,
                  [p.resolvedDocId, c.id, c.doc_id],
                );
                if (u.count === 1) consCount += 1;
                else cas += 1;
              }
              return { movCount, consCount, cas };
            });
            out.movements += done.movCount;
            out.consumptions += done.consCount;
            out.casSkipped += done.cas;
            if (unit.movement && done.movCount === 1) restampedInGroup += 1;
          } catch (e) {
            if (e?.code !== "23505") throw e;
            // The native savepoint already rolled the unit back. Prove the
            // transaction is still usable; a failing probe means it is
            // poisoned and nothing further can be trusted.
            try {
              await tx.unsafe("SELECT 1");
            } catch (probeErr) {
              throw new Error(
                `transaction poisoned after classifying "${e?.message ?? e}" (probe failed: ${probeErr?.message ?? probeErr}) — aborting; NOTHING from this run is committed`,
              );
            }
            out.duplicates.push({
              table: unit.movement ? "inventory_movements" : "inventory_lot_consumptions",
              rowId: unit.movement ? unit.movement.id : unit.consumptions[0]?.id,
              group: `${p.docType} ${p.docNo}`,
              oldId: unit.movement ? unit.movement.doc_id : unit.consumptions[0]?.doc_id,
              resolvedDocId: p.resolvedDocId,
              constraint: e.constraint_name ?? "(unique index)",
              consumptionsFollowing: unit.movement ? unit.consumptions.length : 0,
              maySelfCollide: restampedInGroup > 0,
            });
          }
        };

        for (const m of movRows) {
          await runUnit({ movement: m, consumptions: consByMovement.get(m.id) ?? [] });
        }
        for (const c of standaloneCons) {
          await runUnit({ movement: null, consumptions: [c] });
        }
      }
      if (!commit) throw { __rollback: true };
    });
  } catch (e) {
    if (!(e && e.__rollback)) throw e;
  }
  return out;
}

/* part=dedupe (owner authorization 2026-08-01: "继续 全部可以", including
   REMOVAL). Deletes the movement+consumption pairs part=ids classifies
   `duplicate-of-real` — under a rule STRICTER than the index collision:
   the real document must carry a FULL-ROW twin, same (company, product_code,
   variant_key, warehouse, movement_type, qty), decided by
   classifyDuplicateMovement in the caller. The delete REVERSES the
   duplicate's whole ledger effect in one transaction: its consumption rows
   go with it and each consumed lot gets its qty_remaining RESTORED (+qty),
   so lot conservation (audit 2a) holds by construction — deleting only the
   consumption rows would have manufactured a fresh deficit.

   Phase 1 (always): detect duplicates by exercising the restamp in a
   rolled-back transaction (the SAME evidence part=ids reports — the two
   parts cannot disagree), then fetch every candidate's full row, its real
   counterparts, its consumptions and their lots. Phase 2 (commit only): one
   transaction, per movement — DELETE consumptions (RETURNING, count must
   match the plan), restore each lot, DELETE the movement (CAS on the
   dangling id) — any drift aborts the WHOLE transaction; re-run the dry run.
   Nothing here fires triggers: the ledger's only trigger is AFTER INSERT
   (audit section 0a), and these are DELETEs and lot UPDATEs. */
export async function execDedupe(sql, plan, classify, { commit = false, schema = "scm" } = {}) {
  if (!IDENT.test(schema)) throw new Error(`execDedupe: unsafe schema "${schema}"`);
  const M = `"${schema}"."inventory_movements"`;
  const K = `"${schema}"."inventory_lot_consumptions"`;
  const L = `"${schema}"."inventory_lots"`;

  // Phase 1 — the duplicates, by the same exercised evidence part=ids prints.
  const preview = await execIdRestamp(sql, plan, { commit: false, schema });
  const dupMovements = preview.duplicates.filter((d) => d.table === "inventory_movements");

  const candidates = [];
  for (const d of dupMovements) {
    const g = plan.find((p) => `${p.docType} ${p.docNo}` === d.group);
    const rows = await sql.unsafe(
      `SELECT id::text AS id, movement_type, qty, unit_cost_sen, total_cost_sen,
              company_id, warehouse_id::text AS warehouse_id, product_code,
              COALESCE(variant_key,'') AS variant_key, batch_no,
              source_doc_type, source_doc_no, source_doc_id::text AS doc_id, created_at
         FROM ${M} WHERE id = $1`, [d.rowId]);
    if (rows.length !== 1) continue; // vanished since detection — re-run
    const m = rows[0];
    const counterparts = await sql.unsafe(
      `SELECT id::text AS id, movement_type, qty, company_id, warehouse_id::text AS warehouse_id,
              product_code, COALESCE(variant_key,'') AS variant_key
         FROM ${M} WHERE source_doc_id::text = $1 AND id <> $2`,
      [d.resolvedDocId, m.id]);
    const verdict = classify({
      duplicate: {
        companyId: m.company_id, productCode: m.product_code, variantKey: m.variant_key,
        warehouseId: m.warehouse_id, movementType: m.movement_type, qty: m.qty,
      },
      counterparts: counterparts.map((c) => ({
        movementId: c.id, companyId: c.company_id, productCode: c.product_code,
        variantKey: c.variant_key, warehouseId: c.warehouse_id, movementType: c.movement_type, qty: c.qty,
      })),
    });
    const consumptions = await sql.unsafe(
      `SELECT k.id::text AS id, k.lot_id::text AS lot_id, k.qty_consumed, k.unit_cost_sen, k.total_cost_sen,
              (l.id IS NOT NULL) AS lot_exists, COALESCE(l.qty_remaining, 0) AS lot_remaining
         FROM ${K} k LEFT JOIN ${L} l ON l.id = k.lot_id
        WHERE k.movement_id = $1 ORDER BY k.id`, [m.id]);
    candidates.push({ dup: d, movement: m, counterparts, consumptions, verdict });
  }

  const result = {
    candidates,
    deletable: candidates.filter((c) => c.verdict.verdict === "delete"),
    refused: candidates.filter((c) => c.verdict.verdict !== "delete"),
    deletedMovements: 0,
    deletedConsumptions: 0,
    lotsRestored: 0,
  };
  if (!commit || result.deletable.length === 0) return result;

  // Phase 2 — one transaction; any drift aborts everything.
  await sql.begin(async (tx) => {
    for (const c of result.deletable) {
      const gone = await tx.unsafe(
        `DELETE FROM ${K} WHERE movement_id = $1 RETURNING id::text AS id, lot_id::text AS lot_id, qty_consumed`,
        [c.movement.id]);
      if (gone.length !== c.consumptions.length) {
        throw new Error(`movement ${c.movement.id}: ${gone.length} consumption(s) deleted but the plan saw ${c.consumptions.length} — data moved since the dry run; WHOLE dedupe rolled back, re-run`);
      }
      for (const g of gone) {
        const u = await tx.unsafe(
          `UPDATE ${L} SET qty_remaining = qty_remaining + $1 WHERE id = $2`,
          [g.qty_consumed, g.lot_id]);
        if (u.count === 1) result.lotsRestored += 1;
        // a consumption pointing at a MISSING lot restores nothing — the plan
        // already printed lot_exists=false for it.
      }
      const dm = await tx.unsafe(
        `DELETE FROM ${M} WHERE id = $1 AND source_doc_id::text = $2`,
        [c.movement.id, c.movement.doc_id]);
      if (dm.count !== 1) {
        throw new Error(`movement ${c.movement.id} changed since the plan (delete matched ${dm.count}) — WHOLE dedupe rolled back, re-run`);
      }
      result.deletedMovements += 1;
      result.deletedConsumptions += gone.length;
    }
  });
  return result;
}

export function printIdRestampExec(out, committed, log) {
  const verb = committed ? "" : "WOULD ";
  log(`  ${verb}restamp: inventory_movements=${out.movements} row(s), inventory_lot_consumptions=${out.consumptions} row(s)`);
  if (out.duplicates.length) {
    log(`  duplicate-of-real — restamp REFUSED by the ledger's own unique index (${out.duplicates.length} unit(s)); left in place, NOT deleted:`);
    for (const d of out.duplicates) {
      log(`    ${d.table} ${d.rowId}  (${d.group}, dangling id ${d.oldId})${d.consumptionsFollowing ? ` +${d.consumptionsFollowing} consumption row(s) rolled back with it` : ""}: restamping to ${d.resolvedDocId} violates ${d.constraint} — this row duplicates a movement the document ${d.maySelfCollide ? "carries (pre-existing, or a sibling restamped earlier in this run)" : "already carries"}. Removal is a separate, explicit decision; until then it still counts in audit section 4, now classified.`);
    }
  }
  if (out.casSkipped) log(`  rows skipped by the compare-and-set (changed since the plan): ${out.casSkipped} — re-run the dry run.`);
}
