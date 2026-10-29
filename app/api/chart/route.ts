import { NextResponse } from 'next/server';
import { trendWarmupBars } from '@/core/config';
import { isInSession, marketStatus } from '@/core/market';
import { evaluateAt, prepare, previewForming } from '@/core/strategy';
import { classifyTrendAt } from '@/core/trend';
import { TIMEFRAMES, isTimeframe, type Bar, type Timeframe } from '@/core/types';
import { activeDataset, bad, ctx, workerStatus } from '@/server/app';
import { normalizeSymbol } from '@/server/db';
import { graceFor, loadBars, splitClosed } from '@/server/data';
import { getTrackerState, strategyKey } from '@/server/live/tracker';
import type { LiveSnapshot } from '@/server/status';

export const dynamic = 'force-dynamic';

/** วันย้อนหลังขั้นต่ำสำหรับประเมินแนวโน้มของแต่ละ timeframe (ต้องมีแท่ง ≥ warm-up) */
const TREND_DAYS: Record<Timeframe, number> = { '1Min': 3, '5Min': 7, '1Day': 200 };

function mergeForming(bars: Bar[], forming: Bar, tf: Timeframe): Bar[] {
  if (tf === '1Day') return bars;
  const size = tf === '5Min' ? 300_000 : 60_000;
  const t = Math.floor(forming.t / size) * size;
  const last = bars[bars.length - 1];
  if (last && t < last.t) return bars;
  if (last && last.t === t) {
    // 1 นาที: แท่งนาทีนี้ยืนยันแล้วในฐานข้อมูล; 5 นาที: รวมนาทีที่กำลังก่อตัวเข้า bucket ปัจจุบัน
    if (tf === '1Min') return bars;
    const merged = { ...last, h: Math.max(last.h, forming.h), l: Math.min(last.l, forming.l), c: forming.c, v: last.v + forming.v };
    return [...bars.slice(0, -1), merged];
  }
  return [...bars, { ...forming, t }];
}

export function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const symbol = normalizeSymbol(q.get('symbol'));
  const tf = q.get('tf') ?? '5Min';
  if (!symbol) return bad('ticker ไม่ถูกต้อง');
  if (!isTimeframe(tf)) return bad('timeframe ไม่ถูกต้อง');
  const days = Math.min(Math.max(Number(q.get('days')) || 5, 1), 4000);
  const since = q.get('since') ? Number(q.get('since')) : null;

  const { store, cfg } = ctx();
  const { status, workerAlive } = workerStatus(store);
  const dataset = activeDataset(store);
  const { session, strategy, portfolio, strategyTimeframes } = cfg.settings;
  const now = status?.clockNow ?? Date.now();
  const snap = store.getState<LiveSnapshot>(`live:${dataset}:${symbol}`);

  // ---- แท่งสำหรับกราฟ (session เดียวกับกลยุทธ์) ----
  let bars = loadBars(store, dataset, symbol, tf, session, { days });
  const grace = graceFor(tf, cfg);
  const { closed, forming: formingFromDb } = splitClosed(bars, tf, now, session, grace);
  let hasForming = !!formingFromDb;
  if (snap?.forming && isInSession(snap.forming.t, session)) {
    const merged = mergeForming(bars, snap.forming, tf);
    if (merged !== bars) {
      bars = merged;
      hasForming = true;
    }
  }

  // ---- แนวโน้มแยกตาม timeframe (ใช้เฉพาะแท่งที่ปิดแล้ว) ----
  const trends: Record<string, unknown> = {};
  for (const t of TIMEFRAMES) {
    const tb = t === tf && days >= TREND_DAYS[t] ? closed : splitClosed(loadBars(store, dataset, symbol, t, session, { days: TREND_DAYS[t] }), t, now, session, graceFor(t, cfg)).closed;
    if (!tb.length) {
      trends[t] = { trend: 'insufficient', label: 'ข้อมูลไม่เพียงพอ', reasons: ['ยังไม่มีข้อมูล'], values: null, asOf: null, bars: 0 };
      continue;
    }
    const r = classifyTrendAt(tb, tb.length - 1, strategy.trend);
    trends[t] = { ...r, asOf: tb[tb.length - 1].t, bars: tb.length, warmup: trendWarmupBars(strategy.trend) };
  }

  // ---- การตัดสินใจล่าสุด (ยืนยันจากแท่งปิด) และ preview ระหว่างแท่ง ("รอยืนยัน") ----
  const tracked = strategyTimeframes.includes(tf);
  const tracker = tracked ? getTrackerState(store, dataset, symbol, tf, strategy, portfolio) : null;
  const inPosition = !!tracker?.sim.position;
  const decisionBars = closed.length >= trendWarmupBars(strategy.trend) + 5 ? closed : splitClosed(loadBars(store, dataset, symbol, tf, session, { days: TREND_DAYS[tf] }), tf, now, session, grace).closed;
  const decision = decisionBars.length ? evaluateAt(prepare(decisionBars, strategy), decisionBars.length - 1, inPosition, strategy) : null;
  const formingBar = hasForming ? bars[bars.length - 1] : null;
  const preview = formingBar && decisionBars.length ? previewForming(decisionBars, formingBar, inPosition, strategy) : null;

  // ---- ราคาล่าสุดและการเปลี่ยนแปลงรายวัน ----
  const daily = store.getBars(dataset, symbol, '1Day', { limit: 2 });
  const lastBar = bars[bars.length - 1];
  const lastPrice = snap?.lastPrice ?? lastBar?.c ?? null;
  const lastTs = snap?.lastTradeTs ?? (lastBar ? lastBar.t : null);
  const refDaily = daily.length ? daily[daily.length - 1] : null;
  const prevClose = daily.length >= 2 ? daily[daily.length - 2].c : null;
  const change = lastPrice !== null && prevClose !== null ? lastPrice - prevClose : null;

  const sKey = strategyKey(strategy, portfolio);
  const fromTs = bars.length ? bars[0].t : undefined;
  const signals = tracked ? store.listSignals({ dataset, symbol, tf, strategyKey: sKey, from: fromTs, limit: 1000 }) : [];

  return NextResponse.json({
    symbol,
    tf,
    dataset,
    session,
    workerAlive,
    provider: status?.provider ?? null,
    dataState: status?.dataState ?? null,
    dataStateLabel: status?.dataStateLabel ?? null,
    signalsPaused: status?.signalsPaused ?? true,
    pauseReason: status?.pauseReason ?? null,
    market: marketStatus(now),
    clockNow: now,
    bars: since !== null ? bars.filter((b) => b.t >= since) : bars,
    totalBars: bars.length,
    hasForming,
    header: { lastPrice, lastTs, prevClose, change, changePct: change !== null && prevClose ? (change / prevClose) * 100 : null, refDailyTs: refDaily?.t ?? null },
    trends,
    tracked,
    inPosition,
    position: tracker?.sim.position ?? null,
    pendingOrder: tracker?.sim.pending ?? null,
    decision,
    preview,
    signals,
  });
}
