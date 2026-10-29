import type { StrategyParams } from './config';
import { highestPrev, lowestPrev, rsi, type Series } from './indicators';
import { classifyTrendAt, computeTrendSeries, type TrendResult, type TrendSeries } from './trend';
import type { Bar } from './types';

export type Action = 'enter' | 'exit' | 'wait';

export const ACTION_LABELS: Record<Action, string> = {
  enter: 'พิจารณาซื้อ',
  exit: 'ออกจากสถานะ',
  wait: 'รอ',
};

export interface DecisionValues {
  close: number;
  highestPrev: number | null;
  lowestPrev: number | null;
  ma: number | null;
  maPrev: number | null;
  atr: number | null;
  slopeAtr: number | null;
  distanceAtr: number | null;
  /** ข้อมูลประกอบเท่านั้น ไม่ใช้ในเงื่อนไข */
  rsi14: number | null;
}

export interface Decision {
  action: Action;
  barTs: number;
  inPosition: boolean;
  trend: TrendResult;
  reasons: string[];
  values: DecisionValues;
}

export interface PreparedSeries {
  bars: Bar[];
  trend: TrendSeries;
  rsi: Series;
}

/** คำนวณ indicator ล่วงหน้าครั้งเดียว — ค่าที่ index i ใช้แท่ง 0..i เท่านั้น */
export function prepare(bars: Bar[], p: StrategyParams): PreparedSeries {
  return { bars, trend: computeTrendSeries(bars, p.trend), rsi: rsi(bars.map((b) => b.c), 14) };
}

const f = (n: number | null) => (n === null ? '-' : n.toFixed(2));

/**
 * ประเมินกติกาที่ "ราคาปิด" ของแท่ง i (long-only)
 * - เข้า: ไม่มีสถานะ + แนวโน้มขาขึ้น + Close > High สูงสุดของ breakoutLookback แท่งก่อนหน้า
 * - ออก: มีสถานะ + Close < Low ต่ำสุดของ exitLookback แท่งก่อนหน้า (ปิด long ไม่ใช่เปิด short)
 * - นอกนั้น: รอ
 * ผู้เรียกต้องรับผิดชอบว่าแท่ง i ปิดแล้ว (ระบบสดส่งเฉพาะแท่งปิด; preview ระหว่างแท่งต้องติดป้าย "รอยืนยัน")
 */
export function evaluateAt(prep: PreparedSeries, i: number, inPosition: boolean, p: StrategyParams): Decision {
  const { bars } = prep;
  const bar = bars[i];
  const trend = classifyTrendAt(bars, i, p.trend, prep.trend);
  const hi = highestPrev(bars, i, p.breakoutLookback);
  const lo = lowestPrev(bars, i, p.exitLookback);
  const values: DecisionValues = {
    close: bar.c,
    highestPrev: hi,
    lowestPrev: lo,
    ma: trend.values.ma,
    maPrev: trend.values.maPrev,
    atr: trend.values.atr,
    slopeAtr: trend.values.slopeAtr,
    distanceAtr: trend.values.distanceAtr,
    rsi14: prep.rsi[i] ?? null,
  };
  const base = { barTs: bar.t, inPosition, trend, values };

  if (inPosition) {
    if (lo === null) {
      return { ...base, action: 'wait', reasons: [`มีสถานะอยู่ แต่ยังไม่มีข้อมูล ${p.exitLookback} แท่งก่อนหน้าสำหรับจุดต่ำสุด`] };
    }
    if (bar.c < lo) {
      return {
        ...base,
        action: 'exit',
        reasons: [`มีสถานะ long อยู่`, `Close ${f(bar.c)} < Low ต่ำสุด ${p.exitLookback} แท่งก่อนหน้า ${f(lo)}`],
      };
    }
    return { ...base, action: 'wait', reasons: [`ถือสถานะต่อ: Close ${f(bar.c)} ≥ Low ต่ำสุด ${p.exitLookback} แท่งก่อนหน้า ${f(lo)}`] };
  }

  if (trend.trend !== 'up') {
    return { ...base, action: 'wait', reasons: [`ไม่มีสถานะ และแนวโน้มเป็น "${trend.label}" (ต้องเป็นขาขึ้น)`] };
  }
  if (hi === null) {
    return { ...base, action: 'wait', reasons: [`แนวโน้มขาขึ้น แต่ยังไม่มีข้อมูล ${p.breakoutLookback} แท่งก่อนหน้า`] };
  }
  if (bar.c > hi) {
    return {
      ...base,
      action: 'enter',
      reasons: [`ไม่มีสถานะ`, `แนวโน้มขาขึ้น (${trend.reasons.join(', ')})`, `Close ${f(bar.c)} > High สูงสุด ${p.breakoutLookback} แท่งก่อนหน้า ${f(hi)}`],
    };
  }
  return {
    ...base,
    action: 'wait',
    reasons: [`แนวโน้มขาขึ้น แต่ Close ${f(bar.c)} ยังไม่ทะลุ High สูงสุด ${p.breakoutLookback} แท่งก่อนหน้า ${f(hi)}`],
  };
}

/**
 * ประเมินเงื่อนไขระหว่างแท่ง (แท่งยังไม่ปิด) — ผลลัพธ์เป็น "รอยืนยัน" เท่านั้น ห้ามบันทึกเป็นสัญญาณ
 */
export function previewForming(closedBars: Bar[], forming: Bar, inPosition: boolean, p: StrategyParams): Decision & { pending: true } {
  const bars = [...closedBars, forming];
  const d = evaluateAt(prepare(bars, p), bars.length - 1, inPosition, p);
  return { ...d, pending: true };
}
