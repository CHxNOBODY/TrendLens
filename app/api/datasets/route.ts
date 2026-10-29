import { NextResponse } from 'next/server';
import { activeDataset, bad, ctx } from '@/server/app';
import { normalizeSymbol } from '@/server/db';

export const dynamic = 'force-dynamic';

export function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get('symbol');
  const symbol = raw ? normalizeSymbol(raw) : undefined;
  if (symbol === null) return bad('ticker ไม่ถูกต้อง');
  const { store } = ctx();
  return NextResponse.json({ active: activeDataset(store), datasets: store.listDatasets(symbol) });
}
