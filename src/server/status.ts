import type { MergeStats } from '@/core/aggregation';
import type { MarketStatus } from '@/core/market';
import type { Bar, SessionMode, Timeframe } from '@/core/types';
import type { ConnectionStatus, ProviderInfo } from './providers/types';

export type DataState = 'starting' | 'backfilling' | 'ok' | 'market-closed' | 'stale' | 'disconnected' | 'error';

/** สถานะที่ worker เขียนลง app_state('status') ทุกรอบ — UI อ่านไปแสดง (ไม่มี secret) */
export interface WorkerStatus {
  provider: ProviderInfo;
  providerReason: string;
  connection: ConnectionStatus & { since: number };
  market: MarketStatus;
  /** เวลาของแหล่งข้อมูล (Demo = เวลาจำลอง) */
  clockNow: number;
  /** เวลาจริงที่ได้รับข้อความล่าสุดจาก stream */
  lastMessageAt: number | null;
  /** เวลา (ของข้อมูล) ของแท่งนาที/trade ล่าสุด */
  lastDataTs: number | null;
  dataState: DataState;
  dataStateLabel: string;
  signalsPaused: boolean;
  pauseReason: string | null;
  session: SessionMode;
  strategyTimeframes: Timeframe[];
  strategyKey: string;
  symbols: string[];
  stats: MergeStats & { queueDropped: number; backfills: number; reconnects: number; lastBackfillAt: number | null; lastError: string | null };
  heartbeatAt: number;
  startedAt: number;
  uiRefreshMs: number;
}

export interface LiveSnapshot {
  symbol: string;
  lastPrice: number | null;
  lastTradeTs: number | null;
  /** แท่งนาทีที่กำลังก่อตัวจาก trade (ยังไม่ยืนยัน) */
  forming: Bar | null;
  updatedAt: number;
}

export const WORKER_DEAD_AFTER_MS = 10_000;
