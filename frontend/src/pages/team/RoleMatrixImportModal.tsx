// Import an edited role-matrix workbook back (RBAC rebuild, Option A — PR3).
//
// Pick a file → parse it LOCALLY into a preview (every role's added / removed /
// unchanged, plus every ignored column, unknown key and unreadable cell) →
// Apply, which runs the two PR2 write APIs per changed role:
//   PATCH /api/roles/:id/page-access  { entries }   (full replace-set)
//   PATCH /api/roles/:id              { permissions} (full array)
// Nothing is written before Apply. The diff + payloads are built by the pure,
// unit-tested lib/roleMatrixExcel; this file only reads the file and presents
// the result. Shared by the desktop Matrix tab and the mobile Roles list — one
// product, one logic layer.

import { useCallback, useState } from "react";
import { FileUp } from "lucide-react";
import { api } from "../../api/client";
import { Button } from "../../components/Button";
import { ModalOverlay } from "../../components/scm-v2/DocumentRelationshipMapModal";
import { readMatrixSheets, UNREADABLE_MATRIX_FILE } from "../../lib/roleMatrixExcelFile";
import {
  parseMatrixWorkbook,
  sensitiveKeysOf,
  ROLE_MATRIX_IMPORT_ACCEPT,
  type ParsedImport,
  type RoleImportResult,
  type MatrixSnapshot,
} from "../../lib/roleMatrixExcel";
import { MATRIX_LEVEL_LABEL } from "../../lib/roleMatrixModel";

type Failure = { role: string; message: string };

export type RoleMatrixImportState =
  | { step: "pick"; error: string | null }
  | { step: "reading"; fileName: string }
  | { step: "preview"; fileName: string; parsed: ParsedImport; applying: boolean; error: string | null; progress: number }
  | { step: "done"; fileName: string; applied: number; failures: Failure[] };

const errorMessage = (e: unknown): string =>
  (e instanceof Error && e.message) || "Something went wrong. Please try again.";

/** The import state machine. `onApplied` reloads the matrix data after a write. */
export function useRoleMatrixImport(onApplied: () => void) {
  const [state, setState] = useState<RoleMatrixImportState>({ step: "pick", error: null });

  const reset = useCallback(() => setState({ step: "pick", error: null }), []);

  const chooseFile = useCallback(async (file: File, snap: MatrixSnapshot) => {
    setState({ step: "reading", fileName: file.name });
    let sheets;
    try {
      sheets = await readMatrixSheets(file);
    } catch {
      setState({ step: "pick", error: UNREADABLE_MATRIX_FILE });
      return;
    }
    const parsed = parseMatrixWorkbook(sheets, snap);
    if (parsed.empty) {
      setState({
        step: "pick",
        error:
          "No role columns or permission/page keys were found in this file. Export the matrix first, edit that file, and import it back.",
      });
      return;
    }
    setState({ step: "preview", fileName: file.name, parsed, applying: false, error: null, progress: 0 });
  }, []);

  // `state` comes from the render scope (confirm is recreated each render), so it
  // is always the live preview — no stale-closure read.
  const confirm = useCallback(async () => {
    if (state.step !== "preview" || state.applying) return;
    const { fileName, parsed } = state;
    setState({ ...state, applying: true, error: null, progress: 0 });

    const changed = parsed.changedRoles;
    const failures: Failure[] = [];
    let applied = 0;
    for (let i = 0; i < changed.length; i++) {
      const r = changed[i]!;
      try {
        if (r.pagesChanged) {
          await api.patch(`/api/roles/${r.roleId}/page-access`, { entries: r.pagePayload });
        }
        if (r.permsChanged) {
          await api.patch(`/api/roles/${r.roleId}`, { permissions: r.permsPayload });
        }
        applied++;
      } catch (e) {
        failures.push({ role: r.roleName, message: errorMessage(e) });
      }
      setState((s) => (s.step === "preview" ? { ...s, progress: i + 1 } : s));
    }
    onApplied();
    setState({ step: "done", fileName, applied, failures });
  }, [state, onApplied]);

  return { state, chooseFile, confirm, reset };
}

// ── Presentation ───────────────────────────────────────────────────────────

const ERROR_BOX =
  "whitespace-pre-line rounded-lg border border-err/35 bg-err/[0.07] px-3 py-2 text-[12px] text-err";

function Count({ label, value, tone }: { label: string; value: number; tone?: "add" | "remove" }) {
  const cls =
    tone === "add" && value > 0
      ? "border-primary/40 bg-primary-soft text-primary-ink"
      : tone === "remove" && value > 0
        ? "border-err/35 bg-err/[0.07] text-err"
        : "border-border bg-surface text-ink";
  return (
    <div className={`rounded-lg border px-3 py-2 ${cls}`}>
      <div className="text-[10px] font-semibold uppercase tracking-wider opacity-80">{label}</div>
      <div className="text-[16px] font-bold tabular-nums">{value.toLocaleString("en-MY")}</div>
    </div>
  );
}

