import type { Bar } from './types';

export type Series = (number | null)[];

/** Simple Moving Average — ค่าแรกที่มีคือ index = period - 1 (ก่อนหน้านั้นเป็น null = warm-up) */
export function sma(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  if (period <= 0) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/**
 * RSI แบบ Wilder — ค่าแรกที่ index = period (ต้องมีการเปลี่ยนแปลงราคา period ครั้ง)
 * ใช้เป็นข้อมูลประกอบเท่านั้น ไม่อยู่ในเงื่อนไขกลยุทธ์
 */
export function rsi(values: number[], period = 14): Series {
  const out: Series = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = values[i] - values[i - 1];
    if (ch >= 0) gain += ch;
    else loss -= ch;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  const calc = () => (avgLoss === 0 ? (avgGain === 0 ? 50 : 100) : 100 - 100 / (1 + avgGain / avgLoss));
  out[period] = calc();
  for (let i = period + 1; i < values.length; i++) {
    const ch = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(ch, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-ch, 0)) / period;
    out[i] = calc();
  }
  return out;
}

/** True Range: แท่งแรกใช้ high - low */
export function trueRange(bars: Bar[]): number[] {
  return bars.map((b, i) =>
    i === 0 ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c)),
  );
}

/**
 * ATR แบบ simple average ของ True Range (ไม่ใช้ Wilder smoothing)
 * เพื่อให้ค่าไม่ขึ้นกับจุดเริ่มของหน้าต่างข้อมูล → ระบบสดและ backtest ได้ค่าเดียวกัน
 * ค่าแรกที่ index = period (ต้องมี close ก่อนหน้าครบ)
 */
export function atr(bars: Bar[], period = 14): Series {
  const tr = trueRange(bars);
  const out: Series = new Array(bars.length).fill(null);
  let sum = 0;
  for (let i = 1; i < bars.length; i++) {
    sum += tr[i];
    if (i > period) sum -= tr[i - period];
    if (i >= period) out[i] = sum / period;
  }
  return out;
}

/** จุดสูงสุดของ n แท่ง "ก่อนหน้า" (ไม่รวมแท่ง i) — null ถ้ามีแท่งก่อนหน้าไม่ครบ */
export function highestPrev(bars: Bar[], i: number, n: number): number | null {
  if (n <= 0 || i < n) return null;
  let m = -Infinity;
  for (let k = i - n; k < i; k++) m = Math.max(m, bars[k].h);
  return m;
}

/** จุดต่ำสุดของ n แท่ง "ก่อนหน้า" (ไม่รวมแท่ง i) */
export function lowestPrev(bars: Bar[], i: number, n: number): number | null {
  if (n <= 0 || i < n) return null;
  let m = Infinity;
  for (let k = i - n; k < i; k++) m = Math.min(m, bars[k].l);
  return m;
}
