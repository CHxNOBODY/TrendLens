import type { TrendParams } from './config';
import { atr, sma, type Series } from './indicators';
import type { Bar, Trend } from './types';

export interface TrendSeries {
  ma: Series;
  atr: Series;
}

export function computeTrendSeries(bars: Bar[], p: TrendParams): TrendSeries {
  return { ma: sma(bars.map((b) => b.c), p.maPeriod), atr: atr(bars, p.atrPeriod) };
}

export interface TrendValues {
  close: number;
  ma: number | null;
  maPrev: number | null;
  atr: number | null;
  /** (MA_now - MA_[lookback]) / ATR */
  slopeAtr: number | null;
  /** (Close - MA) / ATR */
  distanceAtr: number | null;
}

export interface TrendResult {
  trend: Trend;
  label: string;
  reasons: string[];
  values: TrendValues;
}

export const TREND_LABELS: Record<Trend, string> = {
  up: 'ขาขึ้น',
  down: 'ขาลง',
  sideways: 'ออกข้าง',
  unclear: 'ยังไม่ชัดเจน',
  insufficient: 'ข้อมูลไม่เพียงพอ',
};

const f = (n: number | null, d = 2) => (n === null ? '-' : n.toFixed(d));

/**
 * จัดประเภทแนวโน้มที่แท่ง i (ใช้ข้อมูลแท่ง 0..i เท่านั้น)
 *
 * ลำดับการตรวจ (ตัวแรกที่ผ่านคือผลลัพธ์):
 *  1. ข้อมูลไม่เพียงพอ — ไม่มี MA ปัจจุบัน, MA เมื่อ lookback แท่งก่อน หรือ ATR
 *  2. ออกข้าง — |slopeAtr| < sidewaysMaxSlopeAtr และ |distanceAtr| <= sidewaysMaxDistanceAtr
 *  3. ขาขึ้น — Close > MA และ MA > MA เมื่อ lookback แท่งก่อน
 *  4. ขาลง — Close < MA และ MA < MA เมื่อ lookback แท่งก่อน
 *  5. ยังไม่ชัดเจน — เงื่อนไขขัดแย้งกัน
 */
export function classifyTrendAt(bars: Bar[], i: number, p: TrendParams, s?: TrendSeries): TrendResult {
  const series = s ?? computeTrendSeries(bars, p);
  const close = bars[i].c;
  const ma = series.ma[i] ?? null;
  const maPrev = i - p.slopeLookback >= 0 ? (series.ma[i - p.slopeLookback] ?? null) : null;
  const a = series.atr[i] ?? null;
  const values: TrendValues = { close, ma, maPrev, atr: a, slopeAtr: null, distanceAtr: null };
  const maName = `MA${p.maPeriod}`;

  if (ma === null || maPrev === null || a === null) {
    return {
      trend: 'insufficient',
      label: TREND_LABELS.insufficient,
      reasons: [`ต้องมีอย่างน้อย ${p.maPeriod + p.slopeLookback} แท่งเพื่อคำนวณ ${maName} และค่าเมื่อ ${p.slopeLookback} แท่งก่อน`],
      values,
    };
  }

  const slopeAtr = a > 0 ? (ma - maPrev) / a : 0;
  const distanceAtr = a > 0 ? (close - ma) / a : 0;
  values.slopeAtr = slopeAtr;
  values.distanceAtr = distanceAtr;

  if (Math.abs(slopeAtr) < p.sidewaysMaxSlopeAtr && Math.abs(distanceAtr) <= p.sidewaysMaxDistanceAtr) {
    return {
      trend: 'sideways',
      label: TREND_LABELS.sideways,
      reasons: [
        `ความชัน ${maName} = ${f(slopeAtr)} ATR (เกณฑ์ < ${p.sidewaysMaxSlopeAtr})`,
        `ราคาห่าง ${maName} = ${f(distanceAtr)} ATR (เกณฑ์ ≤ ${p.sidewaysMaxDistanceAtr})`,
      ],
      values,
    };
  }
  if (close > ma && ma > maPrev) {
    return {
      trend: 'up',
      label: TREND_LABELS.up,
      reasons: [`Close ${f(close)} > ${maName} ${f(ma)}`, `${maName} ${f(ma)} > ค่าเมื่อ ${p.slopeLookback} แท่งก่อน ${f(maPrev)}`],
      values,
    };
  }
  if (close < ma && ma < maPrev) {
    return {
      trend: 'down',
      label: TREND_LABELS.down,
      reasons: [`Close ${f(close)} < ${maName} ${f(ma)}`, `${maName} ${f(ma)} < ค่าเมื่อ ${p.slopeLookback} แท่งก่อน ${f(maPrev)}`],
      values,
    };
  }
  return {
    trend: 'unclear',
    label: TREND_LABELS.unclear,
    reasons: [
      `Close ${f(close)} ${close > ma ? '>' : close < ma ? '<' : '='} ${maName} ${f(ma)} แต่ ${maName} ${ma > maPrev ? 'เพิ่มขึ้น' : ma < maPrev ? 'ลดลง' : 'ทรงตัว'} จาก ${f(maPrev)} — เงื่อนไขขัดแย้งกัน`,
    ],
    values,
  };
}
