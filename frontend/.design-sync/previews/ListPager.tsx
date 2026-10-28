import { useState } from "react";
import { ListPager } from "autocount-sync-frontend";

// 0-based server-pagination footer (#1201) — replaced the ten hand-rolled
// PaginationFooter copies across the SCM lists. Visual twin of Pagination
// (which stays 1-based on the non-SCM pages): "1–50 of 795 · SHOW 50 PER
// PAGE · ‹ 1/16 ›", left-aligned so it clears the floating action buttons.

export const FirstPage = () => {
  const [page, setPage] = useState(0);
  const [size, setSize] = useState(50);
  return (
    <div className="w-[560px]">
      <ListPager
        page={page}
        pageSize={size}
        total={795}
        onPageChange={setPage}
        onPageSizeChange={(n) => {
          setSize(n);
          setPage(0);
        }}
      />
    </div>
  );
};

export const MidRange = () => {
  const [page, setPage] = useState(7);
  return (
    <div className="w-[560px]">
      <ListPager page={page} pageSize={50} total={795} onPageChange={setPage} onPageSizeChange={() => {}} />
    </div>
  );
};

export const NoSelector = () => {
  const [page, setPage] = useState(2);
  return (
    <div className="w-[420px]">
      <ListPager page={page} pageSize={25} total={68} onPageChange={setPage} />
    </div>
  );
};

export const EmptyResult = () => (
  <div className="w-[560px]">
    <ListPager page={0} pageSize={50} total={0} onPageChange={() => {}} onPageSizeChange={() => {}} />
  </div>
);
