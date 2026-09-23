// TradingView supplies calendar Dates already adjusted to the widget timezone.
// Read UTC fields here: applying Asia/Shanghai again would add another eight hours.
const weekdays = ['周日','周一','周二','周三','周四','周五','周六'];
const valid = (date: Date) => Number.isFinite(date.getTime());
export const chartDate = (date: Date) => valid(date)
  ? `${weekdays[date.getUTCDay()]} ${date.getUTCMonth()+1}/${date.getUTCDate()}` : '—';
export const chartClock = (date: Date) => valid(date)
  ? `${String(date.getUTCHours()).padStart(2,'0')}:${String(date.getUTCMinutes()).padStart(2,'0')}` : '—';
export const chartTimeLabel = (date: Date) => valid(date) ? `${chartDate(date)} ${chartClock(date)}` : '—';
export const chartTimeFormatters = {
  dateFormatter: {
    format: chartDate,
    formatLocal: chartDate,
    // Keep explicit years in date-entry dialogs; never invent a year from M/D.
    parse: (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : '',
  },
  timeFormatter: { format: chartClock, formatLocal: chartClock },
  tickMarkFormatter: chartTimeLabel,
};
