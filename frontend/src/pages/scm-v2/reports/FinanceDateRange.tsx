
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
