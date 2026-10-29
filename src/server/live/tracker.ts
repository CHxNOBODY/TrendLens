/**
 * ติดตามสัญญาณสดแบบ incremental — ใช้ prepare/step ชุดเดียวกับ backtest
 * - ประมวลผลเฉพาะแท่งที่ปิดแล้วและใหม่กว่า lastBarTs ที่บันทึกไว้ (ไม่ประมวลผลซ้ำ)
 * - สัญญาณบันทึกด้วย INSERT OR IGNORE บน unique key (ไม่ซ้ำแม้ worker restart)
 * - ครั้งแรกจะไล่ประวัติที่มีอยู่ (origin = backfill) เพื่อสร้างสถานะจำลองเริ่มต้น
 * - สถานะจำลอง (sim_positions) แยกจากเหตุการณ์สัญญาณ (signal_events)
 */
import { STRATEGY_NAME, type PortfolioParams, type StrategyParams } from '@/core/config';
import { initialState, step, type SimState } from '@/core/engine';
import { fnv1a, stableStringify } from '@/core/hash';
import { prepare } from '@/core/strategy';
import type { Bar, Timeframe } from '@/core/types';
import type { Store } from '../db';

export function strategyKey(sp: StrategyParams, pp: PortfolioParams): string {
  return `${STRATEGY_NAME}:${fnv1a(stableStringify({ sp, pp }))}`;
}

export interface TrackerState {
  sim: SimState;
  initializedAt: number;
}

export function trackerKey(dataset: string, symbol: string, tf: Timeframe, sKey: string): string {
  return `tracker|${dataset}|${symbol}|${tf}|${sKey}`;
}

export interface ProcessResult {
  processed: number;
  newSignals: number;
  origin: string | null;
}

export function processClosedBars(
  store: Store,
  k: { dataset: string; symbol: string; tf: Timeframe },
  closedBars: Bar[],
  sp: StrategyParams,
  pp: PortfolioParams,
): ProcessResult {
  const sKey = strategyKey(sp, pp);
  const key = trackerKey(k.dataset, k.symbol, k.tf, sKey);
  const saved = store.getEngineState<TrackerState>(key);
  const state: TrackerState = saved ?? { sim: initialState(pp), initializedAt: Date.now() };
  const last = state.sim.lastBarTs ?? -Infinity;
  const startIdx = closedBars.findIndex((b) => b.t > last);
  if (startIdx < 0) return { processed: 0, newSignals: 0, origin: null };

  const origin = !saved ? 'backfill' : closedBars.length - startIdx > 1 ? 'catchup' : 'live';
  const prep = prepare(closedBars, sp);
  const ids = { dataset: k.dataset, symbol: k.symbol, tf: k.tf, strategyKey: sKey };
  let newSignals = 0;

  store.db.transaction(() => {
    for (let i = startIdx; i < closedBars.length; i++) {
      const r = step(prep, i, state.sim, sp, pp);
      if (r.fill?.kind === 'buy') {
        store.openPosition(ids, { entrySignalTs: r.fill.signalTs, entryTs: r.fill.ts, entryPrice: r.fill.price, qty: r.fill.qty, entryFee: r.fill.fee });
      } else if (r.fill?.kind === 'skipped') {
        store.openPosition(ids, { entrySignalTs: r.fill.signalTs, entryTs: r.fill.ts, entryPrice: r.fill.rawPrice, qty: 0, entryFee: 0, status: 'skipped', note: r.fill.note });
      } else if (r.fill?.kind === 'sell' && r.closedTrade) {
        const t = r.closedTrade;
        store.closePosition(ids, { exitSignalTs: t.exitSignalTs, exitTs: t.exitTs, exitPrice: t.exitPrice, exitFee: t.exitFee, pnl: t.pnl });
      }
      if (r.signal && store.insertSignal(ids, r.signal, origin)) newSignals++;
    }
    store.setEngineState(key, state);
  })();

  return { processed: closedBars.length - startIdx, newSignals, origin };
}

export function getTrackerState(store: Store, dataset: string, symbol: string, tf: Timeframe, sp: StrategyParams, pp: PortfolioParams): TrackerState | null {
  return store.getEngineState<TrackerState>(trackerKey(dataset, symbol, tf, strategyKey(sp, pp)));
}
