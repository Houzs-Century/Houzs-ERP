// FinanceDateRange — the reports' shared date-range picker (batch 6 §4.1): the
// redesign's DateRangeButton (batch 5) with the reports' presets, bound to the
// range in the address (useReportRange). One picker, presets from the one
// home (lib/dateRangePresets REPORT_RANGE_PRESETS).

import { DateRangeButton } from '../../../components/DateRangeButton';
import { REPORT_RANGE_PRESETS } from '../../../lib/dateRangePresets';
import { useReportRange } from './useReportRange';

export function FinanceDateRange({ label = 'Report dates' }: { label?: string }) {
  const r = useReportRange();
  return (
    <DateRangeButton
      from={r.from}
      to={r.to}
      onChange={r.setRange}
      presets={REPORT_RANGE_PRESETS}
      today={r.today}
      label={label}
    />
  );
}
