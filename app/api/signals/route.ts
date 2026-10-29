import { NextResponse } from 'next/server';
import { activeDataset, bad, ctx } from '@/server/app';
import { normalizeSymbol } from '@/server/db';
import { strategyKey } from '@/server/live/tracker';

export const dynamic = 'force-dynamic';

export function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const sym = q.get('symbol') ? normalizeSymbol(q.get('symbol')) : undefined;
  if (sym === null) return bad('ticker ไม่ถูกต้อง');
  const { store, cfg } = ctx();
  const signals = store.listSignals({
    dataset: activeDataset(store),
    symbol: sym,
    tf: q.get('tf') ?? undefined,
    strategyKey: strategyKey(cfg.settings.strategy, cfg.settings.portfolio),
    limit: 300,
  });
  return NextResponse.json({ signals });
}
