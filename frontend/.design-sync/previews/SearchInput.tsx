import { useState } from "react";
import { SearchInput, Badge } from "autocount-sync-frontend";

// Controlled search box used above every list page (orders, deliveries,
// service cases). Fixed 18rem width, petrol focus ring.

export const Empty = () => {
  const [q, setQ] = useState("");
  return <SearchInput value={q} onChange={setQ} placeholder="Search sales orders…" />;
};

export const WithValue = () => {
  const [q, setQ] = useState("Farra Aziz");
  return <SearchInput value={q} onChange={setQ} placeholder="Search customers…" />;
};

export const CustomPlaceholder = () => {
  const [q, setQ] = useState("");
  return <SearchInput value={q} onChange={setQ} placeholder="DO number, customer, technician…" />;
};

export const InContext = () => {
  const [q, setQ] = useState("ASSR-02");
  return (
    <div className="flex w-[28rem] items-center justify-between gap-3 rounded-lg border border-border bg-surface p-3 shadow-stone">
      <SearchInput value={q} onChange={setQ} placeholder="Search service cases…" />
      <Badge tone="neutral" caseless>3 matches</Badge>
    </div>
  );
};
