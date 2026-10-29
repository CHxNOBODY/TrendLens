import { describe, expect, it } from 'vitest';
import { runBacktest, runSplitBacktest } from '@/core/backtest';
import type { PortfolioParams } from '@/core/config';
import { computeBuy, computeSell, initialState, step } from '@/core/engine';
import { prepare } from '@/core/strategy';
import { SP, barsFromCloses, range } from './helpers';

const PP: PortfolioParams = { initialCash: 1000, allocationPct: 100, feePct: 0, feeFixed: 0, slippagePct: 0, fractional: true };
// ขึ้น 1..15 แล้วลงแรงเพื่อให้เกิดสัญญาณออก แล้วนิ่ง
const UP_DOWN = [...range(1, 15), 12, 11, 11, 11, 11];

function ok<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error((r as unknown as { error: string }).error);
  return r as Extract<T, { ok: true }>;
}

describe('execution model', () => {
  it('สัญญาณที่ราคาปิดแท่ง i → execute ที่ราคาเปิดแท่ง i+1', () => {
    const bars = barsFromCloses(UP_DOWN);
    const r = ok(runBacktest(bars, { strategy: SP, portfolio: PP }));
    const entry = r.signals[0];
    expect(entry.kind).toBe('enter');
    const idx = bars.findIndex((b) => b.t === entry.barTs);
    expect(r.fills[0].ts).toBe(bars[idx + 1].t);
    expect(r.fills[0].rawPrice).toBe(bars[idx + 1].o);
    expect(r.fills[0].signalTs).toBe(entry.barTs);
  });

  it('ไม่เปิดสถานะซ้อน: ระหว่างถือสถานะไม่มีสัญญาณเข้าซ้ำ', () => {
    const r = ok(runBacktest(barsFromCloses(UP_DOWN), { strategy: SP, portfolio: PP }));
    expect(r.signals.map((s) => s.kind)).toEqual(['enter', 'exit']);
    expect(r.trades).toHaveLength(1);
  });

  it('step() ปฏิเสธแท่งที่เวลาไม่เพิ่มขึ้น (ป้องกันประมวลผลซ้ำ)', () => {
    const bars = barsFromCloses(range(1, 10));
    const prep = prepare(bars, SP);
    const st = initialState(PP);
    step(prep, 5, st, SP, PP);
    expect(() => step(prep, 5, st, SP, PP)).toThrow();
  });
});

describe('fees, slippage, cash', () => {
  const pp: PortfolioParams = { ...PP, feePct: 1, slippagePct: 1, feeFixed: 1 };
  it('ซื้อ: ราคา + slippage, ค่าธรรมเนียม % + คงที่, เงินสดไม่ติดลบ', () => {
    const b = computeBuy(1000, 100, pp)!;
    expect(b.price).toBeCloseTo(101);
    expect(b.fee).toBeCloseTo(b.cost * 0.01 + 1);
    expect(b.cost + b.fee).toBeLessThanOrEqual(1000);
    expect(1000 - b.cost - b.fee).toBeLessThan(0.01);
  });
  it('ไม่ใช้ leverage: allocation > 100% ถูกจำกัดที่ 100%', () => {
    expect(computeBuy(1000, 100, { ...PP, allocationPct: 300 })!.cost).toBeLessThanOrEqual(1000);
  });
  it('หุ้นจำนวนเต็มเมื่อปิด fractional', () => {
    expect(computeBuy(1000, 300, { ...PP, fractional: false })!.qty).toBe(3);
    expect(computeBuy(100, 300, { ...PP, fractional: false })).toBeNull();
  });
  it('ขาย: ราคา - slippage และค่าธรรมเนียมไม่เกินมูลค่าขาย', () => {
    const s = computeSell(2, 100, pp);
    expect(s.price).toBeCloseTo(99);
    expect(s.fee).toBeCloseTo(198 * 0.01 + 1);
    expect(computeSell(0.001, 1, { ...PP, feeFixed: 5 }).fee).toBeCloseTo(0.001);
  });
  it('backtest มีต้นทุน: เงินสดไม่ติดลบตลอด และ PnL หักต้นทุนครบ', () => {
    const r = ok(runBacktest(barsFromCloses(UP_DOWN), { strategy: SP, portfolio: pp }));
    expect(r.fills.every((f) => f.cashAfter >= 0)).toBe(true);
    const t = r.trades[0];
    expect(t.pnl).toBeCloseTo(t.qty * t.exitPrice - t.exitFee - (t.qty * t.entryPrice + t.entryFee));
    expect(r.metrics.finalEquity).toBeCloseTo(1000 + t.pnl);
  });
  it('เงินไม่พอ → ข้ามการซื้อและบันทึกเหตุผล', () => {
    const r = ok(runBacktest(barsFromCloses(UP_DOWN), { strategy: SP, portfolio: { ...PP, initialCash: 5, fractional: false } }));
    expect(r.fills[0].kind).toBe('skipped');
    expect(r.trades).toHaveLength(0);
  });
});

