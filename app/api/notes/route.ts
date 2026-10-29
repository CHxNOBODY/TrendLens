import { NextResponse } from 'next/server';
import { bad, ctx } from '@/server/app';
import { normalizeSymbol } from '@/server/db';

export const dynamic = 'force-dynamic';

export function GET(req: Request) {
  const sym = normalizeSymbol(new URL(req.url).searchParams.get('symbol'));
  if (!sym) return bad('ticker ไม่ถูกต้อง');
  return NextResponse.json({ notes: ctx().store.listNotes(sym) });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const sym = normalizeSymbol(body.symbol);
  const text = typeof body.body === 'string' ? body.body.trim() : '';
  if (!sym) return bad('ticker ไม่ถูกต้อง');
  if (!text) return bad('กรุณาพิมพ์บันทึก');
  if (text.length > 5000) return bad('บันทึกยาวเกิน 5,000 ตัวอักษร');
  return NextResponse.json({ note: ctx().store.addNote(sym, text) });
}

export function DELETE(req: Request) {
  const id = Number(new URL(req.url).searchParams.get('id'));
  if (!Number.isInteger(id)) return bad('id ไม่ถูกต้อง');
  return NextResponse.json({ deleted: ctx().store.deleteNote(id) });
}
