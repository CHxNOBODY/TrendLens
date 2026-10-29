import { NextResponse } from 'next/server';
import { parseCsv } from '@/core/csv';
import { bad, ctx } from '@/server/app';
import { normalizeSymbol } from '@/server/db';

export const dynamic = 'force-dynamic';

const CSV_DATASET = 'csv';

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const symbol = normalizeSymbol(body?.symbol);
  if (!symbol) return bad('ticker ไม่ถูกต้อง');
  if (typeof body.csv !== 'string' || !body.csv.trim()) return bad('ไม่พบเนื้อหาไฟล์ CSV');
  if (body.csv.length > 20_000_000) return bad('ไฟล์ใหญ่เกิน 20 MB');
  const parsed = parseCsv(body.csv);
  if (!parsed.timeframe || !parsed.bars.length) {
    return NextResponse.json({ ok: false, errors: parsed.errors.length ? parsed.errors : ['ไม่มีแถวที่ใช้ได้'] }, { status: 400 });
  }
  const { store } = ctx();
  if (body.replace) store.deleteBars(CSV_DATASET, symbol, parsed.timeframe);
  const stats = store.upsertBars(CSV_DATASET, symbol, parsed.timeframe, parsed.bars);
  store.registerDataset(CSV_DATASET, 'CSV นำเข้าเอง', 'ไม่ทราบ (ตามไฟล์ต้นทาง)');
  return NextResponse.json({
    ok: true,
    symbol,
    timeframe: parsed.timeframe,
    rows: parsed.totalRows,
    imported: parsed.bars.length,
    duplicatesInFile: parsed.duplicates,
    stats,
    warnings: parsed.errors,
  });
}
