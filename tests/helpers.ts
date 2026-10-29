import type { Bar } from '@/core/types';

export const T0 = Date.UTC(2026, 9, 1, 13, 30); // 2026-10-01 09:30 ET

/** สร้างแท่งจากราคาปิด: open = close ก่อนหน้า, high/low = max/min ของ open/close ± pad */
export function barsFromCloses(closes: number[], stepMs = 300_000, start = T0, pad = 0.1): Bar[] {
  return closes.map((c, i) => {
    const o = i === 0 ? c : closes[i - 1];
    return { t: start + i * stepMs, o, h: Math.max(o, c) + pad, l: Math.min(o, c) - pad, c, v: 1000 };
  });
}

export function bar(t: number, o: number, h: number, l: number, c: number, v = 100): Bar {
  return { t, o, h, l, c, v };
}

import type { StrategyParams } from '@/core/config';

export const SP: StrategyParams = {
  breakoutLookback: 3,
  exitLookback: 2,
  trend: { maPeriod: 5, slopeLookback: 2, atrPeriod: 3, sidewaysMaxSlopeAtr: 0.5, sidewaysMaxDistanceAtr: 1 },
};

export const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
