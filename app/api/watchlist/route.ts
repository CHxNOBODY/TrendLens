import { NextResponse } from 'next/server';
import { bad, ctx } from '@/server/app';
import { normalizeSymbol } from '@/server/db';

export const dynamic = 'force-dynamic';

export function GET() {
  return NextResponse.json({ watchlist: ctx().store.getWatchlist() });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const sym = normalizeSymbol(body.symbol);
  if (!sym) return bad('ticker ไม่ถูกต้อง (ตัวอักษรภาษาอังกฤษ/ตัวเลข สูงสุด 10 ตัว)');
  const { store } = ctx();
  if (store.getWatchlist().length >= 30) return bad('Watchlist เต็ม (จำกัด 30 ตัวตามข้อจำกัด WebSocket ของ Alpaca แผนฟรี)');
  store.addToWatchlist(sym);
  return NextResponse.json({ watchlist: store.getWatchlist() });
}

export function DELETE(req: Request) {
  const sym = normalizeSymbol(new URL(req.url).searchParams.get('symbol'));
  if (!sym) return bad('ticker ไม่ถูกต้อง');
  const { store } = ctx();
  store.removeFromWatchlist(sym);
  return NextResponse.json({ watchlist: store.getWatchlist() });
}
