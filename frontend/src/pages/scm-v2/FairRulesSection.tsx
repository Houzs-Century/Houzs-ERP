// ----------------------------------------------------------------------------
// FairRulesSection — SO Maintenance › Fair rules (owner 2026-10-19).
//
// "Venue differs": the place written on a scanned slip is not where the order
// was placed (the scan fell back to the scanner's fair today / latest one).
// The owner wants it a FLAG for now — 「这个过后可能我会让他对不上 project 就不能
// 存哦」 — so this is the switch that turns it into a refusal at Confirm, kept
// for the owner and Finance. The backend enforces who may flip it and writes
// every flip to the audit ledger; this page only mirrors the rule so nobody is
// shown a control that would be refused.
// ----------------------------------------------------------------------------

import { useAuth as useHouzsAuth } from '../../auth/AuthContext';
import { fmtDateTime } from '../../vendor/shared/format';
import { useSetSoSetting, useSoSettings, VENUE_DIFFERS_BLOCKS_KEY } from '../../vendor/scm/lib/so-settings-queries';

export const FairRulesSection = () => {
  const { can } = useHouzsAuth();
  const canChange = can('scm.finance.accounting');
  const settings = useSoSettings();
  const setSetting = useSetSoSetting();
  const row = (settings.data ?? []).find((s) => s.key === VENUE_DIFFERS_BLOCKS_KEY);
  const blocks = row?.enabled === true;
  const disabled = !canChange || settings.isLoading || settings.isError || setSetting.isPending;
  const pick = (enabled: boolean) => { if (enabled !== blocks) setSetting.mutate({ key: VENUE_DIFFERS_BLOCKS_KEY, enabled }); };

  return (
    <div className="flex flex-col gap-3 text-[12.5px] leading-relaxed text-ink-secondary">
      <div>
        <div className="text-[13px] font-semibold text-ink">“Venue differs” on a scanned order</div>
        <div>The place written on the slip is not where the order was placed.</div>
      </div>
      {settings.isError && (
        <div role="alert" className="rounded-lg border border-err/40 bg-err-bg px-4 py-2.5">
          <strong className="font-semibold text-ink">Couldn&apos;t load the fair rules.</strong>{' '}
          {settings.error instanceof Error ? settings.error.message : 'Please try again.'}
        </div>
      )}
      <fieldset className="flex flex-col gap-2" aria-label="Venue differs">
        <label className="flex items-start gap-2">
          <input type="radio" name="venue-differs" checked={!blocks} disabled={disabled} onChange={() => pick(false)} className="mt-1" />
          <span><strong className="font-semibold text-ink">Flag only</strong> (default) — the order can be confirmed, and Finance / PMS check it.</span>
        </label>
        <label className="flex items-start gap-2">
          <input type="radio" name="venue-differs" checked={blocks} disabled={disabled} onChange={() => pick(true)} className="mt-1" />
          <span><strong className="font-semibold text-ink">Stop Confirm</strong> — the draft cannot be confirmed until the fair the slip was written at is picked, or the venue is corrected.</span>
        </label>
      </fieldset>
      {!canChange && <div>Only the owner or Finance can change this.</div>}
      {row?.updated_at && <div className="text-[11px]">Last changed {fmtDateTime(row.updated_at)}</div>}
    </div>
  );
};