function RoleRow({ r }: { r: RoleImportResult }) {
  const [open, setOpen] = useState(false);
  const sensitive = sensitiveKeysOf(r);
  const expandable = r.functionsAdded.length + r.functionsRemoved.length + r.pageChanges.length > 0;
  return (
    <div className="border-t border-border-subtle first:border-t-0" data-role={r.roleName}>
      <button
        type="button"
        disabled={!expandable}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 px-3 py-2 text-left"
      >
        <span className="flex-1 truncate text-[13px] font-semibold text-ink">{r.roleName}</span>
        {sensitive.length > 0 && (
          <span className="rounded bg-warning-bg px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-wider text-warning-text">
            {sensitive.length} sensitive
          </span>
        )}
        <span className="font-mono text-[11px] tabular-nums text-primary">+{r.addedCount}</span>
        <span className="font-mono text-[11px] tabular-nums text-err">−{r.removedCount}</span>
      </button>
      {open && expandable && (
        <div className="space-y-1.5 bg-surface-2/40 px-3 pb-2.5 pt-1 text-[11.5px]">
          {r.pageChanges.map((c) => (
            <div key={c.pageKey} className="flex items-center gap-2">
              <span className="text-ink-secondary">{c.label}</span>
              <span className="font-mono text-[10px] text-ink-muted">{c.pageKey}</span>
              <span className="ml-auto font-mono text-ink-muted">
                {MATRIX_LEVEL_LABEL[c.from]} → <span className="text-ink">{MATRIX_LEVEL_LABEL[c.to]}</span>
              </span>
            </div>
          ))}
          {r.functionsAdded.map((k) => (
            <div key={`a-${k}`} className="flex items-center gap-2">
              <span className="text-primary">授予 grant</span>
              <span className="font-mono text-[10px] text-ink-secondary">{k}</span>
            </div>
          ))}
          {r.functionsRemoved.map((k) => (
            <div key={`r-${k}`} className="flex items-center gap-2">
              <span className="text-err">收回 remove</span>
              <span className="font-mono text-[10px] text-ink-secondary">{k}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Notices({ parsed }: { parsed: ParsedImport }) {
  const notes: Array<{ tone: "warn" | "info"; text: string }> = [];
  if (parsed.lockedWithEdits.length > 0)
    notes.push({ tone: "warn", text: `锁定角色不会被修改 (System / 全权限): ${parsed.lockedWithEdits.join(", ")}.` });
  if (parsed.ambiguousColumns.length > 0)
    notes.push({ tone: "warn", text: `重名角色列已跳过 (请用「ID · 名称」表头): ${parsed.ambiguousColumns.join(", ")}.` });
  if (parsed.ignoredColumns.length > 0)
    notes.push({ tone: "info", text: `无法对应的角色列已忽略: ${parsed.ignoredColumns.join(", ")}.` });
  if (parsed.unknownKeys.length > 0)
    notes.push({ tone: "info", text: `本版本没有的 key 已跳过: ${parsed.unknownKeys.join(", ")}.` });
  if (parsed.badCells.length > 0)
    notes.push({
      tone: "warn",
      text: `${parsed.badCells.length} 个无法识别的格子已跳过 (例: ${parsed.badCells
        .slice(0, 3)
        .map((b) => `${b.sheet}!${b.cell}="${b.value}"`)
        .join(", ")}).`,
    });
  if (notes.length === 0) return null;
  return (
    <div className="space-y-1.5">
      {notes.map((n, i) => (
        <p
          key={i}
          className={
            n.tone === "warn"
              ? "mb-0 rounded-lg border border-warning-text/30 bg-warning-bg px-3 py-2 text-[12px] text-ink-secondary"
              : "mb-0 text-[12px] text-ink-muted"
          }
        >
          {n.text}
        </p>
      ))}
    </div>
  );
}

export function RoleMatrixImportPreview({ parsed }: { parsed: ParsedImport }) {
  const [showUnchanged, setShowUnchanged] = useState(false);
  const rows = showUnchanged
    ? parsed.roleResults
    : parsed.roleResults.filter((r) => r.permsChanged || r.pagesChanged);
  const unchanged = parsed.roleResults.length - parsed.changedRoles.length;
  return (
    <div className="flex flex-col gap-4 text-[13px]">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Count label="角色改动 Roles changing" value={parsed.changedRoles.length} tone="add" />
        <Count label="授予 Added" value={parsed.totalAdded} tone="add" />
        <Count label="收回 Removed" value={parsed.totalRemoved} tone="remove" />
        <Count label="不变 Unchanged" value={unchanged} />
      </div>

      <Notices parsed={parsed} />

      <section aria-label="Per-role changes">
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <h3 className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">角色 · 改动明细</h3>
          <label className="flex items-center gap-1.5 text-[12px] text-ink-muted">
            <input type="checkbox" checked={showUnchanged} onChange={(e) => setShowUnchanged(e.target.checked)} />
            显示未改动角色
          </label>
        </div>
        {rows.length === 0 ? (
          <p className="rounded-lg border border-border px-3 py-3 text-ink-muted">
            这个文件没有任何改动 — 所有角色与现状一致。
          </p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            {rows.map((r) => (
              <RoleRow key={r.roleId} r={r} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

export function RoleMatrixImportModal({
  open,
  onClose,
  snapshot,
  onApplied,
}: {
  open: boolean;
  onClose: () => void;
  snapshot: MatrixSnapshot;
  onApplied: () => void;
}) {
  const { state, chooseFile, confirm, reset } = useRoleMatrixImport(onApplied);

  const close = () => {
    if (state.step === "preview" && state.applying) return;
    reset();
    onClose();
  };

  let footer;
  if (state.step === "preview") {
    const n = state.parsed.changedRoles.length;
    footer = (
      <div className="flex w-full items-center justify-between gap-2">
        <span className="truncate text-[12px] text-ink-muted">{state.fileName}</span>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={reset} disabled={state.applying}>
            换文件
          </Button>
          <Button variant="brass" onClick={() => void confirm()} disabled={n === 0 || state.applying}>
            {state.applying
              ? `应用中… ${state.progress}/${n}`
              : n === 0
                ? "没有要应用的改动"
                : `应用 ${n} 个角色的改动`}
          </Button>
        </div>
      </div>
    );
  } else if (state.step === "done") {
    footer = (
      <div className="flex w-full justify-end">
        <Button variant="primary" onClick={close}>
          完成
        </Button>
      </div>
    );
  }

  return (
    <ModalOverlay open={open} onClose={close} title="导入角色权限 Excel" icon={<FileUp size={16} />} size="lg" footer={footer}>
      {(state.step === "pick" || state.step === "reading") && (
        <PickStep state={state} onFile={(f) => void chooseFile(f, snapshot)} />
      )}
      {state.step === "preview" && (
        <div className="flex flex-col gap-3">
          {state.error && (
            <div role="alert" className={ERROR_BOX}>
              {state.error}
            </div>
          )}
          <RoleMatrixImportPreview parsed={state.parsed} />
        </div>
      )}
      {state.step === "done" && (
        <div className="flex flex-col gap-2 text-[13px]" role="status">
          <p className="font-semibold text-ink">已导入 {state.fileName}。</p>
          <p className="text-ink-secondary">
            {state.applied} 个角色已更新。成员在下次请求时看到新权限。
          </p>
          {state.failures.length > 0 && (
            <div className={ERROR_BOX}>
              {state.failures.length} 个角色没有保存成功:
              <ul className="mt-1 list-disc pl-4">
                {state.failures.map((f, i) => (
                  <li key={i}>
                    {f.role}: {f.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </ModalOverlay>
  );
}

function PickStep({
  state,
  onFile,
}: {
  state: RoleMatrixImportState;
  onFile: (f: File) => void;
}) {
  const reading = state.step === "reading";
  return (
    <div className="flex flex-col gap-4 text-[13px]">
      <p className="text-ink-secondary">
        导入你编辑过的「角色权限矩阵」文件 (先用「导出 Excel」生成，改好再导入)。
        <strong className="text-ink"> ✓ </strong> = 授予功能，<strong className="text-ink"> − </strong> = 收回；
        页面格子填 <strong className="text-ink">无 / 看 / 改 / 批</strong>。留空 = 不改动。
      </p>
      <p className="text-[12px] text-ink-muted">
        应用前你会看到每个角色的「授予 / 收回 / 不变」，确认后才写入。系统角色与全权限角色不会被修改。
      </p>
      <label className="w-max">
        <input
          type="file"
          accept={ROLE_MATRIX_IMPORT_ACCEPT}
          className="hidden"
          aria-label="选择角色权限文件"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) onFile(f);
          }}
        />
        <span
          className={`inline-flex cursor-pointer items-center gap-2 rounded-md bg-primary px-3 py-2 text-[13px] font-semibold text-white ${
            reading ? "pointer-events-none opacity-60" : ""
          }`}
        >
          <FileUp size={14} />
          {reading ? `读取 ${state.fileName}…` : "选择文件"}
        </span>
      </label>
      {state.step === "pick" && state.error && (
        <div role="alert" className={ERROR_BOX}>
          {state.error}
        </div>
      )}
    </div>
  );
}
