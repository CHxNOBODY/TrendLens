/**
 * Backtest — ใช้ prepare/evaluateAt/step ชุดเดียวกับระบบติดตามสด
 * - indicator ที่แท่ง i ใช้ข้อมูลแท่ง 0..i เท่านั้น (ไม่มี look-ahead)
 * - สัญญาณเกิดที่ราคาปิด และ execute ที่ราคาเปิดแท่งถัดไป
 * - แท่งก่อน startTs ใช้เป็น warm-up ของ indicator เท่านั้น (ไม่ซื้อขาย)
 * - แท่งหลัง endTs ถูกตัดทิ้งก่อนคำนวณ (ไม่ให้ข้อมูลอนาคตเข้ามา)
 */
import type { PortfolioParams, StrategyParams } from './config';
import { computeBuy, computeSell, equityAt, initialState, step, type ClosedTrade, type Fill, type SignalEvent } from './engine';
import { prepare } from './strategy';
import type { Bar } from './types';

export interface EquityPoint {
  t: number;
  equity: number;
}

export interface Metrics {
  initialCash: number;
  finalEquity: number;
  totalReturnPct: number;
  maxDrawdownPct: number;
  closedTrades: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  grossProfit: number;
  grossLoss: number;
  /** null เมื่อไม่มีเทรดขาดทุน (หารด้วยศูนย์) หรือไม่มีเทรด */
  profitFactor: number | null;
  profitFactorNote: string | null;
}

export interface OpenPositionReport {
  qty: number;
  entryTs: number;
  entryPrice: number;
  entryFee: number;
  lastClose: number;
  lastTs: number;
  marketValue: number;
  unrealizedPnl: number;
  /** ประมาณการค่าใช้จ่ายถ้าปิดสถานะที่ราคาปิดล่าสุด (ไม่ได้หักใน equity) */
  estimatedExitCosts: number;
}

export interface BacktestResult {
  ok: true;
  bars: number;
  startTs: number;
  endTs: number;
  warmupBars: number;
  insufficientTrendBars: number;
  signals: SignalEvent[];
  fills: Fill[];
  trades: ClosedTrade[];
  openPosition: OpenPositionReport | null;
  pendingAtEnd: { kind: 'enter' | 'exit'; signalTs: number } | null;
  equity: EquityPoint[];
  metrics: Metrics;
  benchmark: {
    equity: EquityPoint[];
    metrics: Pick<Metrics, 'initialCash' | 'finalEquity' | 'totalReturnPct' | 'maxDrawdownPct'>;
    entryPrice: number;
    qty: number;
    entryFee: number;
    estimatedExitCosts: number;
  } | null;
  warnings: string[];
}

export interface BacktestError {
  ok: false;
  error: string;
}

export interface BacktestOptions {
  strategy: StrategyParams;
  portfolio: PortfolioParams;
  startTs?: number;
  endTs?: number;
}

export function maxDrawdownPct(points: EquityPoint[]): number {
  let peak = -Infinity;
  let mdd = 0;
  for (const p of points) {
    peak = Math.max(peak, p.equity);
    if (peak > 0) mdd = Math.max(mdd, (peak - p.equity) / peak);
  }
  return mdd * 100;
}

export function tradeMetrics(trades: ClosedTrade[]) {
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = -losses.reduce((s, t) => s + t.pnl, 0);
  let profitFactor: number | null = null;
  let profitFactorNote: string | null = null;
  if (trades.length === 0) profitFactorNote = 'ไม่มีเทรดที่ปิดแล้ว';
  else if (grossLoss === 0) profitFactorNote = 'ไม่มีเทรดขาดทุน — คำนวณ profit factor ไม่ได้ (หารด้วยศูนย์)';
  else profitFactor = grossProfit / grossLoss;
  return {
    closedTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: trades.length ? (wins.length / trades.length) * 100 : null,
    grossProfit,
    grossLoss,
    profitFactor,
    profitFactorNote,
  };
}

