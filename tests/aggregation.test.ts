import { describe, expect, it } from 'vitest';
import {
  MinuteBarBuilder,
  aggregateDaily,
  aggregateMinutes,
  filterSession,
  findGaps,
  isBarClosed,
  mergeBars,
} from '@/core/aggregation';
import { dailyBarTs, isInSession, marketStatus, nextTradingDay, sessionWindow } from '@/core/market';
import { parseCsv } from '@/core/csv';
import { bar } from './helpers';

const OPEN = Date.UTC(2026, 9, 1, 13, 30); // 2026-10-01 09:30 EDT
const M = 60_000;

describe('aggregateMinutes', () => {
  it('รวม 1 นาที → 5 นาที ตามขอบเวลา 09:30, 09:35', () => {
    const mins = Array.from({ length: 10 }, (_, i) => bar(OPEN + i * M, 100 + i, 101 + i, 99 + i, 100.5 + i, 10));
    const five = aggregateMinutes(mins, 5);
    expect(five).toHaveLength(2);
    expect(five[0]).toEqual({ t: OPEN, o: 100, h: 105, l: 99, c: 104.5, v: 50 });
    expect(five[1].t).toBe(OPEN + 5 * M);
    expect(five[1].o).toBe(105);
  });
  it('นาทีที่หายไปไม่ทำให้ขอบเวลาเพี้ยน', () => {
    const mins = [bar(OPEN, 1, 2, 1, 2), bar(OPEN + 4 * M, 2, 3, 2, 3), bar(OPEN + 6 * M, 3, 4, 3, 4)];
    const five = aggregateMinutes(mins, 5);
    expect(five.map((b) => b.t)).toEqual([OPEN, OPEN + 5 * M]);
    expect(five[0].c).toBe(3);
  });
});

describe('session filtering & boundaries', () => {
  it('regular session รวม 09:30–15:59 ไม่รวม 09:29 และ 16:00', () => {
    expect(isInSession(OPEN - M, 'regular')).toBe(false);
    expect(isInSession(OPEN, 'regular')).toBe(true);
    expect(isInSession(OPEN + 389 * M, 'regular')).toBe(true);
    expect(isInSession(OPEN + 390 * M, 'regular')).toBe(false);
    expect(isInSession(OPEN - M, 'extended')).toBe(true);
    const bars = [bar(OPEN - M, 1, 1, 1, 1), bar(OPEN, 1, 1, 1, 1), bar(OPEN + 390 * M, 1, 1, 1, 1)];
    expect(filterSession(bars, 'regular')).toHaveLength(1);
  });
  it('รองรับ DST: ธันวาคมเปิด 14:30 UTC, วันหยุดไม่มี session, วันปิดเร็ว 13:00 ET', () => {
    expect(sessionWindow('2026-12-01', 'regular')!.open).toBe(Date.UTC(2026, 11, 1, 14, 30));
    expect(sessionWindow('2026-11-26', 'regular')).toBeNull();
    expect(sessionWindow('2026-11-27', 'regular')!.close).toBe(Date.UTC(2026, 10, 27, 18, 0));
    expect(nextTradingDay('2026-11-25')).toBe('2026-11-27');
  });
  it('สถานะตลาด: เปิด / pre-market / ปิดสุดสัปดาห์', () => {
    expect(marketStatus(OPEN + 10 * M).state).toBe('open');
    expect(marketStatus(OPEN - 60 * M).state).toBe('pre');
    expect(marketStatus(Date.UTC(2026, 9, 3, 15)).state).toBe('closed'); // เสาร์
  });
  it('รวมรายวันตามวันที่นิวยอร์ก (แท่ง 23:59 UTC ยังเป็นวันเดียวกันใน ET)', () => {
    const d = aggregateDaily([bar(OPEN, 10, 11, 9, 10), bar(Date.UTC(2026, 9, 1, 19, 59), 10, 12, 10, 12)]);
    expect(d).toEqual([{ t: dailyBarTs('2026-10-01'), o: 10, h: 12, l: 9, c: 12, v: 200 }]);
  });
});

describe('isBarClosed', () => {
  it('แท่ง 5 นาทีปิดเมื่อพ้นเวลาสิ้นสุด + grace เท่านั้น', () => {
    expect(isBarClosed(OPEN, '5Min', OPEN + 5 * M, 'regular', 15_000)).toBe(false);
    expect(isBarClosed(OPEN, '5Min', OPEN + 5 * M + 15_000, 'regular', 15_000)).toBe(true);
  });
  it('แท่งรายวันปิดหลังเวลาปิด session + grace', () => {
    const t = dailyBarTs('2026-10-01');
    const close = sessionWindow('2026-10-01', 'regular')!.close;
    expect(isBarClosed(t, '1Day', close - 1, 'regular', 0)).toBe(false);
    expect(isBarClosed(t, '1Day', close, 'regular', 0)).toBe(true);
  });
});

