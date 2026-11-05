# AI Usage

IT-only page (`/ai-usage`) showing what the Anthropic API costs each month, by feature and by company. Same gate as System Health: `it.view` on the server (`requireItPages`), `it.pages.view` capability on the client.

## What is recorded

- One row in `public.ai_usage_events` per Anthropic call: feature, company, user, model, input / output / cache-read / cache-write tokens, ok, error, HTTP status.
- Each call site wraps its fetch: `await recordAi(tag, fetch(...))` (`services/aiUsage.ts`). Only the fetch is wrapped, so one call is one row even when the caller's own catch also handles parse errors. The body is read from a clone, so the caller's read is untouched. Recording never throws into the caller; a failed insert is a `[ai-usage]` console warning.
- The row is written through the invocation's own `env.DB`, not `getDb`: a fresh client per call would leave a socket open per row, and an agent run or weekly distill records many calls in one invocation.
- A call site that retries (`anthropicFetchWithRetry`) records only the final response.
- Feature names: `scan_so`, `scan_so_distill`, `cache_warm`, `scan_payment`, `scan_lorry_invoice`, `scan_gr`, `scan_pi`, `bill_extract`, `credit_note_extract`, `schedule_reconcile`, `setup_invoice_extract`, `floorplan_size`, `announcement_translate`, `assistant`, `agent:<family>` (lowercase, from `agentFeature()`).
- A new Anthropic call must pass an `AiUsageTag`. Agent and assistant calls go through `agent-brain.ts`, whose options require `aiUsage`.

## Cost

- Prices live in `AI_PRICES_USD_PER_MTOK` in `services/aiUsage.ts`. Update it when a call site changes model; an unknown model is priced as Sonnet 4.6.
- USD to RM uses `USD_TO_MYR_EST` from `services/agent-console.ts`, so the page and the Agent Console agree.
- Months are Malaysian calendar months, like the Agent Console budget.

## Report

- `GET /api/admin/ai-usage?months=6` (1 to 24). Per month: total RM, per feature (calls, failures, tokens, RM), per company (RM).
- Months before the first recorded event come from `agent_runs` tokens only and are `partial` with a note. From the first recorded month on, only `ai_usage_events` is used, so the two sources never add up in one month. The first recorded month itself is also `partial` (calls before recording started are missing).
- This is an IT-wide report across companies by design.
- Daily 02:00 UTC the last 7 UTC days go to the IT Hub (`services/aiUsageHub.ts`, `POST /api/v1/sys/ai-usage`): per day x company code x feature, priced with `costUsd`. The hub uses them only as shares of Anthropic's real cost. Needs secrets `IT_HUB_URL`, `IT_HUB_AI_USAGE_COMPANY` (e.g. `HOUZS`) and that company's `IT_HUB_API_KEY_<code>`; any unset => not sent.

## Gotchas

- Cache writes are priced at the 5-minute rate. `scan_so`, `cache_warm`, `scan_gr` and `scan_pi` use the 1-hour cache, which Anthropic bills at twice input, so their cost reads low.
- The table has no RLS (the prod Hyperdrive role is not named in the repo); `anon` and `authenticated` are revoked instead.
- Back-filled agent months have no failures or cache figures: `agent_runs` never stored them.
- The Anthropic invoice is the final figure; this page is an estimate.
