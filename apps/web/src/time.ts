/** Display/input policy only. Never offset stored candle or event timestamps. */
export const DISPLAY_TIME_ZONE = 'Asia/Shanghai';
export const TIME_ZONE_LABEL = '北京时间 UTC+8';
const formatter = new Intl.DateTimeFormat('zh-CN', {timeZone:DISPLAY_TIME_ZONE, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23'});
export function beijingTime(value: unknown, milliseconds = false): string {
  if (value === null || value === undefined || value === '') return '不可用';
  const date = value instanceof Date ? value : new Date(typeof value === 'number' ? value : /^\d+$/.test(String(value)) ? Number(value) : String(value));
  if (!Number.isFinite(date.getTime())) return '不可用';
  const p = Object.fromEntries(formatter.formatToParts(date).map(part=>[part.type,part.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}${milliseconds ? '.'+String(date.getUTCMilliseconds()).padStart(3,'0') : ''}`;
}
/** datetime-local is a Beijing wall-clock time, irrespective of the browser's TZ. */
export function beijingInputToIso(value: string): string | undefined {
  if (!value) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(value)) throw new Error('请输入有效的北京时间');
  const date = new Date(value+'+08:00');
  if (!Number.isFinite(date.getTime()) || beijingTime(date).slice(0,16).replace(' ','T') !== value.slice(0,16)) throw new Error('请输入有效的北京时间');
  return date.toISOString();
}
