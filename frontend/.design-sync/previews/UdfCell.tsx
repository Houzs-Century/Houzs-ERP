import type { ReactNode } from "react";
import { UdfCell } from "autocount-sync-frontend";

// Inline editor for a user-defined-field table cell. DataTable mounts one
// per UDF column; the input type follows the field definition (text /
// number / date / select / checkbox). Saves on blur / change via onSave.
// UDFs live in worker D1 and are never synced to AutoCount.

const noSave = async () => {};

const field = (
  key: string,
  label: string,
  type: "text" | "number" | "date" | "select" | "checkbox",
  options: string[] | null = null
) => ({ id: 1, key, label, type, options, position: 0 });

// Mimic the table-cell context each editor actually sits in.
const Cell = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="w-60 rounded-md border border-border bg-surface px-3 py-2 shadow-stone">
    <div className="mb-1 text-[10px] font-bold uppercase tracking-brand text-ink-muted">
      {label}
    </div>
    {children}
  </div>
);

export const TextField = () => (
  <Cell label="Serial No">
    <UdfCell
      field={field("serial_no", "Serial No", "text")}
      value="PNA-25HP-88231"
      onSave={noSave}
    />
  </Cell>
);

export const SelectField = () => (
  <Cell label="Warranty Status">
    <UdfCell
      field={field("warranty_status", "Warranty Status", "select", [
        "Under Warranty",
        "Extended",
        "Expired",
      ])}
      value="Under Warranty"
      onSave={noSave}
    />
  </Cell>
);

export const NumberAndDate = () => (
  <div className="flex gap-3">
    <Cell label="Install Crew Size">
      <UdfCell
        field={field("install_crew_size", "Install Crew Size", "number")}
        value="3"
        onSave={noSave}
      />
    </Cell>
    <Cell label="Warranty Until">
      <UdfCell
        field={field("warranty_until", "Warranty Until", "date")}
        value="2027-06-30"
        onSave={noSave}
      />
    </Cell>
  </div>
);

export const CheckboxField = () => (
  <div className="flex gap-3">
    <Cell label="AutoCount Verified">
      <UdfCell
        field={field("ac_verified", "AutoCount Verified", "checkbox")}
        value="1"
        onSave={noSave}
      />
    </Cell>
    <Cell label="Needs Crane">
      <UdfCell
        field={field("needs_crane", "Needs Crane", "checkbox")}
        value=""
        onSave={noSave}
      />
    </Cell>
  </div>
);

export const EmptyValue = () => (
  <Cell label="Remark (unset)">
    <UdfCell
      field={field("remark", "Remark", "text")}
      value={null}
      onSave={noSave}
    />
  </Cell>
);
