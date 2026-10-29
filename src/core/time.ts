import type { DisplayTimeZone } from './market';

const cache = new Map<string, Intl.DateTimeFormat>();

function fmt(tz: string, withDate: boolean, withSeconds: boolean): Intl.DateTimeFormat {
  const key = `${tz}|${withDate}|${withSeconds}`;
  let f = cache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hourCycle: 'h23',
      ...(withDate ? { year: 'numeric', month: '2-digit', day: '2-digit' } : {}),
      hour: '2-digit',
      minute: '2-digit',
      ...(withSeconds ? { second: '2-digit' } : {}),
    });
    cache.set(key, f);
  }
  return f;
}

export const TZ_LABEL: Record<DisplayTimeZone, string> = {
  'Asia/Bangkok': 'เวลาไทย (ICT)',
  'America/New_York': 'เวลานิวยอร์ก (ET)',
};

export function formatTs(ms: number | null | undefined, tz: DisplayTimeZone, opts: { seconds?: boolean } = {}): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '-';
  return fmt(tz, true, !!opts.seconds).format(new Date(ms)).replace(',', '');
}

export function formatTime(ms: number, tz: DisplayTimeZone): string {
  return fmt(tz, false, false).format(new Date(ms));
}

/** แท่งรายวัน: แสดงวันที่ตามที่เก็บ (ไม่แปลง tz) */
export function formatDailyTs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} วินาที`;
  if (s < 3600) return `${Math.round(s / 60)} นาที`;
  return `${(s / 3600).toFixed(1)} ชม.`;
}
