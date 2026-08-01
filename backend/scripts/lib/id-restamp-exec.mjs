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
//   Two structural causes are closed here rather than argued about:
//   (a) the ROW-PAIR is now ONE savepoint scope — the movement UPDATE and its
//       consumption UPDATEs commit or roll back TOGETHER, and EVERY statement
//       between SAVEPOINT and RELEASE sits inside the try; nothing that can
//       raise runs outside it;
//   (b) INTRA-BATCH SELF-COLLISION is expected and classified: two dangling
//       rows restamping to the SAME unique key — the first succeeds, the
//       second's 23505 is filed as a duplicate (of a pre-existing real
//       movement OR of a sibling restamped earlier in this run; the report
//       says which is possible), never rethrown.
//   As a belt against any escape shape not yet imagined, the per-row catch
//   re-arms the transaction (ROLLBACK TO SAVEPOINT inside its own try) and
//   then PROVES the transaction is still usable with a SELECT 1; if that
//   probe fails the transaction is poisoned and the run aborts loudly — but
//   a poisoned transaction can no longer masquerade as a clean commit.
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

        /* One savepoint per UNIT (a movement with its consumptions, or a
           standalone consumption). Everything that can raise sits inside the
           try; a 23505 anywhere in the unit rolls the WHOLE unit back and
           classifies it, so a pair can never split. */
        const runUnit = async (unit) => {
          await tx.unsafe("SAVEPOINT sp_unit");
          try {
            let movCount = 0;
            let consCount = 0;
            if (unit.movement) {
              const u = await tx.unsafe(
                `UPDATE ${M} SET source_doc_id = $1 WHERE id = $2 AND source_doc_id::text = $3`,
                [p.resolvedDocId, unit.movement.id, unit.movement.doc_id],
              );
              if (u.count === 1) movCount += 1;
              else {
                await tx.unsafe("RELEASE SAVEPOINT sp_unit");
                out.casSkipped += 1 + unit.consumptions.length;
                return;
              }
            }
            for (const c of unit.consumptions) {
              const u = await tx.unsafe(
                `UPDATE ${K} SET source_doc_id = $1 WHERE id = $2 AND source_doc_id::text = $3`,
                [p.resolvedDocId, c.id, c.doc_id],
              );
              if (u.count === 1) consCount += 1;
              else out.casSkipped += 1;
            }
            await tx.unsafe("RELEASE SAVEPOINT sp_unit");
            out.movements += movCount;
            out.consumptions += consCount;
            if (unit.movement) restampedInGroup += 1;
          } catch (e) {
            // Re-arm the transaction FIRST; if even that fails the transaction
            // is poisoned and nothing further can be trusted.
            try {
              await tx.unsafe("ROLLBACK TO SAVEPOINT sp_unit");
            } catch (rollbackErr) {
              throw new Error(
                `transaction poisoned while recovering from "${e?.message ?? e}" (rollback-to-savepoint failed: ${rollbackErr?.message ?? rollbackErr}) — aborting; NOTHING from this run is committed`,
              );
            }
            if (e?.code !== "23505") throw e;
            await tx.unsafe("SELECT 1"); // prove the transaction is usable again
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
