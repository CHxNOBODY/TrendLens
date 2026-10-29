/**
 * ค่าเริ่มต้นของกติกา (ใช้ร่วมกันทั้ง UI, worker, backtest และ tests)
 * แก้ค่าได้ผ่าน trendlens.config.json ที่ root ของโปรเจกต์ (ดู README)
 */
import type { SessionMode, Timeframe } from './types';

export interface TrendParams {
  /** จำนวนแท่งของ MA หลัก (MA50 = 50 แท่งของ timeframe นั้น) */
  maPeriod: number;
  /** เทียบ MA กับค่าเมื่อกี่แท่งก่อน */
  slopeLookback: number;
  /** ATR ใช้ normalize ความชันและระยะห่าง */
  atrPeriod: number;
  /** ออกข้างเมื่อ |MA_now - MA_[lookback]| / ATR < ค่านี้ ... */
  sidewaysMaxSlopeAtr: number;
  /** ... และ |Close - MA| / ATR <= ค่านี้ */
  sidewaysMaxDistanceAtr: number;
}

export interface StrategyParams {
  /** เข้าเมื่อ Close > จุดสูงสุดของ N แท่งก่อนหน้า (ไม่รวมแท่งปัจจุบัน) */
  breakoutLookback: number;
  /** ออกเมื่อ Close < จุดต่ำสุดของ N แท่งก่อนหน้า (ไม่รวมแท่งปัจจุบัน) */
  exitLookback: number;
  trend: TrendParams;
}

export interface PortfolioParams {
  initialCash: number;
  /** สัดส่วนเงินสดที่ใช้ต่อการเข้า 1 ครั้ง (0-100) */
  allocationPct: number;
  /** ค่าธรรมเนียม % ของมูลค่าซื้อขาย ต่อขา */
  feePct: number;
  /** ค่าธรรมเนียมคงที่ (USD) ต่อขา */
  feeFixed: number;
  /** slippage % ที่ทำให้ราคาแย่ลง (ซื้อแพงขึ้น/ขายถูกลง) */
  slippagePct: number;
  /** อนุญาตหุ้นเศษส่วน (ปัดลงที่ 6 ตำแหน่ง) — ถ้า false ปัดลงเป็นจำนวนเต็ม */
  fractional: boolean;
}

export const DEFAULT_TREND: TrendParams = {
  maPeriod: 50,
  slopeLookback: 10,
  atrPeriod: 14,
  sidewaysMaxSlopeAtr: 0.5,
  sidewaysMaxDistanceAtr: 1.0,
};

export const DEFAULT_STRATEGY: StrategyParams = {
  breakoutLookback: 20,
  exitLookback: 10,
  trend: DEFAULT_TREND,
};

export const DEFAULT_PORTFOLIO: PortfolioParams = {
  initialCash: 10_000,
  allocationPct: 100,
  feePct: 0.1,
  feeFixed: 0,
  slippagePct: 0.05,
  fractional: true,
};

export const DEFAULT_WATCHLIST = ['AAPL', 'MSFT', 'NVDA', 'AMD', 'GOOGL', 'AMZN', 'META'];

export interface AppSettings {
  session: SessionMode;
  /** timeframe ที่ worker ติดตามสัญญาณสดและบันทึกเหตุการณ์ */
  strategyTimeframes: Timeframe[];
  strategy: StrategyParams;
  portfolio: PortfolioParams;
}

export const DEFAULT_SETTINGS: AppSettings = {
  session: 'regular',
  strategyTimeframes: ['5Min'],
  strategy: DEFAULT_STRATEGY,
  portfolio: DEFAULT_PORTFOLIO,
};

export const STRATEGY_NAME = 'breakout-v1';

/** จำนวนแท่งขั้นต่ำก่อนประเมินแนวโน้มได้ */
export function trendWarmupBars(p: TrendParams): number {
  return Math.max(p.maPeriod + p.slopeLookback, p.atrPeriod + 1);
}

export function mergeSettings(base: AppSettings, override: unknown): AppSettings {
  if (!override || typeof override !== 'object') return base;
  const o = override as Partial<AppSettings> & { strategy?: Partial<StrategyParams> };
  return {
    session: o.session === 'extended' ? 'extended' : o.session === 'regular' ? 'regular' : base.session,
    strategyTimeframes: Array.isArray(o.strategyTimeframes) && o.strategyTimeframes.length ? o.strategyTimeframes : base.strategyTimeframes,
    strategy: {
      ...base.strategy,
      ...(o.strategy ?? {}),
      trend: { ...base.strategy.trend, ...(o.strategy?.trend ?? {}) },
    },
    portfolio: { ...base.portfolio, ...(o.portfolio ?? {}) },
  };
}
