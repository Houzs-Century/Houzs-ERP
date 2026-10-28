// ----------------------------------------------------------------------------
// PoLineImportModal — import an edited PO lines export back (owner 2026-09-15).
//
// Pick a file -> the server's preview (every change as document, line, field,
// old, new; every refused row with its reason; counts) -> Confirm -> summary.
// Nothing is written before Confirm. The logic is
// vendor/scm/lib/po-line-import-queries.ts; this file only presents it.
// ----------------------------------------------------------------------------

import { useMemo, useRef, useState } from "react";
import { FileUp } from "lucide-react";
import { ModalOverlay } from "./DocumentRelationshipMapModal";
import { Button } from "../Button";
import {
  PO_LINE_IMPORT_ACCEPT,
  usePoLineImport,
  type PoLineImportState,
} from "../../vendor/scm/lib/po-line-import-queries";
import {
  PO_LINE_IMPORT_FIELDS,
  poLineImportSpec,
  type PoLineImportPreview,
} from "../../vendor/scm/lib/po-line-import";

const blank = (v: string | null) => (v === null ? <span className="italic text-ink-muted">blank</span> : v);

const ERROR_BOX =
  "whitespace-pre-line rounded-lg border border-[#B71C1C]/35 bg-[#B71C1C]/[0.07] px-3 py-2 text-[12px] text-[#B71C1C]";

function Count({ label, value, tone }: { label: string; value: number; tone?: "change" | "reject" }) {
  const cls =
    tone === "change" && value > 0
      ? "border-primary/40 bg-primary-soft text-primary-ink"
      : tone === "reject" && value > 0
        ? "border-[#B71C1C]/35 bg-[#B71C1C]/[0.07] text-[#B71C1C]"
        : "border-border bg-surface text-ink";
  return (
    <div className={`rounded-lg border px-3 py-2 ${cls}`}>
      <div className="text-[10px] font-semibold uppercase tracking-wider opacity-80">{label}</div>
      <div className="text-[16px] font-bold tabular-nums">{value.toLocaleString("en-MY")}</div>
    </div>
  );
}

