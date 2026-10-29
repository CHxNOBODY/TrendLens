import { describe, expect, it } from 'vitest';
import { evaluateAt, prepare, previewForming } from '@/core/strategy';
import { SP, bar, barsFromCloses, range } from './helpers';

describe('evaluateAt', () => {
  it('เข้าเมื่อแนวโน้มขาขึ้นและ Close ทะลุ High ของแท่งก่อนหน้า (ไม่รวมแท่งปัจจุบัน)', () => {
    const bars = barsFromCloses(range(1, 20));
    const prep = prepare(bars, SP);
    // แท่ง 5 ยังข้อมูลไม่พอ, แท่ง 6 แนวโน้มขาขึ้นครั้งแรก
    expect(evaluateAt(prep, 5, false, SP).action).toBe('wait');
    const d = evaluateAt(prep, 6, false, SP);
    expect(d.action).toBe('enter');
    expect(d.values.highestPrev).toBeCloseTo(6.1); // max high ของแท่ง 3..5 ไม่รวมแท่ง 6 (high 7.1)
    expect(d.reasons.join(' ')).toContain('High สูงสุด 3 แท่งก่อนหน้า');
  });

  it('Close เท่ากับ High ก่อนหน้า (ไม่ทะลุ) → รอ', () => {
    const bars = barsFromCloses(range(1, 10));
    const i = 9;
    const hi = Math.max(...bars.slice(i - 3, i).map((b) => b.h));
    bars[i] = bar(bars[i].t, bars[i].o, hi + 0.5, bars[i].l, hi);
    expect(evaluateAt(prepare(bars, SP), i, false, SP).action).toBe('wait');
  });

  it('ไม่เข้าเมื่อแนวโน้มไม่ใช่ขาขึ้น', () => {
    // ขาลงยาวแล้วเด้งทะลุ High 3 แท่งก่อนหน้า (4.1) แต่ MA10 ยังลง → ไม่ใช่ขาขึ้น
    const p = { ...SP, trend: { ...SP.trend, maPeriod: 10 } };
    const bars = barsFromCloses([...range(1, 20).reverse(), 5]);
    const d = evaluateAt(prepare(bars, p), 20, false, p);
    expect(d.values.close).toBeGreaterThan(d.values.highestPrev!);
    expect(d.trend.trend).not.toBe('up');
    expect(d.action).toBe('wait');
  });

  it('ออกเมื่อมีสถานะและ Close ต่ำกว่า Low ต่ำสุด 2 แท่งก่อนหน้า', () => {
    const bars = barsFromCloses([...range(1, 12), 8]);
    const d = evaluateAt(prepare(bars, SP), 12, true, SP);
    expect(d.action).toBe('exit');
    expect(d.values.lowestPrev).toBeCloseTo(9.9); // low ของแท่ง 10..11
  });

  it('ไม่มีสถานะ → ไม่มีสัญญาณออก (long-only ไม่เปิด short)', () => {
    const bars = barsFromCloses([...range(1, 12), 8]);
    expect(evaluateAt(prepare(bars, SP), 12, false, SP).action).toBe('wait');
  });

  it('RSI เป็นข้อมูลประกอบ ไม่เปลี่ยนการตัดสินใจ', () => {
    const bars = barsFromCloses(range(1, 30));
    const prep = prepare(bars, SP);
    const d1 = evaluateAt(prep, 20, false, SP);
    const d2 = evaluateAt({ ...prep, rsi: prep.rsi.map(() => 1) }, 20, false, SP);
    expect(d1.action).toBe(d2.action);
    expect(d1.values.rsi14).toBe(100);
  });

  it('preview ระหว่างแท่งติดป้าย pending', () => {
    const bars = barsFromCloses(range(1, 10));
    const forming = { ...bars[9], t: bars[9].t + 300_000, o: 10, c: 15, h: 15, l: 10 };
    const p = previewForming(bars, forming, false, SP);
    expect(p.pending).toBe(true);
    expect(p.action).toBe('enter');
  });
});
