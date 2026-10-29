import { describe, expect, it } from 'vitest';
import { atr, highestPrev, lowestPrev, rsi, sma } from '@/core/indicators';
import { bar, barsFromCloses } from './helpers';

describe('sma', () => {
  it('คืน null ในช่วง warm-up และค่าเฉลี่ยหลังจากนั้น', () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });
  it('ข้อมูลน้อยกว่า period → null ทั้งหมด', () => {
    expect(sma([1, 2], 3)).toEqual([null, null]);
  });
});

describe('rsi (Wilder)', () => {
  it('ค่าแรกอยู่ที่ index = period', () => {
    const r = rsi(Array.from({ length: 20 }, (_, i) => 100 + i), 14);
    expect(r.slice(0, 14).every((x) => x === null)).toBe(true);
    expect(r[14]).toBe(100);
  });
  it('ราคาลงอย่างเดียว → 0, ราคานิ่ง → 50', () => {
    expect(rsi(Array.from({ length: 16 }, (_, i) => 100 - i), 14)[15]).toBe(0);
    expect(rsi(new Array(16).fill(10), 14)[15]).toBe(50);
  });
  it('ตรงกับค่าที่คำนวณด้วยมือ', () => {
    // period 2: changes +1, -1 → avgGain .5 avgLoss .5 → 50; ต่อด้วย +2 → gain=(0.5+2)/2=1.25, loss=0.25 → 100-100/6
    const r = rsi([10, 11, 10, 12], 2);
    expect(r[2]).toBeCloseTo(50);
    expect(r[3]).toBeCloseTo(100 - 100 / 6);
  });
});

describe('atr (simple average of TR)', () => {
  it('ค่าแรกที่ index = period และใช้ previous close', () => {
    const bars = [bar(0, 10, 11, 9, 10), bar(1, 10, 12, 10, 11), bar(2, 11, 11, 8, 9), bar(3, 9, 10, 9, 10)];
    // TR1 = max(2, |12-10|, |10-10|)=2 ; TR2 = max(3, 0, 3)=3 ; TR3 = max(1, 1, 0)=1
    const a = atr(bars, 2);
    expect(a[0]).toBeNull();
    expect(a[1]).toBeNull();
    expect(a[2]).toBeCloseTo(2.5);
    expect(a[3]).toBeCloseTo(2);
  });
});

describe('highestPrev / lowestPrev', () => {
  const bars = [bar(0, 1, 1, 0.5, 1), bar(1, 2, 2, 1.5, 2), bar(2, 3, 3, 2.5, 3), bar(3, 3, 10, 0.1, 9)];
  it('ไม่รวมแท่งปัจจุบัน', () => {
    expect(highestPrev(bars, 3, 3)).toBe(3); // ไม่ใช่ 10 ของแท่ง i
    expect(lowestPrev(bars, 3, 3)).toBe(0.5); // ไม่ใช่ 0.1 ของแท่ง i
  });
  it('แท่งก่อนหน้าไม่ครบ → null', () => {
    expect(highestPrev(bars, 2, 3)).toBeNull();
    expect(lowestPrev(barsFromCloses([1, 2]), 1, 2)).toBeNull();
  });
});
