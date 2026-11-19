// 时区与当地时间工具：运营记录为 UTC 时刻（Z 结尾），
// 班车窗口、柜台时段、迁场切换均按机场当地时间解释。

const formatters = new Map();

function formatter(tz) {
  let fmt = formatters.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    formatters.set(tz, fmt);
  }
  return fmt;
}

// UTC 时刻 -> 指定时区的当地墙钟 { day, hhmm, minutes }
export function toLocal(utcIso, tz) {
  const date = new Date(utcIso);
  if (Number.isNaN(date.getTime())) throw new Error(`无法解析时刻: ${utcIso}`);
  const parts = {};
  for (const part of formatter(tz).formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    hhmm: `${parts.hour}:${parts.minute}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

export function parseHHMM(value) {
  const [h, m] = String(value).split(':').map(Number);
  return h * 60 + m;
}

// 某瞬间在指定时区的偏移（分钟，当地 = UTC + offset）
export function offsetMinutesAt(date, tz) {
  const local = toLocal(date.toISOString(), tz);
  const localAsUtc = Date.parse(`${local.day}T${local.hhmm}:00Z`);
  return Math.round((localAsUtc - date.getTime()) / 60000);
}

export function offsetStringAt(date, tz) {
  const offset = offsetMinutesAt(date, tz);
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

// 当地墙钟（day + HH:MM）-> UTC 毫秒。固定偏移时区两次迭代即收敛。
export function localToUtc(day, hhmm, tz) {
  const naive = Date.parse(`${day}T${hhmm}:00Z`);
  let utc = naive;
  for (let i = 0; i < 3; i += 1) {
    const candidate = naive - offsetMinutesAt(new Date(utc), tz) * 60000;
    if (candidate === utc) break;
    utc = candidate;
  }
  return utc;
}

// 判断 UTC 时刻是否落在某当地日期的 [first, last] 窗口内。
// 末班时刻含该分钟；窗口跨午夜（last < first）时顺延到次日。
export function windowContainsUtc(day, first, last, tz, utcIso) {
  const t = new Date(utcIso).getTime();
  const start = localToUtc(day, first, tz);
  let end = localToUtc(day, last, tz) + 59999;
  if (end < start) end += 86400000;
  return t >= start && t <= end;
}

// 展示用：UTC 时刻 -> 带偏移的当地 ISO 文本
export function localIso(utcIso, tz) {
  const local = toLocal(utcIso, tz);
  return `${local.day}T${local.hhmm}:00${offsetStringAt(new Date(utcIso), tz)}`;
}
