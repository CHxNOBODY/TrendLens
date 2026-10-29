import { NextResponse } from 'next/server';
import { ctx, workerStatus } from '@/server/app';

export const dynamic = 'force-dynamic';

export function GET() {
  const { store, cfg } = ctx();
  const { status, workerAlive } = workerStatus(store);
  return NextResponse.json({
    status,
    workerAlive,
    serverNow: Date.now(),
    watchlist: store.getWatchlist(),
    config: {
      uiRefreshMs: cfg.uiRefreshMs,
      session: cfg.settings.session,
      strategyTimeframes: cfg.settings.strategyTimeframes,
      strategy: cfg.settings.strategy,
      portfolio: cfg.settings.portfolio,
    },
  });
}
