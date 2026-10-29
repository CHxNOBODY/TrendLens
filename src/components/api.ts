'use client';

import { useEffect, useRef } from 'react';
import type { Decision } from '@/core/strategy';
import type { TrendResult } from '@/core/trend';
import type { Bar, Timeframe } from '@/core/types';
import type { MarketStatus } from '@/core/market';
import type { StoredSignal } from '@/server/db';
import type { ProviderInfo } from '@/server/providers/types';
import type { WorkerStatus } from '@/server/status';

export interface StatusResponse {
  status: WorkerStatus | null;
  workerAlive: boolean;
  serverNow: number;
  watchlist: string[];
  config: { uiRefreshMs: number; session: string; strategyTimeframes: Timeframe[]; strategy: unknown; portfolio: unknown };
}

export type TrendInfo = (TrendResult & { asOf: number | null; bars: number; warmup?: number }) | { trend: 'insufficient'; label: string; reasons: string[]; values: null; asOf: null; bars: 0 };

export interface ChartResponse {
  symbol: string;
  tf: Timeframe;
  dataset: string;
  session: string;
  workerAlive: boolean;
  provider: ProviderInfo | null;
  dataState: string | null;
  dataStateLabel: string | null;
  signalsPaused: boolean;
  pauseReason: string | null;
  market: MarketStatus;
  clockNow: number;
  bars: Bar[];
  totalBars: number;
  hasForming: boolean;
  header: { lastPrice: number | null; lastTs: number | null; prevClose: number | null; change: number | null; changePct: number | null; refDailyTs: number | null };
  trends: Record<Timeframe, TrendInfo>;
  tracked: boolean;
  inPosition: boolean;
  position: { qty: number; entryTs: number; entryPrice: number } | null;
  pendingOrder: { kind: 'enter' | 'exit'; signalTs: number } | null;
  decision: Decision | null;
  preview: (Decision & { pending: true }) | null;
  signals: StoredSignal[];
}

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: 'no-store', ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
  return json as T;
}

/** เรียก fn ทุก ms มิลลิวินาที (ไม่ซ้อนกันถ้ารอบก่อนยังไม่เสร็จ) */
export function useInterval(fn: () => Promise<void> | void, ms: number | null) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (ms === null) return;
    let busy = false;
    const id = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        await ref.current();
      } finally {
        busy = false;
      }
    }, ms);
    return () => clearInterval(id);
  }, [ms]);
}

export const fmtPrice = (n: number | null | undefined, d = 2) => (n === null || n === undefined || !Number.isFinite(n) ? '-' : n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
export const fmtPct = (n: number | null | undefined, d = 2) => (n === null || n === undefined || !Number.isFinite(n) ? '-' : `${n >= 0 ? '+' : ''}${n.toFixed(d)}%`);
export const fmtMoney = (n: number | null | undefined) => (n === null || n === undefined || !Number.isFinite(n) ? '-' : `$${fmtPrice(n)}`);

export const TF_LABEL: Record<Timeframe, string> = { '1Min': '1 นาที', '5Min': '5 นาที', '1Day': 'รายวัน' };
