import { useEffect, useMemo, useRef, useState } from "react";
import { Download, FileUp } from "lucide-react";
import { ModalOverlay } from "../../components/scm-v2/DocumentRelationshipMapModal";
import { Button } from "../../components/Button";
import { useToast } from "../../hooks/useToast";
import { readImportGrid, UNREADABLE_WORKBOOK } from "../../lib/import-sheet";
import { todayMY } from "../../../../shared/src/vendor/shared/format";
import { errText } from "../pos-admin/posAdminUi";
import { IMPORT_COLUMNS, mapImportGrid, type ImportMapping } from "./employeeImport";
import { bulkImportEmployees, useEmployeeOptions } from "./hrApi";

const ACCEPT = ".xlsx,.xls,.csv,text/csv";

type State =
  | { step: "pick"; error: string | null }
  | { step: "reading"; fileName: string }
  | { step: "preview"; fileName: string; mapping: ImportMapping; submitting: boolean }
  | { step: "done"; fileName: string; created: number; updated: number; skippedForProblems: number; failures: { rowNumber: number; message: string }[] };

async function downloadTemplate(): Promise<void> {
  const XLSX = await import("../../lib/xlsx-runtime");
  const headers = IMPORT_COLUMNS.map((c) => c.header);
  const example = [
    "Ahmad bin Ali", "", "ahmad@houzscentury.com", "0121234567", "", "Driver", "2026-01-15",
    "Monthly", "1800", "", "Maybank", "1234567890", "Yes", "Yes", "Yes", "No", "Malaysian", "900101-14-5501", "", "No",
  ];
  const ws = XLSX.utils.aoa_to_sheet([headers, example]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Employees");
  XLSX.writeFileXLSX(wb, "employee-import-template.xlsx");
}

export function ImportEmployeesModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const options = useEmployeeOptions(open);
  const fileInput = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<State>({ step: "pick", error: null });

  useEffect(() => {
    if (open) setState({ step: "pick", error: null });
  }, [open]);

  const departmentsByName = useMemo(
    () => new Map((options.data?.departments ?? []).map((d) => [d.name.trim().toLowerCase(), d.id])),
    [options.data],
  );
  const linkedByEmail = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of options.data?.accounts ?? []) if (a.linkedEmpNo) m.set(a.email.toLowerCase(), a.linkedEmpNo);
    return m;
  }, [options.data]);

  async function chooseFile(file: File) {
    setState({ step: "reading", fileName: file.name });
    try {
      const grid = await readImportGrid(file);
      const mapping = mapImportGrid(grid, departmentsByName, todayMY());
      if (mapping.rows.length === 0) {
        setState({ step: "pick", error: "That file had no data rows under the header. Fill the template and try again." });
        return;
      }
      setState({ step: "preview", fileName: file.name, mapping, submitting: false });
    } catch (e) {
      setState({ step: "pick", error: errText(e, UNREADABLE_WORKBOOK) });
    }
  }

  async function confirm() {
    if (state.step !== "preview") return;
    const valid = state.mapping.rows.filter((r) => r.problem === null);
    if (valid.length === 0) {
      toast.error("No row is ready to import. Fix the rows marked in red.");
      return;
    }
    setState({ ...state, submitting: true });
    try {
      const res = await bulkImportEmployees(valid.map((v) => v.row));
      const failures = res.errors.map((e) => ({ rowNumber: valid[e.index]?.rowNumber ?? e.index + 1, message: e.message }));
      if (res.created.length > 0 || res.updated.length > 0) onDone();
      setState({
        step: "done",
        fileName: state.fileName,
        created: res.created.length,
        updated: res.updated.length,
        skippedForProblems: state.mapping.rows.length - valid.length,
        failures,
      });
    } catch (e) {
      toast.error(errText(e, "Could not import the file."));
      setState({ ...state, submitting: false });
    }
  }

  const ready = state.step === "preview" ? state.mapping.rows.filter((r) => r.problem === null).length : 0;
  const problems = state.step === "preview" ? state.mapping.rows.length - ready : 0;

  let footer;
  if (state.step === "preview") {
    footer = (
      <div className="flex w-full items-center justify-between gap-2">
        <span className="truncate text-[12px] text-ink-muted">{state.fileName}</span>
        <div className="flex items-center gap-2">
          <Button variant="ghost" disabled={state.submitting} onClick={() => setState({ step: "pick", error: null })}>
            Choose another file
          </Button>
          <Button variant="primary" icon={<FileUp size={14} />} disabled={ready === 0 || state.submitting} onClick={() => void confirm()}>
            {state.submitting ? "Importing…" : ready === 0 ? "Nothing to import" : `Import ${ready} ${ready === 1 ? "employee" : "employees"}`}
          </Button>
        </div>
      </div>
    );
  } else if (state.step === "done") {
    footer = (
      <div className="flex w-full justify-end">
        <Button variant="primary" onClick={onClose}>Close</Button>
      </div>
    );
  }

  return (
    <ModalOverlay open={open} onClose={onClose} title="Import employees from a spreadsheet" icon={<FileUp size={16} />} size="lg" footer={footer}>
      {(state.step === "pick" || state.step === "reading") && (
        <div className="flex flex-col gap-4 text-[13px]">
          <p className="text-ink-secondary">
            Download the template, fill one row per person, then upload it. Only <strong className="text-ink">Name</strong> is required; leave Employee No blank
            and it is numbered for you. Put the person’s ERP account email in <strong className="text-ink">ERP Account Email</strong> to link it so they can punch
            in. A row that matches someone already here — same ERP account, or same Employee No — updates that person with the cells you filled instead of adding
            a duplicate; salary is never changed. Money is in RM. You will see every row before anything is saved.
          </p>
          <input
            ref={fileInput}
            type="file"
            accept={ACCEPT}
            className="hidden"
            aria-label="Choose the filled template"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void chooseFile(f);
            }}
          />
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" icon={<Download size={14} />} onClick={() => void downloadTemplate()}>
              Download template (.xlsx)
            </Button>
            <Button
              variant="primary"
              icon={<FileUp size={14} />}
              disabled={state.step === "reading"}
              onClick={() => fileInput.current?.click()}
            >
              {state.step === "reading" ? `Reading ${state.fileName}…` : "Upload filled file"}
            </Button>
          </div>
          {state.step === "pick" && state.error && (
            <div role="alert" className="whitespace-pre-line rounded-lg border border-rose-500/35 bg-rose-50 px-3 py-2 text-rose-800 dark:bg-rose-950/40 dark:text-rose-300">
              {state.error}
            </div>
          )}
        </div>
      )}

      {state.step === "preview" && (
        <div className="flex flex-col gap-3 text-[13px]">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-md border border-emerald-500/40 bg-emerald-50 px-2 py-1 text-[12px] font-semibold text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
              {ready} ready
            </span>
            {problems > 0 && (
              <span className="rounded-md border border-rose-500/40 bg-rose-50 px-2 py-1 text-[12px] font-semibold text-rose-800 dark:bg-rose-950/40 dark:text-rose-300">
                {problems} to fix
              </span>
            )}
          </div>
          {state.mapping.ignoredHeaders.length > 0 && (
            <p className="text-[12px] text-ink-muted">Ignored columns: {state.mapping.ignoredHeaders.join(", ")}.</p>
          )}
          <div className="max-h-[52vh] overflow-auto rounded-lg border border-border">
            <table className="w-full text-left text-[12px]">
              <thead className="sticky top-0 bg-surface-dim text-ink-secondary">
                <tr>
                  <th className="px-2.5 py-1.5">Row</th>
                  <th className="px-2.5 py-1.5">Emp No</th>
                  <th className="px-2.5 py-1.5">Name</th>
                  <th className="px-2.5 py-1.5">ERP account</th>
                  <th className="px-2.5 py-1.5">Pay</th>
                  <th className="px-2.5 py-1.5">Status</th>
                </tr>
              </thead>
              <tbody>
                {state.mapping.rows.map((r) => {
                  const existingEmpNo = r.row.accountEmail ? linkedByEmail.get(r.row.accountEmail.toLowerCase()) : undefined;
                  const willUpdate = !r.problem && existingEmpNo != null;
                  return (
                  <tr
                    key={r.rowNumber}
                    className={`border-t border-border-subtle ${r.problem ? "bg-rose-50/70 dark:bg-rose-950/20" : ""}`}
                    data-status={r.problem ? "problem" : willUpdate ? "update" : "ready"}
                  >
                    <td className="px-2.5 py-1.5 tabular-nums text-ink-muted">{r.rowNumber}</td>
                    <td className="px-2.5 py-1.5 font-mono">{willUpdate ? existingEmpNo : r.display.empNo}</td>
                    <td className="px-2.5 py-1.5">{r.display.name}</td>
                    <td className="px-2.5 py-1.5">{r.display.link ? r.display.account : <span className="text-ink-muted">not linked</span>}</td>
                    <td className="px-2.5 py-1.5">{willUpdate ? <span className="text-ink-muted">unchanged</span> : r.display.pay}</td>
                    <td className="px-2.5 py-1.5">
                      {r.problem ? (
                        <span className="text-rose-700 dark:text-rose-300">{r.problem}</span>
                      ) : willUpdate ? (
                        <span className="text-sky-700 dark:text-sky-300">Will update</span>
                      ) : (
                        <span className="text-emerald-700 dark:text-emerald-300">New</span>
                      )}
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {problems > 0 && (
            <p className="text-[12px] text-ink-muted">Rows marked to fix are left out; only the ready rows are imported.</p>
          )}
        </div>
      )}

      {state.step === "done" && (
        <div className="flex flex-col gap-2 text-[13px]" role="status">
          <p className="font-semibold text-ink">
            {state.fileName}: added {state.created} new {state.created === 1 ? "employee" : "employees"}, updated {state.updated} existing.
          </p>
          {state.skippedForProblems > 0 && (
            <p className="text-ink-secondary">{state.skippedForProblems} row{state.skippedForProblems === 1 ? "" : "s"} were left out for the reasons shown in the preview.</p>
          )}
          {state.failures.length > 0 && (
            <div className="rounded-lg border border-rose-500/35 bg-rose-50 px-3 py-2 text-rose-800 dark:bg-rose-950/40 dark:text-rose-300">
              <p className="font-semibold">{state.failures.length} row{state.failures.length === 1 ? "" : "s"} could not be saved:</p>
              <ul className="mt-1 list-disc pl-5">
                {state.failures.map((f) => (
                  <li key={f.rowNumber}>Row {f.rowNumber}: {f.message}</li>
                ))}
              </ul>
            </div>
          )}
          <p className="text-[12px] text-ink-muted">Set each person’s salary and statutory by clicking their row.</p>
        </div>
      )}
    </ModalOverlay>
  );
}
