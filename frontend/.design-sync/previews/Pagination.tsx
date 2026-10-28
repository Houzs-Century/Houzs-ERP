import { useState } from "react";
import { Pagination } from "autocount-sync-frontend";

// List-footer pager — range readout, optional per-page selector,
// chevron prev/next. Stacks on phones, single row from sm: up.

export const Default = () => {
  const [page, setPage] = useState(3);
  return (
    <div className="w-[28rem]">
      <Pagination page={page} perPage={25} total={412} onPageChange={setPage} />
    </div>
  );
};

export const WithPerPageSelector = () => {
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(50);
  return (
    <div className="w-[30rem]">
      <Pagination
        page={page}
        perPage={perPage}
        total={1873}
        onPageChange={setPage}
        onPerPageChange={setPerPage}
      />
    </div>
  );
};

export const LastPage = () => (
  <div className="w-[28rem]">
    <Pagination page={17} perPage={25} total={412} onPageChange={() => {}} />
  </div>
);

export const NoResults = () => (
  <div className="w-[28rem]">
    <Pagination page={1} perPage={25} total={0} onPageChange={() => {}} />
  </div>
);

export const InContext = () => {
  const [page, setPage] = useState(2);
  return (
    <div className="w-[30rem] rounded-lg border border-border bg-surface p-4 shadow-stone">
      <div className="flex items-center justify-between border-b border-border-subtle pb-3 text-[13px]">
        <span className="font-semibold text-ink">Delivery Orders</span>
        <span className="font-mono text-[11px] text-ink-secondary">DO-01801 – DO-01842</span>
      </div>
      <Pagination page={page} perPage={25} total={1042} onPageChange={setPage} onPerPageChange={() => {}} />
    </div>
  );
};