export function runBacktest(allBars: Bar[], opts: BacktestOptions): BacktestResult | BacktestError {
  const { strategy: sp, portfolio: pp } = opts;
  const endTs = opts.endTs ?? Infinity;
  const bars = allBars.filter((b) => b.t <= endTs);
  const startIdx = bars.findIndex((b) => b.t >= (opts.startTs ?? -Infinity));
  if (startIdx < 0 || bars.length - startIdx < 2) {
    return { ok: false, error: 'ข้อมูลไม่เพียงพอ: ต้องมีอย่างน้อย 2 แท่งในช่วงที่ทดสอบ' };
  }
  if (!(pp.initialCash > 0)) return { ok: false, error: 'เงินตั้งต้นต้องมากกว่า 0' };

  const prep = prepare(bars, sp);
  const state = initialState(pp);
  const signals: SignalEvent[] = [];
  const fills: Fill[] = [];
  const trades: ClosedTrade[] = [];
  const equity: EquityPoint[] = [];
  let insufficient = 0;

  for (let i = startIdx; i < bars.length; i++) {
    const r = step(prep, i, state, sp, pp);
    if (r.decision.trend.trend === 'insufficient') insufficient++;
    if (r.signal) signals.push(r.signal);
    if (r.fill) fills.push(r.fill);
    if (r.closedTrade) trades.push(r.closedTrade);
    equity.push({ t: bars[i].t, equity: equityAt(state, bars[i].c) });
  }

  const last = bars[bars.length - 1];
  let openPosition: OpenPositionReport | null = null;
  if (state.position) {
    const pos = state.position;
    const mv = pos.qty * last.c;
    const s = computeSell(pos.qty, last.c, pp);
    openPosition = {
      qty: pos.qty,
      entryTs: pos.entryTs,
      entryPrice: pos.entryPrice,
      entryFee: pos.entryFee,
      lastClose: last.c,
      lastTs: last.t,
      marketValue: mv,
      unrealizedPnl: mv - (pos.qty * pos.entryPrice + pos.entryFee),
      estimatedExitCosts: mv - (s.proceeds - s.fee),
    };
  }

  const finalEquity = equity[equity.length - 1].equity;
  const metrics: Metrics = {
    initialCash: pp.initialCash,
    finalEquity,
    totalReturnPct: (finalEquity / pp.initialCash - 1) * 100,
    maxDrawdownPct: maxDrawdownPct([{ t: bars[startIdx].t, equity: pp.initialCash }, ...equity]),
    ...tradeMetrics(trades),
  };

  // Buy-and-hold: ช่วงเวลาเดียวกัน, ซื้อที่ราคาเปิดแท่งแรกของช่วง, ต้นทุน/slippage/สัดส่วนเงินเดียวกัน
  let benchmark: BacktestResult['benchmark'] = null;
  const first = bars[startIdx];
  const buy = computeBuy(pp.initialCash, first.o, pp);
  if (buy) {
    const cashLeft = pp.initialCash - buy.cost - buy.fee;
    const beq = bars.slice(startIdx).map((b) => ({ t: b.t, equity: cashLeft + buy.qty * b.c }));
    const bFinal = beq[beq.length - 1].equity;
    const s = computeSell(buy.qty, last.c, pp);
    benchmark = {
      equity: beq,
      metrics: {
        initialCash: pp.initialCash,
        finalEquity: bFinal,
        totalReturnPct: (bFinal / pp.initialCash - 1) * 100,
        maxDrawdownPct: maxDrawdownPct([{ t: first.t, equity: pp.initialCash }, ...beq]),
      },
      entryPrice: buy.price,
      qty: buy.qty,
      entryFee: buy.fee,
      estimatedExitCosts: buy.qty * last.c - (s.proceeds - s.fee),
    };
  }

  const warnings: string[] = [];
  const tested = bars.length - startIdx;
  if (insufficient === tested) {
    warnings.push(`ข้อมูลไม่เพียงพอสำหรับคำนวณแนวโน้มตลอดช่วง (${tested} แท่ง) — ไม่มีโอกาสเกิดสัญญาณเข้า`);
  } else if (insufficient > 0) {
    warnings.push(`${insufficient} แท่งแรกของช่วงอยู่ใน warm-up (แนวโน้ม = ข้อมูลไม่เพียงพอ) จึงไม่มีสัญญาณเข้า`);
  }
  if (trades.length === 0 && !openPosition) warnings.push('ไม่มีเทรดเกิดขึ้นในช่วงนี้');
  if (state.pending) {
    warnings.push(
      `มีสัญญาณ${state.pending.kind === 'enter' ? 'เข้า' : 'ออก'}ที่แท่งสุดท้าย ซึ่งยัง execute ไม่ได้เพราะไม่มีแท่งถัดไปในช่วงทดสอบ`,
    );
  }

  return {
    ok: true,
    bars: tested,
    startTs: bars[startIdx].t,
    endTs: last.t,
    warmupBars: startIdx,
    insufficientTrendBars: insufficient,
    signals,
    fills,
    trades,
    openPosition,
    pendingAtEnd: state.pending,
    equity,
    metrics,
    benchmark,
    warnings,
  };
}

export interface SplitBacktest {
  inSample: BacktestResult | BacktestError;
  outOfSample: BacktestResult | BacktestError;
}

/**
 * แยกช่วงพัฒนากติกา (in-sample) กับช่วงทดสอบนอกตัวอย่าง (out-of-sample)
 * แต่ละช่วงเริ่มด้วยเงินตั้งต้นใหม่ ช่วง OOS ใช้แท่งก่อนหน้าเป็น warm-up ของ indicator ได้
 * (เป็นข้อมูลในอดีต ไม่ใช่ข้อมูลอนาคต) แต่ไม่ถือสถานะข้ามช่วง
 */
export function runSplitBacktest(bars: Bar[], splitTs: number, opts: BacktestOptions): SplitBacktest {
  return {
    inSample: runBacktest(bars, { ...opts, endTs: Math.min(splitTs - 1, opts.endTs ?? Infinity) }),
    outOfSample: runBacktest(bars, { ...opts, startTs: Math.max(splitTs, opts.startTs ?? -Infinity) }),
  };
}
