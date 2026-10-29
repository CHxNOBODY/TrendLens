import { describe, expect, it } from 'vitest';
import type { TrendParams } from '@/core/config';
import { DEFAULT_TREND, trendWarmupBars } from '@/core/config';
import { classifyTrendAt } from '@/core/trend';
import { barsFromCloses } from './helpers';

const P: TrendParams = { maPeriod: 5, slopeLookback: 2, atrPeriod: 3, sidewaysMaxSlopeAtr: 0.5, sidewaysMaxDistanceAtr: 1 };
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

describe('classifyTrendAt', () => {
  it('ข้อมูลไม่เพียงพอเมื่อแท่งไม่ครบ MA + lookback', () => {
    const bars = barsFromCloses(range(1, 30));
    expect(classifyTrendAt(bars, 5, P).trend).toBe('insufficient');
    expect(classifyTrendAt(bars, 6, P).trend).toBe('up');
  });

  it('ขาขึ้น: Close > MA และ MA สูงกว่าค่าเมื่อ lookback แท่งก่อน', () => {
    const r = classifyTrendAt(barsFromCloses(range(1, 30)), 29, P);
    expect(r.trend).toBe('up');
    expect(r.values.ma).toBeCloseTo(28);
    expect(r.values.maPrev).toBeCloseTo(26);
  });

  it('ขาลง', () => {
    expect(classifyTrendAt(barsFromCloses(range(1, 30).reverse()), 29, P).trend).toBe('down');
  });

  it('ออกข้าง: MA แบนและราคาใกล้ MA (normalized ด้วย ATR)', () => {
    const closes = range(0, 29).map((i) => (i % 2 ? 100.2 : 100));
    const r = classifyTrendAt(barsFromCloses(closes), 29, P);
    expect(r.trend).toBe('sideways');
    expect(Math.abs(r.values.slopeAtr!)).toBeLessThan(0.5);
  });

  it('ยังไม่ชัดเจน: ราคาหลุด MA แต่ MA ยังชันขึ้น', () => {
    const p = { ...P, maPeriod: 10, sidewaysMaxSlopeAtr: 0.2 }; // slope = 1.2/3.2 ATR
    const r = classifyTrendAt(barsFromCloses([...range(1, 40), 33]), 40, p);
    expect(r.trend).toBe('unclear');
  });

  it('ตรวจ "ออกข้าง" ก่อน "ขาขึ้น" ตามลำดับที่กำหนด', () => {
    // MA ขึ้นเล็กน้อยมากเทียบกับ ATR → ออกข้าง แม้ Close > MA และ MA > MA ก่อนหน้า
    const closes = range(0, 29).map((i) => 100 + i * 0.01 + (i % 2 ? 1 : 0));
    const r = classifyTrendAt(barsFromCloses(closes), 29, P);
    expect(r.trend).toBe('sideways');
  });

  it('warm-up ของค่าเริ่มต้น = 60 แท่ง (MA50 + 10)', () => {
    expect(trendWarmupBars(DEFAULT_TREND)).toBe(60);
  });
});
