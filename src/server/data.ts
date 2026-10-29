/** อ่านแท่งจาก SQLite ตาม timeframe โดยใช้ session เดียวกันทั้งกราฟ กลยุทธ์ และ backtest */
import { barsForTimeframe, isBarClosed } from '@/core/aggregation';
import type { Bar, SessionMode, Timeframe } from '@/core/types';
import type { Store } from './db';

const DAY = 86_400_000;

export interface LoadOptions {
  /** ย้อนหลังกี่วันปฏิทินจากแท่งล่าสุด */
  days?: number;
  from?: number;
  to?: number;
}

export function loadBars(store: Store, dataset: string, symbol: string, tf: Timeframe, session: SessionMode, o: LoadOptions = {}): Bar[] {
  const base = tf === '1Day' ? '1Day' : '1Min';
  let from = o.from;
  if (from === undefined && o.days !== undefined) {
    const last = store.lastBarTs(dataset, symbol, base);
    if (last === null) return [];
    from = last - o.days * DAY;
  }
  // 5 นาที: เริ่มที่ขอบ bucket เพื่อไม่ให้ bucket แรกขาดนาที
  if (from !== undefined && tf === '5Min') from = Math.floor(from / 300_000) * 300_000;
  return barsForTimeframe(store.getBars(dataset, symbol, base, { from, to: o.to }), tf, session);
}

/** แยกแท่งที่ปิดแล้วกับแท่งสุดท้ายที่อาจยังก่อตัว */
export function splitClosed(bars: Bar[], tf: Timeframe, now: number, session: SessionMode, graceMs: number): { closed: Bar[]; forming: Bar | null } {
  if (!bars.length) return { closed: [], forming: null };
  const last = bars[bars.length - 1];
  if (isBarClosed(last.t, tf, now, session, graceMs)) return { closed: bars, forming: null };
  return { closed: bars.slice(0, -1), forming: last };
}

export function graceFor(tf: Timeframe, cfg: { closeGraceSec: number; dailyCloseGraceMin: number }): number {
  return tf === '1Day' ? cfg.dailyCloseGraceMin * 60_000 : cfg.closeGraceSec * 1000;
}
