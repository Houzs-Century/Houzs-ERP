import { Fragment, type ReactNode } from "react";
import { cn } from "../lib/utils";
import { dataCellStyle, type CellPlacement } from "./DataTableRowCells";
import type { Column, DataTableChildRow, DataTableProps } from "./dataTableTypes";

const CHILD_STICKY_BG = "var(--hz-c-surface)";
const BORDER = "border-b border-border-subtle";

interface ExpandedRowsProps<T> extends CellPlacement {
  row: T;
  expandable: NonNullable<DataTableProps<T>["expandable"]>;
  rowClassName: string | undefined;
  columns: Column<T>[];
  totalColSpan: number;
  hasSelectionCell: boolean;
  stickyRightCount: number;
  cellPad: string;
  fillerAt: number;
  fillerCount: number;
}

export function DataTableExpandedRows<T>(props: ExpandedRowsProps<T>) {
  const { row, expandable, rowClassName, totalColSpan } = props;
  if (expandable.childRows) {
    return (
      <>
        {expandable.childRows(row).map((child) => (
          <ChildRow key={child.key} child={child} {...props} />
        ))}
      </>
    );
  }
  return (
    <tr className={cn("bg-surface-dim/20", rowClassName)}>
      <td colSpan={totalColSpan} className={cn(BORDER, "px-5 py-3 text-[13px] text-ink")}>
        {expandable.render?.(row)}
      </td>
    </tr>
  );
}

function ChildRow<T>({ child, ...props }: ExpandedRowsProps<T> & { child: DataTableChildRow }) {
  const { columns, rowClassName, totalColSpan, hasSelectionCell, cellPad } = props;
  if (child.caption != null) {
    return (
      <tr className={cn("bg-surface-dim/20", rowClassName, child.className)}>
        <td colSpan={totalColSpan} className={cn(BORDER, "px-5 py-1")}>{child.caption}</td>
      </tr>
    );
  }
  return (
    <tr className={cn("bg-surface-dim/20", rowClassName, child.className)}>
      {hasSelectionCell && <td className={BORDER} />}
      <td
        style={{ width: 32, minWidth: 32, maxWidth: 32 }}
        className={cn(BORDER, "align-middle text-ink", hasSelectionCell ? "pl-3" : "pl-5", cellPad)}
      >
        {child.lead}
      </td>
      {columns.map((column, index) => (
        <Fragment key={column.key}>
          {index === props.fillerAt && props.fillerCount > 0 && <td aria-hidden className={cn(BORDER, "p-0")} />}
          <ChildCell column={column} index={index} content={child.cells[column.key]} {...props} />
        </Fragment>
      ))}
      {props.fillerAt === columns.length && props.fillerCount > 0 && <td aria-hidden className={cn(BORDER, "p-0")} />}
    </tr>
  );
}

function ChildCell<T>({ column, index, content, ...props }: ExpandedRowsProps<T> & {
  column: Column<T>;
  index: number;
  content: ReactNode;
}) {
  const isLastSticky = index === props.stickyCount - 1;
  const isFirstStickyRight =
    props.stickyRight[index] !== undefined && index === props.columns.length - props.stickyRightCount;
  return (
    <td
      data-col-key={column.key}
      style={dataCellStyle(column, index, props, CHILD_STICKY_BG)}
      className={cn(
        BORDER,
        "overflow-hidden whitespace-normal break-words align-middle text-[13px] text-ink",
        props.cellPad,
        column.align === "right" && "text-right",
        column.align === "center" && "text-center",
        index === props.columns.length - 1 && "pr-5",
        isLastSticky && "border-r border-border",
        isFirstStickyRight && "border-l border-border",
        column.className,
      )}
    >
      {content}
    </td>
  );
}