/** The preview body — exported so it renders and tests without the modal chrome. */
export function PoLineImportPreviewView({
  preview,
  ignoredHeaders,
  missingHeaders,
}: {
  preview: PoLineImportPreview;
  ignoredHeaders: string[];
  /** Editable columns the file does not carry — nothing is changed in them. */
  missingHeaders: string[];
}) {
  const [showUnchanged, setShowUnchanged] = useState(false);
  const rows = useMemo(
    () => preview.rows.filter((r) => showUnchanged || r.status !== "unchanged"),
    [preview.rows, showUnchanged]
  );
  const c = preview.counts;

  return (
    <div className="flex flex-col gap-4 text-[13px]">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Count label="Rows read" value={c.rows} />
        <Count label="Lines changing" value={c.changed} tone="change" />
        <Count label="Unchanged" value={c.unchanged} />
        <Count label="Rows refused" value={c.rejected} tone="reject" />
        <Count label="PO dates changing" value={c.poChanges} tone="change" />
        <Count label="PO dates refused" value={c.poRejected} tone="reject" />
      </div>

      {missingHeaders.length > 0 && (
        <p className="text-[12px] text-ink-muted">
          Not in this file, so not changed: {missingHeaders.join(", ")}.
        </p>
      )}

      {ignoredHeaders.length > 0 && (
        <p className="text-[12px] text-ink-muted">
          Ignored columns (an import never changes them): {ignoredHeaders.join(", ")}.
        </p>
      )}

      {(preview.poChanges.length > 0 || preview.poRejections.length > 0) && (
        <section aria-label="Purchase order dates">
          <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
            Estimate delivery dates (whole purchase order)
          </h3>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-left text-[12px]">
              <thead className="bg-surface-dim text-ink-secondary">
                <tr>
                  <th className="px-2.5 py-1.5">Doc No</th>
                  <th className="px-2.5 py-1.5">Field</th>
                  <th className="px-2.5 py-1.5">Old</th>
                  <th className="px-2.5 py-1.5">New</th>
                </tr>
              </thead>
              <tbody>
                {preview.poChanges.map((p) => (
                  <tr key={`${p.poId}-${p.field}`} className="border-t border-border-subtle bg-primary-soft/60" data-status="po-change">
                    <td className="px-2.5 py-1.5 font-semibold">{p.docNo}</td>
                    <td className="px-2.5 py-1.5">
                      {poLineImportSpec(p.field).header}
                      <span className="block text-[11px] text-ink-muted">
                        sets all {Object.keys(p.lineValues).length} lines
                      </span>
                    </td>
                    <td className="px-2.5 py-1.5">{blank(p.old)}</td>
                    <td className="px-2.5 py-1.5 font-semibold text-primary-ink">{blank(p.new)}</td>
                  </tr>
                ))}
                {preview.poRejections.map((p) => (
                  <tr key={`${p.docNo}-${p.field}-rej`} className="border-t border-border-subtle" data-status="po-rejected">
                    <td className="px-2.5 py-1.5 font-semibold">{p.docNo}</td>
                    <td className="px-2.5 py-1.5">{poLineImportSpec(p.field).header}</td>
                    <td colSpan={2} className="px-2.5 py-1.5 text-[#B71C1C]">{p.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section aria-label="Lines">
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <h3 className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">Lines</h3>
          <label className="flex items-center gap-1.5 text-[12px] text-ink-muted">
            <input type="checkbox" checked={showUnchanged} onChange={(e) => setShowUnchanged(e.target.checked)} />
            Show unchanged rows
          </label>
        </div>
        {rows.length === 0 ? (
          <p className="rounded-lg border border-border px-3 py-3 text-ink-muted">
            {c.rows === c.unchanged ? "No line in this file differs from the purchase order." : "Nothing to show."}
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-left text-[12px]">
              <thead className="bg-surface-dim text-ink-secondary">
                <tr>
                  <th className="px-2.5 py-1.5">Row</th>
                  <th className="px-2.5 py-1.5">Doc No</th>
                  <th className="px-2.5 py-1.5">Line</th>
                  <th className="px-2.5 py-1.5">Field</th>
                  <th className="px-2.5 py-1.5">Old</th>
                  <th className="px-2.5 py-1.5">New</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const lead = (span: number) => (
                    <>
                      <td rowSpan={span} className="px-2.5 py-1.5 align-top tabular-nums text-ink-muted">{r.rowNumber}</td>
                      <td rowSpan={span} className="px-2.5 py-1.5 align-top font-semibold">{r.docNo ?? "—"}</td>
                      <td rowSpan={span} className="px-2.5 py-1.5 align-top">{r.itemCode ?? "—"}</td>
                    </>
                  );
                  if (r.status === "rejected") {
                    return (
                      <tr key={r.rowNumber} className="border-t border-border-subtle" data-status="rejected">
                        {lead(1)}
                        <td colSpan={3} className="px-2.5 py-1.5 text-[#B71C1C]">Refused: {r.reason}</td>
                      </tr>
                    );
                  }
                  if (r.status === "unchanged") {
                    return (
                      <tr key={r.rowNumber} className="border-t border-border-subtle text-ink-muted" data-status="unchanged">
                        {lead(1)}
                        <td colSpan={3} className="px-2.5 py-1.5">No change</td>
                      </tr>
                    );
                  }
                  return r.changes.map((ch, i) => (
                    <tr
                      key={`${r.rowNumber}-${ch.field}`}
                      className={`${i === 0 ? "border-t border-border-subtle" : ""} bg-primary-soft/60`}
                      data-status="change"
                    >
                      {i === 0 && lead(r.changes.length)}
                      <td className="px-2.5 py-1.5">{poLineImportSpec(ch.field).header}</td>
                      <td className="px-2.5 py-1.5">{blank(ch.old)}</td>
                      <td className="px-2.5 py-1.5 font-semibold text-primary-ink">{blank(ch.new)}</td>
                    </tr>
                  ));
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function PickStep({ state, onFile }: { state: PoLineImportState; onFile: (f: File) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const reading = state.step === "reading";
  return (
    <div className="flex flex-col gap-4 text-[13px]">
      <p className="text-ink-secondary">
        Import the Purchase Order lines file you exported and edited. Only these columns change anything:{" "}
        <strong className="text-ink">{PO_LINE_IMPORT_FIELDS.map((f) => f.header).join(", ")}</strong>. Quantity,
        price and item are never changed by an import; use an amendment for those.
      </p>
      <p className="text-[12px] text-ink-muted">
        Each row is matched by its Line ID. You will see every change before anything is saved.
      </p>
      <input
        ref={input}
        type="file"
        accept={PO_LINE_IMPORT_ACCEPT}
        className="hidden"
        aria-label="Choose the edited PO lines file"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) onFile(f);
        }}
      />
      <div>
        <Button variant="primary" icon={<FileUp size={14} />} disabled={reading} onClick={() => input.current?.click()}>
          {reading ? `Reading ${state.fileName}…` : "Choose file"}
        </Button>
      </div>
      {state.step === "pick" && state.error && (
        <div role="alert" className={ERROR_BOX}>{state.error}</div>
      )}
    </div>
  );
}

export function PoLineImportModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state, chooseFile, confirm, reset } = usePoLineImport();
  const close = () => {
    if (state.step === "preview" && state.applying) return;
    reset();
    onClose();
  };

  const writes = state.step === "preview" ? state.preview.lineChanges.length + state.preview.poChanges.length : 0;

  let footer;
  if (state.step === "preview") {
    footer = (
      <div className="flex w-full items-center justify-between gap-2">
        <span className="truncate text-[12px] text-ink-muted">{state.fileName}</span>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={reset} disabled={state.applying}>Choose another file</Button>
          <Button variant="primary" onClick={() => void confirm()} disabled={writes === 0 || state.applying}>
            {state.applying ? "Importing…" : writes === 0 ? "Nothing to import" : `Confirm ${writes} ${writes === 1 ? "change" : "changes"}`}
          </Button>
        </div>
      </div>
    );
  } else if (state.step === "done") {
    footer = (
      <div className="flex w-full justify-end">
        <Button variant="primary" onClick={close}>Close</Button>
      </div>
    );
  }

  return (
    <ModalOverlay open={open} onClose={close} title="Import PO lines" icon={<FileUp size={16} />} size="lg" footer={footer}>
      {(state.step === "pick" || state.step === "reading") && <PickStep state={state} onFile={(f) => void chooseFile(f)} />}
      {state.step === "preview" && (
        <div className="flex flex-col gap-3">
          {state.error && (
            <div role="alert" className={ERROR_BOX}>
              {state.error}
              {state.conflicts.length > 0 && (
                <ul className="mt-1.5 list-disc pl-4">
                  {state.conflicts.map((k, i) => (
                    <li key={i}>{k.docNo ? `${k.docNo}: ` : ""}{k.reason}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <PoLineImportPreviewView preview={state.preview} ignoredHeaders={state.ignoredHeaders} missingHeaders={state.missingHeaders} />
        </div>
      )}
      {state.step === "done" && (
        <div className="flex flex-col gap-2 text-[13px]" role="status">
          <p className="font-semibold text-ink">Imported {state.fileName}.</p>
          <ul className="list-disc pl-5 text-ink-secondary">
            <li>{state.result.linesUpdated} {state.result.linesUpdated === 1 ? "line" : "lines"} updated</li>
            <li>{state.result.poLevelChanges} estimate delivery {state.result.poLevelChanges === 1 ? "date" : "dates"} set on the whole purchase order</li>
            <li>{state.result.purchaseOrdersUpdated} purchase {state.result.purchaseOrdersUpdated === 1 ? "order" : "orders"} touched</li>
            <li>{state.result.autocountEditsQueued} queued for AutoCount (one per purchase order whose delivery date or estimate date changed)</li>
          </ul>
          <p className="text-[12px] text-ink-muted">Each change is in the purchase order's History.</p>
        </div>
      )}
    </ModalOverlay>
  );
}
