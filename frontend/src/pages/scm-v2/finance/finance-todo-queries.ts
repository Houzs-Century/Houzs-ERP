// ----------------------------------------------------------------------------
// finance-todo-queries — the Finance To do page (owner's Claude Design project
// "Finance 模块重新设计", Finance-1a-To-do, 2026-11-02 —「帮我读这个和做」).
// Every rule lives on the server (backend acc/finance-todo.ts); this is
// transport only.
// ----------------------------------------------------------------------------

import { useQuery } from '@tanstack/react-query';
import { authedFetch } from '../../../vendor/scm/lib/authed-fetch';
import { retryUnlessClientError } from '../../../lib/retryPolicy';

/** The built-in rules that raise a job (the design's RULES table). */
export type TodoRule =
  | 'card-missing' | 'card-matched' | 'card-choose'
  | 'bank-missing' | 'bank-decide'
  | 'requests' | 'pv-check' | 'pv-approve'
  | 'transfers' | 'selfcheck' | 'overdue';

/** The four piles the page groups jobs into. */
export type TodoGroup = 'recon' | 'pay' | 'other' | 'misc';

/** Which tile colour a job wears. */
export type TodoTone = 'cards' | 'bank' | 'out' | 'money' | 'err' | 'routine' | 'manual';

/** The lucide icon a job shows — the server names it, the page draws it. */
export type TodoIcon =
  | 'upload' | 'credit-card' | 'landmark' | 'send' | 'wallet' | 'receipt'
  | 'alert-triangle' | 'calendar-days' | 'pen-line' | 'file-text' | 'hand-coins';

export type TodoJob = {
  key: string;
  rule: TodoRule;
  group: TodoGroup;
  /** Inside "Merchant reports & bank statements": which sub-head it sits under. */
  sub: 'merchant' | 'bank' | null;
  tone: TodoTone;
  icon: TodoIcon;
  title: string;
  detail: string;
  amountSen: number | null;
  /** The day the oldest thing in it began waiting (YYYY-MM-DD). */
  since: string | null;
  action: { label: string; to: string; primary: boolean };
  /** Waiting on others only: who it waits for. */
  who: string | null;
};

export type TodoDone = { key: string; text: string; je: string | null; at: string };

export type TodoCheck = { key: string; label: string; value: string; state: 'ok' | 'open' | 'late'; to: string | null };

export type FinanceTodo = {
  today: string;
  mine: TodoJob[];
  others: TodoJob[];
  done: TodoDone[];
  /** Null when the viewer may not see the bank balances. */
  money: { bankCashSen: number; awaitingSen: number; onTheWaySen: number } | null;
  checklist: { month: string; daysLeft: number; items: TodoCheck[] };
  /** Reads that failed, by what they were for — said on the page, never shown as zero. */
  problems: string[];
};

export const FINANCE_TODO_KEY = ['finance-todo'] as const;
export const FINANCE_TODO_PATH = '/accounting/todo';

export function useFinanceTodo() {
  return useQuery({
    queryKey: FINANCE_TODO_KEY,
    queryFn: () => authedFetch<FinanceTodo>(FINANCE_TODO_PATH),
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    retry: retryUnlessClientError,
  });
}
