import { NextResponse } from 'next/server';
import { runBacktest, runSplitBacktest } from '@/core/backtest';
import { mergeSettings, type PortfolioParams, type StrategyParams } from '@/core/config';
import { dailyBarTs } from '@/core/market';
import { isTimeframe } from '@/core/types';
import { activeDataset, bad, ctx, workerStatus } from '@/server/app';
import { normalizeSymbol } from '@/server/db';
import { graceFor, loadBars, splitClosed } from '@/server/data';

export const dynamic = 'force-dynamic';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const toTs = (s: unknown, endOfDay = false): number | undefined =>
  typeof s === 'string' && DATE.test(s) ? dailyBarTs(s) + (endOfDay ? 86_400_000 - 1 : 0) : undefined;

function checkParams(sp: StrategyParams, pp: PortfolioParams): string | null {
  const ints: [string, number, number, number][] = [
    ['breakoutLookback', sp.breakoutLookback, 1, 500],
    ['exitLookback', sp.exitLookback, 1, 500],
    ['maPeriod', sp.trend.maPeriod, 2, 500],
    ['slopeLookback', sp.trend.slopeLookback, 1, 500],
    ['atrPeriod', sp.trend.atrPeriod, 1, 500],
  ];
  for (const [n, v, lo, hi] of ints) if (!Number.isInteger(v) || v < lo || v > hi) return `${n} ต้องเป็นจำนวนเต็ม ${lo}-${hi}`;
  const nums: [string, number, number, number][] = [
    ['sidewaysMaxSlopeAtr', sp.trend.sidewaysMaxSlopeAtr, 0, 100],
    ['sidewaysMaxDistanceAtr', sp.trend.sidewaysMaxDistanceAtr, 0, 100],
    ['initialCash', pp.initialCash, 1, 1e12],
    ['allocationPct', pp.allocationPct, 0.01, 100],
    ['feePct', pp.feePct, 0, 10],
    ['feeFixed', pp.feeFixed, 0, 1e6],
    ['slippagePct', pp.slippagePct, 0, 10],
  ];
  for (const [n, v, lo, hi] of nums) if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) return `${n} ต้องอยู่ระหว่าง ${lo}-${hi}`;
  return null;
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body) return bad('ข้อมูลคำขอไม่ถูกต้อง');
  const symbol = normalizeSymbol(body.symbol);
  if (!symbol) return bad('ticker ไม่ถูกต้อง');
  if (!isTimeframe(body.tf)) return bad('timeframe ไม่ถูกต้อง');
  const { store, cfg } = ctx();
  const settings = mergeSettings(cfg.settings, { strategy: body.strategy, portfolio: body.portfolio });
  const err = checkParams(settings.strategy, settings.portfolio);
  if (err) return bad(err);
  settings.portfolio.fractional = body.portfolio?.fractional !== false;

  const dataset = typeof body.dataset === 'string' && body.dataset ? body.dataset : activeDataset(store);
  const known = store.listDatasets(symbol).filter((d) => d.dataset === dataset);
  if (!known.length) return bad(`ไม่พบข้อมูลของ ${symbol} ในชุดข้อมูล ${dataset}`);

  const from = toTs(body.from);
  const to = toTs(body.to, true);
  const split = toTs(body.split);
  const { session } = cfg.settings;
  let bars = loadBars(store, dataset, symbol, body.tf, session, { to });
  // ใช้เฉพาะแท่งที่ปิดแล้ว (ชุดข้อมูลสดอาจมีแท่งสุดท้ายที่ยังไม่ปิด)
  if (dataset === activeDataset(store)) {
    const now = workerStatus(store).status?.clockNow ?? Date.now();
    bars = splitClosed(bars, body.tf, now, session, graceFor(body.tf, cfg)).closed;
  }
  if (bars.length < 2) return bad(`ข้อมูลไม่เพียงพอ: มี ${bars.length} แท่ง (${body.tf}, session ${session})`);

  const opts = { strategy: settings.strategy, portfolio: settings.portfolio, startTs: from, endTs: to };
  const full = runBacktest(bars, opts);
  const splitResult = split !== undefined ? runSplitBacktest(bars, split, opts) : null;
  const meta = known[0];
  return NextResponse.json({
    symbol,
    tf: body.tf,
    dataset,
    datasetLabel: meta.label,
    adjustment: meta.adjustment,
    session,
    settings: { strategy: settings.strategy, portfolio: settings.portfolio },
    availableFrom: bars[0].t,
    availableTo: bars[bars.length - 1].t,
    full,
    split: splitResult,
  });
}
