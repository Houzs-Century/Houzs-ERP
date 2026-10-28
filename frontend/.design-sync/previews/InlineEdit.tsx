import { InlineEdit } from "autocount-sync-frontend";

// Label + input that saves on commit — the standard editable field on
// detail pages (service cases, SO/DO detail asides).

const save = async (_v: string | null) => {};

export const TextField = () => (
  <div className="w-72">
    <InlineEdit label="Customer PIC" value="Farra Aziz" onSave={save} placeholder="Name…" />
  </div>
);

export const DateAndNumber = () => (
  <div className="w-72 space-y-3">
    <InlineEdit label="Expected delivery" type="date" value="2026-07-18" onSave={save} />
    <InlineEdit label="Quantity" type="number" value={12} onSave={save} />
  </div>
);

export const SelectField = () => (
  <div className="w-72">
    <InlineEdit
      label="Resolution method"
      value="Replace Unit"
      options={["Replace Unit", "Supplier Repair (Workshop)", "Field Service (Our Team)", "Return Visit"]}
      onSave={save}
    />
  </div>
);

export const TextArea = () => (
  <div className="w-72">
    <InlineEdit
      label="Internal remarks"
      textarea
      value="Drain pipe blocked; quote sent 07/07, waiting for customer confirmation."
      onSave={save}
    />
  </div>
);
