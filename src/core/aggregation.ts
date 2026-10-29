/**
 * การรวมแท่ง, การกรอง session และนโยบายข้อมูลซ้ำ/ผิดลำดับ/แก้ไขย้อนหลัง
 *
 * นโยบาย (ใช้ทั้งข้อมูลสด, backfill และ CSV):
 *  - key ของแท่ง = เวลาเริ่มแท่ง (UTC ms)
 *  - ซ้ำและค่าเหมือนเดิม → ไม่ทำอะไร (duplicate)
 *  - ซ้ำแต่ค่าต่าง → ข้อมูลใหม่ชนะ (correction) เช่น updatedBars ของ Alpaca หรือ backfill หลัง reconnect
 *  - เวลาเก่ากว่าแท่งล่าสุดที่มีอยู่ → แทรกตามลำดับเวลา (late) แต่ไม่ย้อนสร้างสัญญาณที่ยืนยันไปแล้ว
 *  - แท่งที่ค่าไม่ถูกต้อง (NaN, ราคา <= 0, high < low) → ทิ้ง (invalid)
 */
import { dailyBarTs, isInSession, nyDateKey, sessionWindow } from './market';
import type { Bar, SessionMode, Timeframe } from './types';

export interface MergeStats {
  added: number;
  duplicates: number;
  corrections: number;
  late: number;
  invalid: number;
}

export const emptyStats = (): MergeStats => ({ added: 0, duplicates: 0, corrections: 0, late: 0, invalid: 0 });

export function isValidBar(b: Bar): boolean {
  const nums = [b.t, b.o, b.h, b.l, b.c, b.v];
  if (nums.some((n) => typeof n !== 'number' || !Number.isFinite(n))) return false;
  if (b.o <= 0 || b.h <= 0 || b.l <= 0 || b.c <= 0 || b.v < 0) return false;
  return b.h >= b.l && b.h >= Math.max(b.o, b.c) - 1e-9 && b.l <= Math.min(b.o, b.c) + 1e-9;
}

const sameBar = (a: Bar, b: Bar) => a.o === b.o && a.h === b.h && a.l === b.l && a.c === b.c && a.v === b.v;

/** รวม incoming เข้ากับ existing (เรียงตามเวลา) ตามนโยบายด้านบน — คืนอาร์เรย์ใหม่ที่เรียงและไม่ซ้ำ */
export function mergeBars(existing: Bar[], incoming: Bar[]): { bars: Bar[]; stats: MergeStats } {
  const stats = emptyStats();
  const map = new Map<number, Bar>();
  for (const b of existing) map.set(b.t, b);
  const lastExisting = existing.length ? existing[existing.length - 1].t : -Infinity;
  for (const b of incoming) {
    if (!isValidBar(b)) {
      stats.invalid++;
      continue;
    }
    const prev = map.get(b.t);
    if (prev) {
      if (sameBar(prev, b)) stats.duplicates++;
      else {
        stats.corrections++;
        map.set(b.t, { ...b });
      }
      continue;
    }
    if (b.t < lastExisting) stats.late++;
    else stats.added++;
    map.set(b.t, { ...b });
  }
  return { bars: [...map.values()].sort((a, b) => a.t - b.t), stats };
}

/** เรียงและลบซ้ำ (ตัวหลังชนะ) */
export function normalizeBars(bars: Bar[]): { bars: Bar[]; stats: MergeStats } {
  return mergeBars([], bars);
}

export function filterSession(bars: Bar[], mode: SessionMode): Bar[] {
  return bars.filter((b) => isInSession(b.t, mode));
}

function combine(group: Bar[], t: number): Bar {
  let h = -Infinity;
  let l = Infinity;
  let v = 0;
  for (const b of group) {
    h = Math.max(h, b.h);
    l = Math.min(l, b.l);
    v += b.v;
  }
  return { t, o: group[0].o, h, l, c: group[group.length - 1].c, v };
}

/**
 * รวมแท่งนาที → แท่ง N นาที โดยจัด bucket ตามเวลา UTC
 * (09:30 ET และ 04:00 ET ลงตัวกับ 5 นาทีเสมอเพราะ offset เป็นหลักชั่วโมง)
 * นาทีที่ไม่มีการซื้อขาย (ไม่มีแท่ง) จะไม่ถูกเติม — bucket ใช้เฉพาะแท่งที่มี
 */
