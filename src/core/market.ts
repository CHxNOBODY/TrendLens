import type { SessionMode } from './types';

export const NY_TZ = 'America/New_York';
export const BKK_TZ = 'Asia/Bangkok';
export type DisplayTimeZone = typeof NY_TZ | typeof BKK_TZ;

/**
 * ปฏิทินวันหยุด NYSE แบบคงที่ (ปิดทั้งวัน) — ต้องปรับปรุงเมื่อเลยปี 2027
 * แหล่งอ้างอิง: ประกาศวันหยุดของ NYSE
 */
const NYSE_HOLIDAYS = new Set<string>([
  // 2024
  '2024-01-01', '2024-01-15', '2024-02-19', '2024-03-29', '2024-05-27', '2024-06-19',
  '2024-07-04', '2024-09-02', '2024-11-28', '2024-12-25',
  // 2025 (รวม 9 ม.ค. วันไว้อาลัยอดีตประธานาธิบดี Carter)
  '2025-01-01', '2025-01-09', '2025-01-20', '2025-02-17', '2025-04-18', '2025-05-26',
  '2025-06-19', '2025-07-04', '2025-09-01', '2025-11-27', '2025-12-25',
  // 2026
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19',
  '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  // 2027
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18',
  '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
]);

/** วันปิดเร็ว (regular session ปิด 13:00 ET) */
const NYSE_EARLY_CLOSES = new Set<string>([
  '2024-07-03', '2024-11-29', '2024-12-24',
  '2025-07-03', '2025-11-28', '2025-12-24',
  '2026-11-27', '2026-12-24',
  '2027-11-26',
]);

export interface ZonedParts {
  y: number;
  m: number; // 1-12
  d: number;
  hh: number;
  mm: number;
  ss: number;
  weekday: number; // 0 = อาทิตย์
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function zonedParts(ms: number, tz: string): ZonedParts {
  const parts = formatter(tz).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '0';
  return {
    y: Number(get('year')),
    m: Number(get('month')),
    d: Number(get('day')),
    hh: Number(get('hour')),
    mm: Number(get('minute')),
    ss: Number(get('second')),
    weekday: WEEKDAYS[get('weekday')] ?? 0,
  };
}

/** แปลงเวลาตามนาฬิกาท้องถิ่นของ tz เป็น UTC ms (รองรับ DST) */
export function zonedTimeToUtc(y: number, m: number, d: number, hh: number, mm: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let ts = guess;
  for (let k = 0; k < 2; k++) {
    const p = zonedParts(ts, tz);
    const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss);
    ts += guess - asUtc;
  }
  return ts;
}

const pad = (n: number) => String(n).padStart(2, '0');

export function dateKey(y: number, m: number, d: number): string {
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** วันที่ (YYYY-MM-DD) ตามเวลานิวยอร์กของ timestamp */
export function nyDateKey(ms: number): string {
  const p = zonedParts(ms, NY_TZ);
  return dateKey(p.y, p.m, p.d);
}

/** timestamp ของแท่งรายวัน = Date.UTC ของวันที่ซื้อขาย */
export function dailyBarTs(dateKeyStr: string): number {
  const [y, m, d] = dateKeyStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

export function dateKeyFromDailyTs(ts: number): string {
  const dt = new Date(ts);
  return dateKey(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

export function addDays(key: string, n: number): string {
  return dateKeyFromDailyTs(dailyBarTs(key) + n * 86_400_000);
}

export function isTradingDay(key: string): boolean {
  const dow = new Date(dailyBarTs(key)).getUTCDay();
  if (dow === 0 || dow === 6) return false;
  return !NYSE_HOLIDAYS.has(key);
}

export function isEarlyClose(key: string): boolean {
  return NYSE_EARLY_CLOSES.has(key);
}

export function nextTradingDay(key: string): string {
  let k = addDays(key, 1);
  while (!isTradingDay(k)) k = addDays(k, 1);
  return k;
}

export function prevTradingDay(key: string): string {
  let k = addDays(key, -1);
  while (!isTradingDay(k)) k = addDays(k, -1);
  return k;
}

export interface SessionWindow {
  dateKey: string;
  open: number; // UTC ms
  close: number; // UTC ms (exclusive)
}

/**
 * ช่วงเวลาซื้อขายของวัน
 * - regular: 09:30–16:00 ET (วันปิดเร็ว 13:00)
 * - extended: 04:00–20:00 ET (วันปิดเร็ว 17:00)
 */
export function sessionWindow(key: string, mode: SessionMode): SessionWindow | null {
  if (!isTradingDay(key)) return null;
  const [y, m, d] = key.split('-').map(Number);
  const early = isEarlyClose(key);
  if (mode === 'regular') {
    return {
      dateKey: key,
      open: zonedTimeToUtc(y, m, d, 9, 30, NY_TZ),
      close: zonedTimeToUtc(y, m, d, early ? 13 : 16, 0, NY_TZ),
    };
  }
  return {
    dateKey: key,
    open: zonedTimeToUtc(y, m, d, 4, 0, NY_TZ),
    close: zonedTimeToUtc(y, m, d, early ? 17 : 20, 0, NY_TZ),
  };
}

/** แท่งนาทีที่เริ่ม ณ ts อยู่ใน session หรือไม่ */
export function isInSession(ts: number, mode: SessionMode): boolean {
  const w = sessionWindow(nyDateKey(ts), mode);
  return !!w && ts >= w.open && ts < w.close;
}

export type MarketState = 'open' | 'pre' | 'post' | 'closed';

export interface MarketStatus {
  state: MarketState;
  label: string;
  dateKey: string;
  nextOpen: number;
  regularClose: number | null;
}

/** สถานะตลาดตาม regular session (pre/post = นอกเวลาปกติของวันทำการ) */
export function marketStatus(now: number): MarketStatus {
  const key = nyDateKey(now);
  const reg = sessionWindow(key, 'regular');
  const ext = sessionWindow(key, 'extended');
  const nextOpenAfter = (k: string) => sessionWindow(nextTradingDay(k), 'regular')!.open;
  if (!reg || !ext) {
    return { state: 'closed', label: 'ตลาดปิด (วันหยุด/เสาร์-อาทิตย์)', dateKey: key, nextOpen: nextOpenAfter(key), regularClose: null };
  }
  if (now >= reg.open && now < reg.close) {
    return { state: 'open', label: 'ตลาดเปิด (regular session)', dateKey: key, nextOpen: reg.open, regularClose: reg.close };
  }
  if (now < reg.open) {
    return {
      state: now >= ext.open ? 'pre' : 'closed',
      label: now >= ext.open ? 'ก่อนตลาดเปิด (pre-market)' : 'ตลาดปิด',
      dateKey: key,
      nextOpen: reg.open,
      regularClose: reg.close,
    };
  }
  return {
    state: now < ext.close ? 'post' : 'closed',
    label: now < ext.close ? 'หลังตลาดปิด (after-hours)' : 'ตลาดปิด',
    dateKey: key,
    nextOpen: nextOpenAfter(key),
    regularClose: reg.close,
  };
}