describe('metrics & edge cases', () => {
  it('ไม่มีเทรด: win rate/profit factor เป็น null พร้อมคำอธิบาย', () => {
    const r = ok(runBacktest(barsFromCloses(new Array(30).fill(10)), { strategy: SP, portfolio: PP }));
    expect(r.metrics.closedTrades).toBe(0);
    expect(r.metrics.winRatePct).toBeNull();
    expect(r.metrics.profitFactor).toBeNull();
    expect(r.warnings.join()).toContain('ไม่มีเทรด');
    expect(r.metrics.totalReturnPct).toBe(0);
  });

  it('ไม่มีเทรดขาดทุน: profit factor = null พร้อมหมายเหตุ', () => {
    const r = ok(runBacktest(barsFromCloses([...range(1, 15), 30, 31, 32, 29, 29]), { strategy: SP, portfolio: PP }));
    expect(r.metrics.losses).toBe(0);
    expect(r.metrics.wins).toBe(1);
    expect(r.metrics.profitFactor).toBeNull();
    expect(r.metrics.profitFactorNote).toContain('ไม่มีเทรดขาดทุน');
  });

  it('สถานะยังเปิดเมื่อจบช่วง: mark-to-market แยกจากเทรดที่ปิดแล้ว', () => {
    const r = ok(runBacktest(barsFromCloses(range(1, 15)), { strategy: SP, portfolio: PP }));
    expect(r.trades).toHaveLength(0);
    expect(r.openPosition).not.toBeNull();
    expect(r.openPosition!.lastClose).toBe(15);
    expect(r.metrics.finalEquity).toBeCloseTo(r.openPosition!.marketValue + r.fills[0].cashAfter);
  });

  it('สัญญาณที่แท่งสุดท้าย → แจ้งว่ายัง execute ไม่ได้', () => {
    const r = ok(runBacktest(barsFromCloses(range(1, 7)), { strategy: SP, portfolio: PP }));
    expect(r.pendingAtEnd?.kind).toBe('enter');
    expect(r.fills).toHaveLength(0);
    expect(r.warnings.join()).toContain('ยัง execute ไม่ได้');
  });

  it('ข้อมูลไม่เพียงพอ → error ชัดเจน', () => {
    expect(runBacktest(barsFromCloses([1]), { strategy: SP, portfolio: PP }).ok).toBe(false);
  });

  it('buy-and-hold ใช้ช่วงและต้นทุนเดียวกัน', () => {
    const bars = barsFromCloses(UP_DOWN);
    const r = ok(runBacktest(bars, { strategy: SP, portfolio: { ...PP, feePct: 0.5, slippagePct: 0.2 }, startTs: bars[2].t }));
    const b = r.benchmark!;
    expect(b.equity[0].t).toBe(bars[2].t);
    expect(r.equity[0].t).toBe(bars[2].t);
    expect(b.entryPrice).toBeCloseTo(bars[2].o * 1.002);
    expect(b.metrics.maxDrawdownPct).toBeGreaterThan(0);
  });
});

describe('no look-ahead', () => {
  it('ผลก่อนเวลา k ไม่เปลี่ยนเมื่อมีข้อมูลอนาคตต่อท้าย', () => {
    const bars = barsFromCloses([...range(1, 15), 12, 11, 13, 16, 18, 14, 10, 9, 12, 15]);
    const k = 17;
    const a = ok(runBacktest(bars.slice(0, k + 1), { strategy: SP, portfolio: PP }));
    const b = ok(runBacktest(bars, { strategy: SP, portfolio: PP, endTs: bars[k].t }));
    const c = ok(runBacktest(bars, { strategy: SP, portfolio: PP }));
    expect(b.signals).toEqual(a.signals);
    expect(c.signals.filter((s) => s.barTs <= bars[k].t)).toEqual(a.signals);
  });

  it('split in-sample / out-of-sample: เงินตั้งต้นใหม่ และช่วงไม่ทับกัน', () => {
    const bars = barsFromCloses([...UP_DOWN, ...range(12, 30)]);
    const split = bars[20].t;
    const s = runSplitBacktest(bars, split, { strategy: SP, portfolio: PP });
    const is = ok(s.inSample);
    const oos = ok(s.outOfSample);
    expect(is.endTs).toBeLessThan(split);
    expect(oos.startTs).toBe(split);
    expect(oos.warmupBars).toBe(20);
    expect(oos.metrics.initialCash).toBe(PP.initialCash);
  });
});