export function aggregateMinutes(minuteBars: Bar[], minutes: number): Bar[] {
  const size = minutes * 60_000;
  const out: Bar[] = [];
  let group: Bar[] = [];
  let bucket = NaN;
  for (const b of minuteBars) {
    const k = Math.floor(b.t / size) * size;
    if (k !== bucket && group.length) {
      out.push(combine(group, bucket));
      group = [];
    }
    bucket = k;
    group.push(b);
  }
  if (group.length) out.push(combine(group, bucket));
  return out;
}

/** รวมแท่งนาที → แท่งรายวันตามวันที่นิวยอร์ก (ควรกรอง session ก่อน) */
export function aggregateDaily(minuteBars: Bar[]): Bar[] {
  const out: Bar[] = [];
  let group: Bar[] = [];
  let key = '';
  for (const b of minuteBars) {
    const k = nyDateKey(b.t);
    if (k !== key && group.length) {
      out.push(combine(group, dailyBarTs(key)));
      group = [];
    }
    key = k;
    group.push(b);
  }
  if (group.length) out.push(combine(group, dailyBarTs(key)));
  return out;
}

/** แท่งของ timeframe จากข้อมูลพื้นฐาน (1Min กรอง session แล้วรวม; 1Day ใช้ตามที่มี) */
export function barsForTimeframe(base: Bar[], tf: Timeframe, session: SessionMode): Bar[] {
  if (tf === '1Day') return base;
  const filtered = filterSession(base, session);
  return tf === '5Min' ? aggregateMinutes(filtered, 5) : filtered;
}

/**
 * แท่งที่ t ปิดแล้วหรือยัง ณ เวลา now
 * - นาที/5 นาที: เวลาสิ้นสุดแท่ง + grace <= now (grace รอให้แท่งนาทีสุดท้ายของ bucket มาถึง)
 *   หรือสิ้นสุด session แล้ว (bucket สุดท้ายของวันอาจสั้นกว่าปกติไม่ได้ เพราะ 16:00 ลงตัว)
 * - รายวัน: หลังเวลาปิด session ของวันนั้น + grace
 */
export function isBarClosed(t: number, tf: Timeframe, now: number, session: SessionMode, graceMs: number): boolean {
  if (tf === '1Day') {
    const k = nyDateKey(t + 12 * 3_600_000); // t = 00:00 UTC ของวันที่ → ชดเชยให้อยู่ในวันเดียวกันตามเวลา NY
    const w = sessionWindow(k, session);
    if (!w) return true;
    return now >= w.close + graceMs;
  }
  const size = tf === '5Min' ? 300_000 : 60_000;
  return now >= t + size + graceMs;
}

/** สร้างแท่งนาทีที่กำลังก่อตัวจาก trade */
export class MinuteBarBuilder {
  private bars = new Map<string, Bar>();

  onTrade(symbol: string, price: number, size: number, ts: number): Bar {
    const t = Math.floor(ts / 60_000) * 60_000;
    const cur = this.bars.get(symbol);
    if (!cur || t > cur.t) {
      const b = { t, o: price, h: price, l: price, c: price, v: size };
      this.bars.set(symbol, b);
      return b;
    }
    if (t < cur.t) return cur; // trade มาช้ากว่าแท่งที่กำลังก่อตัว → ไม่แก้แท่ง forming (แท่งนาทีทางการจะแก้ให้)
    cur.h = Math.max(cur.h, price);
    cur.l = Math.min(cur.l, price);
    cur.c = price;
    cur.v += size;
    return cur;
  }

  get(symbol: string): Bar | undefined {
    return this.bars.get(symbol);
  }

  /** เมื่อได้รับแท่งนาทีทางการแล้ว ให้ทิ้งแท่ง forming ที่เก่ากว่า/เท่ากัน */
  confirm(symbol: string, minuteTs: number): void {
    const cur = this.bars.get(symbol);
    if (cur && cur.t <= minuteTs) this.bars.delete(symbol);
  }
}

/** หาช่วงเวลาที่ขาดหายใน session (เกิน maxGapMs) — ใช้รายงาน/ตัดสินใจ backfill */
export function findGaps(bars: Bar[], maxGapMs: number, session: SessionMode): { from: number; to: number }[] {
  const gaps: { from: number; to: number }[] = [];
  for (let i = 1; i < bars.length; i++) {
    const a = bars[i - 1].t;
    const b = bars[i].t;
    if (b - a > maxGapMs && nyDateKey(a) === nyDateKey(b) && isInSession(a, session) && isInSession(b, session)) {
      gaps.push({ from: a, to: b });
    }
  }
  return gaps;
}
