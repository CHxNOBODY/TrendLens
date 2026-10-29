import type { Bar, BaseTimeframe, FeedMode } from '@/core/types';

/** ข้อมูลที่ UI ต้องแสดงเกี่ยวกับแหล่งข้อมูล — ห้ามมี secret */
export interface ProviderInfo {
  id: 'demo' | 'alpaca';
  /** key ของชุดข้อมูลในฐานข้อมูล (ไม่ผสมข้อมูลต่างแหล่ง/ต่างวิธีปรับราคา) */
  dataset: string;
  displayName: string;
  feed: string;
  mode: FeedMode;
  coverage: string;
  delayMinutes: number;
  adjustment: string;
  notes: string[];
  virtualClock: boolean;
}

export type ConnectionState = 'connecting' | 'authenticating' | 'connected' | 'reconnecting' | 'disconnected' | 'error';

export interface ConnectionStatus {
  state: ConnectionState;
  attempt?: number;
  nextRetryAt?: number;
  message?: string;
  /** true เมื่อเพิ่งเชื่อมต่อใหม่หลังหลุด → worker ต้อง backfill ช่วงที่ขาด */
  reconnected?: boolean;
}

export type StreamEvent =
  | { type: 'minuteBar'; symbol: string; bar: Bar; corrected: boolean }
  | { type: 'dailyBar'; symbol: string; bar: Bar }
  | { type: 'trade'; symbol: string; price: number; size: number; ts: number };

export interface StreamHandlers {
  onEvent(e: StreamEvent): void;
  onStatus(s: ConnectionStatus): void;
}

export interface StreamConnection {
  setSymbols(symbols: string[]): void;
  close(): void;
}

/** Data Provider interface — เปลี่ยนผู้ให้บริการได้โดยไม่แก้ worker/UI */
export interface DataProvider {
  readonly info: ProviderInfo;
  /** เวลาปัจจุบันของแหล่งข้อมูล (Demo ใช้นาฬิกาจำลอง) */
  now(): number;
  /** ข้อมูลย้อนหลัง [start, end] — แท่งรายวันต้อง normalize เป็น Date.UTC ของวันที่ซื้อขาย */
  fetchBars(symbols: string[], tf: BaseTimeframe, start: number, end: number): Promise<Map<string, Bar[]>>;
  connect(symbols: string[], handlers: StreamHandlers): StreamConnection;
  /** เรียกทุกรอบของ worker (Demo ใช้สร้างข้อมูลสด) */
  tick?(): void;
}
