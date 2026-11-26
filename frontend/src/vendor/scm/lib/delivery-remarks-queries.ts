import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';

export type DeliveryRemark = {
  id: string;
  soDocNo: string;
  body: string;
  authorName: string | null;
  createdAt: string;
};

/** The thread for one order, oldest first. Disabled until an order is open. */
export function useDeliveryRemarks(soDocNo: string | null) {
  return useQuery({
    queryKey: ['delivery-remarks', soDocNo ?? ''],
    queryFn: () => authedFetch<{ remarks: DeliveryRemark[] }>(
      `/delivery-remarks?soDocNo=${encodeURIComponent(soDocNo ?? '')}`,
    ).then((r) => r.remarks),
    enabled: !!soDocNo,
    staleTime: 15_000,
  });
}

/** Every order that has >=1 remark, with its count — drives the board REMARK pill. */
export function useRemarkFlags(enabled = true) {
  return useQuery({
    queryKey: ['delivery-remark-flags'],
    queryFn: () => authedFetch<{ flags: Array<{ soDocNo: string; count: number }> }>(
      `/delivery-remarks/flags`,
    ).then((r) => r.flags),
    enabled,
    staleTime: 30_000,
  });
}

export function useAddRemark() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ soDocNo, body }: { soDocNo: string; body: string }) =>
      authedFetch<{ remark: DeliveryRemark }>(`/delivery-remarks`, {
        method: 'POST', body: JSON.stringify({ soDocNo, body }),
      }),
    onSuccess: (_r, v) => {
      void qc.invalidateQueries({ queryKey: ['delivery-remarks', v.soDocNo] });
      void qc.invalidateQueries({ queryKey: ['delivery-remark-flags'] });
    },
  });
}