describe('mergeBars: ข้อมูลซ้ำ ผิดลำดับ และแก้ไขย้อนหลัง', () => {
  const base = [bar(OPEN, 1, 2, 1, 2), bar(OPEN + M, 2, 3, 2, 3), bar(OPEN + 3 * M, 3, 4, 3, 4)];
  it('ซ้ำค่าเดิม → ไม่เปลี่ยน', () => {
    const r = mergeBars(base, [bar(OPEN + M, 2, 3, 2, 3)]);
    expect(r.stats.duplicates).toBe(1);
    expect(r.bars).toEqual(base);
  });
  it('ซ้ำค่าต่าง → ค่าใหม่แทนที่ (correction)', () => {
    const r = mergeBars(base, [bar(OPEN + M, 2, 3.5, 2, 3.4)]);
    expect(r.stats.corrections).toBe(1);
    expect(r.bars[1].c).toBe(3.4);
  });
  it('มาผิดลำดับ → แทรกตามเวลา (late)', () => {
    const r = mergeBars(base, [bar(OPEN + 2 * M, 3, 3, 3, 3)]);
    expect(r.stats.late).toBe(1);
    expect(r.bars.map((b) => b.t)).toEqual([OPEN, OPEN + M, OPEN + 2 * M, OPEN + 3 * M]);
  });
  it('ข้อมูลผิดรูปแบบถูกทิ้ง', () => {
    const r = mergeBars(base, [bar(OPEN + 4 * M, 3, 1, 2, 3), { ...bar(OPEN + 5 * M, 1, 1, 1, 1), c: NaN }]);
    expect(r.stats.invalid).toBe(2);
    expect(r.bars).toHaveLength(3);
  });
  it('ตรวจหาช่วงข้อมูลขาดภายใน session', () => {
    expect(findGaps(base, 90_000, 'regular')).toEqual([{ from: OPEN + M, to: OPEN + 3 * M }]);
  });
});

describe('MinuteBarBuilder', () => {
  it('สร้างแท่ง forming จาก trade และไม่ให้ trade เก่าทับแท่งใหม่', () => {
    const b = new MinuteBarBuilder();
    b.onTrade('AAPL', 10, 1, OPEN + 1000);
    b.onTrade('AAPL', 12, 1, OPEN + 2000);
    b.onTrade('AAPL', 9, 2, OPEN + 3000);
    expect(b.get('AAPL')).toEqual({ t: OPEN, o: 10, h: 12, l: 9, c: 9, v: 4 });
    b.onTrade('AAPL', 20, 1, OPEN + M + 1);
    b.onTrade('AAPL', 1, 1, OPEN + 5000); // trade ช้า
    expect(b.get('AAPL')!.l).toBe(20);
    b.confirm('AAPL', OPEN + M);
    expect(b.get('AAPL')).toBeUndefined();
  });
});

describe('parseCsv', () => {
  it('อ่านรายวัน เรียงลำดับ และลบซ้ำ (แถวหลังชนะ)', () => {
    const r = parseCsv('Date,Open,High,Low,Close,Volume\n2026-01-06,2,3,1,2.5,100\n2026-01-05,1,2,1,1.5,50\n2026-01-06,2,3,1,2.8,100\n');
    expect(r.timeframe).toBe('1Day');
    expect(r.bars.map((b) => b.c)).toEqual([1.5, 2.8]);
    expect(r.duplicates).toBe(1);
    expect(r.errors).toEqual([]);
  });
  it('เวลาไม่มี offset ตีความเป็นนิวยอร์ก', () => {
    const r = parseCsv('date,open,high,low,close,volume\n2026-10-01 09:30,1,1,1,1,1\n');
    expect(r.timeframe).toBe('1Min');
    expect(r.bars[0].t).toBe(OPEN);
  });
  it('รายงานคอลัมน์ที่ขาดและแถวผิดรูปแบบ', () => {
    expect(parseCsv('Date,Open,Close\n2026-01-01,1,1').errors[0]).toContain('high');
    const r = parseCsv('Date,Open,High,Low,Close,Volume\nabc,1,1,1,1,1\n2026-01-02,1,0.5,1,1,1\n');
    expect(r.bars).toHaveLength(0);
    expect(r.errors.length).toBe(2);
  });
});
