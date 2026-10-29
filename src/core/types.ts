/** เวลาทั้งหมดเก็บเป็น epoch milliseconds (UTC) */
export interface Bar {
  t: number; // เวลาเริ่มแท่ง (UTC ms). แท่งรายวันใช้ Date.UTC(ปี, เดือน, วัน) ของวันซื้อขายตามเวลานิวยอร์ก
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export type Timeframe = '1Min' | '5Min' | '1Day';
/** timeframe ที่เก็บจริงในฐานข้อมูล (5Min สร้างจาก 1Min) */
export type BaseTimeframe = '1Min' | '1Day';
export const TIMEFRAMES: Timeframe[] = ['1Min', '5Min', '1Day'];

export type SessionMode = 'regular' | 'extended';

export type Trend = 'up' | 'down' | 'sideways' | 'unclear' | 'insufficient';

export type FeedMode = 'live' | 'delayed' | 'demo' | 'csv';

export const TIMEFRAME_MS: Record<Exclude<Timeframe, '1Day'>, number> = {
  '1Min': 60_000,
  '5Min': 300_000,
};

export function isTimeframe(x: unknown): x is Timeframe {
  return x === '1Min' || x === '5Min' || x === '1Day';
}
