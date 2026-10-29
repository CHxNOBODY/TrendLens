import { NextResponse } from 'next/server';
import { activeDataset, bad, ctx } from '@/server/app';
import { normalizeSymbol } from '@/server/db';
import { loadBars } from '@/server/data';
import { getTrackerState, strategyKey } from '@/server/live/tracker';
import type { Timeframe } from '@/core/types';

export const dynamic = 'force-dynamic';

export function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const sym = q.get('symbol') ? normalizeSymbol(q.get('symbol')) : undefined;
  if (sym === null) return bad('ticker ไม่ถูกต้อง');
  const { store, cfg } = ctx();
  const dataset = activeDataset(store);
  const { strategy, portfolio, session, strategyTimeframes } = cfg.settings;
  const sKey = strategyKey(strategy, portfolio);
  const positions = store.listPositions({ dataset, symbol: sym, strategyKey: sKey });
  // mark-to-market สถานะที่ยังเปิดด้วยราคาปิดล่าสุดของ timeframe นั้น
  const marks: Record<string, { lastClose: number; lastTs: number } | null> = {};
  const accounts: { symbol: string; tf: Timeframe; cash: number; pending: string | null; lastBarTs: number | null }[] = [];
  for (const s of store.getWatchlist()) {
    if (sym && s !== sym) continue;
    for (const tf of strategyTimeframes) {
      const st = getTrackerState(store, dataset, s, tf, strategy, portfolio);
      if (st) accounts.push({ symbol: s, tf, cash: st.sim.cash, pending: st.sim.pending?.kind ?? null, lastBarTs: st.sim.lastBarTs });
      const bars = loadBars(store, dataset, s, tf, session, { days: tf === '1Day' ? 10 : 2 });
      const last = bars[bars.length - 1];
      marks[`${s}|${tf}`] = last ? { lastClose: last.c, lastTs: last.t } : null;
    }
  }
  return NextResponse.json({ dataset, strategyKey: sKey, portfolio, positions, marks, accounts });
}
