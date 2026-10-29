/**
 * นำเข้า CSV ที่มีคอลัมน์ Date, Open, High, Low, Close, Volume (ไม่สนตัวพิมพ์ใหญ่เล็ก ลำดับคอลัมน์ใดก็ได้)
 * - Date แบบ YYYY-MM-DD → แท่งรายวัน (1Day)
 * - Date แบบมีเวลา: มี Z หรือ offset (+07:00) → ใช้ตามนั้น; ไม่มี offset → ตีความเป็นเวลานิวยอร์ก → แท่ง 1Min
 * - แถวซ้ำ (เวลาเดียวกัน) ใช้แถวหลังสุด; แถวผิดรูปแบบถูกข้ามและรายงาน
 */
import { normalizeBars } from './aggregation';
import { NY_TZ, dailyBarTs, zonedTimeToUtc } from './market';
import type { Bar, BaseTimeframe } from './types';

export interface CsvParseResult {
  timeframe: BaseTimeframe | null;
  bars: Bar[];
  errors: string[];
  duplicates: number;
  totalRows: number;
}

function splitLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === ',' && !q) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

export function parseDateCell(s: string): { ts: number; daily: boolean } | null {
  let m = DATE_ONLY.exec(s);
  if (m) return { ts: dailyBarTs(s), daily: true };
  m = DATE_TIME.exec(s);
  if (!m) return null;
  const [, y, mo, d, hh, mi, ss, , tz] = m;
  if (tz) {
    const iso = `${y}-${mo}-${d}T${hh}:${mi}:${ss ?? '00'}${tz.length === 5 ? `${tz.slice(0, 3)}:${tz.slice(3)}` : tz}`;
    const ts = Date.parse(iso);
    return Number.isFinite(ts) ? { ts, daily: false } : null;
  }
  return { ts: zonedTimeToUtc(+y, +mo, +d, +hh, +mi, NY_TZ) + (ss ? +ss * 1000 : 0), daily: false };
}

export function parseCsv(text: string): CsvParseResult {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
  const res: CsvParseResult = { timeframe: null, bars: [], errors: [], duplicates: 0, totalRows: Math.max(0, lines.length - 1) };
  if (lines.length < 2) {
    res.errors.push('ไฟล์ว่างหรือไม่มีแถวข้อมูล');
    return res;
  }
  const header = splitLine(lines[0]).map((h) => h.toLowerCase());
  const need = ['date', 'open', 'high', 'low', 'close', 'volume'];
  const idx: Record<string, number> = {};
  for (const n of need) {
    idx[n] = header.indexOf(n);
    if (idx[n] < 0) {
      res.errors.push(`ไม่พบคอลัมน์ ${n} (ต้องมี Date, Open, High, Low, Close, Volume)`);
    }
  }
  if (res.errors.length) return res;

  const raw: Bar[] = [];
  let dailyCount = 0;
  for (let r = 1; r < lines.length; r++) {
    const cells = splitLine(lines[r]);
    const d = parseDateCell(cells[idx.date] ?? '');
    const num = (k: string) => Number((cells[idx[k]] ?? '').replace(/_/g, ''));
    if (!d) {
      if (res.errors.length < 20) res.errors.push(`แถว ${r + 1}: รูปแบบวันที่ไม่ถูกต้อง "${cells[idx.date] ?? ''}"`);
      continue;
    }
    if (d.daily) dailyCount++;
    raw.push({ t: d.ts, o: num('open'), h: num('high'), l: num('low'), c: num('close'), v: num('volume') });
  }
  if (dailyCount && dailyCount !== raw.length) {
    res.errors.push('ไฟล์ผสมแถวรายวันกับแถวที่มีเวลา — กรุณาแยกไฟล์');
    return res;
  }
  res.timeframe = raw.length ? (dailyCount ? '1Day' : '1Min') : null;
  const norm = normalizeBars(raw);
  res.bars = norm.bars;
  res.duplicates = norm.stats.corrections + norm.stats.duplicates;
  if (norm.stats.invalid) res.errors.push(`ข้าม ${norm.stats.invalid} แถวที่ราคา/ปริมาณไม่ถูกต้อง (เช่น High < Low หรือค่าว่าง)`);
  return res;
}
