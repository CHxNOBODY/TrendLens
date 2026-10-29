/**
 * ตัวจำลองสถานะที่ใช้ร่วมกันระหว่าง backtest และการติดตามสด (paper tracking)
 *
 * ลำดับเหตุการณ์ในแต่ละแท่ง i:
 *   1) ถ้ามีคำสั่งค้าง (จากสัญญาณที่ปิดแท่ง i-1) → execute ที่ราคาเปิดของแท่ง i (+slippage, +ค่าธรรมเนียม)
 *   2) ประเมินกติกาที่ราคาปิดของแท่ง i → ถ้าเกิดสัญญาณ บันทึก SignalEvent และตั้งคำสั่งค้างไว้สำหรับแท่งถัดไป
 * สัญญาณ (SignalEvent) และการ execute (Fill) แยกจากกันชัดเจน
 */
import type { PortfolioParams, StrategyParams } from './config';
import { evaluateAt, type Decision, type PreparedSeries } from './strategy';

export interface OpenPosition {
  qty: number;
  entryTs: number;
  entryPrice: number; // ราคาหลัง slippage
  entryFee: number;
  entrySignalTs: number;
}

export interface SimState {
  cash: number;
  position: OpenPosition | null;
  pending: { kind: 'enter' | 'exit'; signalTs: number } | null;
  lastBarTs: number | null;
}

export interface SignalEvent {
  kind: 'enter' | 'exit';
  barTs: number;
  close: number;
  reasons: string[];
  values: Decision['values'];
  trend: string;
}

export interface Fill {
  kind: 'buy' | 'sell' | 'skipped';
  ts: number;
  signalTs: number;
  rawPrice: number; // ราคาเปิดก่อน slippage
  price: number;
  qty: number;
  fee: number;
  cashAfter: number;
  note?: string;
}

export interface ClosedTrade {
  entrySignalTs: number;
  entryTs: number;
  entryPrice: number;
  entryFee: number;
  exitSignalTs: number;
  exitTs: number;
  exitPrice: number;
  exitFee: number;
  qty: number;
  pnl: number;
  returnPct: number;
}

export interface StepResult {
  decision: Decision;
  signal: SignalEvent | null;
  fill: Fill | null;
  closedTrade: ClosedTrade | null;
}

export function initialState(p: PortfolioParams): SimState {
  return { cash: p.initialCash, position: null, pending: null, lastBarTs: null };
}

const roundDown = (x: number, decimals: number) => {
  const m = 10 ** decimals;
  return Math.floor(x * m + 1e-9) / m;
}

/** คำนวณการซื้อ: ไม่ใช้ leverage, เงินสดไม่ติดลบ */
export function computeBuy(cash: number, rawPrice: number, p: PortfolioParams) {
  const price = rawPrice * (1 + p.slippagePct / 100);
  const budget = cash * Math.min(Math.max(p.allocationPct, 0), 100) / 100;
  let qty = (budget - p.feeFixed) / (price * (1 + p.feePct / 100));
  qty = p.fractional ? roundDown(qty, 6) : Math.floor(qty);
  if (!(qty > 0)) return null;
  const cost = qty * price;
  const fee = cost * (p.feePct / 100) + p.feeFixed;
  if (cost + fee > cash + 1e-9) return null;
  return { price, qty, cost, fee };
}

/** คำนวณการขายทั้งหมด — ค่าธรรมเนียมไม่เกินมูลค่าที่ขายได้ เพื่อไม่ให้เงินสดติดลบ */
export function computeSell(qty: number, rawPrice: number, p: PortfolioParams) {
  const price = rawPrice * (1 - p.slippagePct / 100);
  const proceeds = qty * price;
  const fee = Math.min(proceeds * (p.feePct / 100) + p.feeFixed, proceeds);
  return { price, proceeds, fee };
}

export function step(
  prep: PreparedSeries,
  i: number,
  state: SimState,
  sp: StrategyParams,
  pp: PortfolioParams,
): StepResult {
  const bar = prep.bars[i];
  if (state.lastBarTs !== null && bar.t <= state.lastBarTs) {
    throw new Error(`step() ต้องเรียงตามเวลา: bar ${bar.t} <= lastBarTs ${state.lastBarTs}`);
  }
  let fill: Fill | null = null;
  let closedTrade: ClosedTrade | null = null;

  // 1) execute คำสั่งค้างที่ราคาเปิดของแท่งนี้
  if (state.pending) {
    const pend = state.pending;
    state.pending = null;
    if (pend.kind === 'enter' && !state.position) {
      const b = computeBuy(state.cash, bar.o, pp);
      if (!b) {
        fill = { kind: 'skipped', ts: bar.t, signalTs: pend.signalTs, rawPrice: bar.o, price: bar.o, qty: 0, fee: 0, cashAfter: state.cash, note: 'เงินสดไม่พอสำหรับการซื้อ' };
      } else {
        state.cash = Math.max(0, state.cash - b.cost - b.fee);
        state.position = { qty: b.qty, entryTs: bar.t, entryPrice: b.price, entryFee: b.fee, entrySignalTs: pend.signalTs };
        fill = { kind: 'buy', ts: bar.t, signalTs: pend.signalTs, rawPrice: bar.o, price: b.price, qty: b.qty, fee: b.fee, cashAfter: state.cash };
      }
    } else if (pend.kind === 'exit' && state.position) {
      const pos = state.position;
      const s = computeSell(pos.qty, bar.o, pp);
      state.cash += s.proceeds - s.fee;
      const invested = pos.qty * pos.entryPrice + pos.entryFee;
      const pnl = s.proceeds - s.fee - invested;
      closedTrade = {
        entrySignalTs: pos.entrySignalTs,
        entryTs: pos.entryTs,
        entryPrice: pos.entryPrice,
        entryFee: pos.entryFee,
        exitSignalTs: pend.signalTs,
        exitTs: bar.t,
        exitPrice: s.price,
        exitFee: s.fee,
        qty: pos.qty,
        pnl,
        returnPct: invested > 0 ? (pnl / invested) * 100 : 0,
      };
      state.position = null;
      fill = { kind: 'sell', ts: bar.t, signalTs: pend.signalTs, rawPrice: bar.o, price: s.price, qty: pos.qty, fee: s.fee, cashAfter: state.cash };
    }
  }

  // 2) ประเมินสัญญาณที่ราคาปิด
  const decision = evaluateAt(prep, i, state.position !== null, sp);
  let signal: SignalEvent | null = null;
  if (decision.action !== 'wait') {
    signal = {
      kind: decision.action,
      barTs: bar.t,
      close: bar.c,
      reasons: decision.reasons,
      values: decision.values,
      trend: decision.trend.trend,
    };
    state.pending = { kind: decision.action, signalTs: bar.t };
  }
  state.lastBarTs = bar.t;
  return { decision, signal, fill, closedTrade };
}

export function equityAt(state: SimState, close: number): number {
  return state.cash + (state.position ? state.position.qty * close : 0);
}
