import { describe, expect, it } from 'vitest';
import { runBacktest } from '@/core/backtest';
import { DEFAULT_SETTINGS } from '@/core/config';
import { nyDateKey, sessionWindow } from '@/core/market';
import { Store, openDb } from '@/server/db';
import type { ServerConfig } from '@/server/env';
import { LiveRunner } from '@/server/live/runner';
import { processClosedBars, strategyKey } from '@/server/live/tracker';
import { alpacaInfo, toBar } from '@/server/providers/alpaca';
import { DemoMarket, DemoProvider, normalizeToSession, parseNyLocal } from '@/server/providers/demo';
import { BoundedQueue, backoffDelay } from '@/server/stream';
import { SP, barsFromCloses, range } from './helpers';

const PP = { initialCash: 1000, allocationPct: 100, feePct: 0.1, feeFixed: 0, slippagePct: 0.05, fractional: true };
const K = { dataset: 'test', symbol: 'AAPL', tf: '5Min' as const };

function memStore() {
  return new Store(openDb(':memory:'));
}

describe('การป้องกันสัญญาณซ้ำ (live tracker)', () => {
  const bars = barsFromCloses([...range(1, 15), 12, 11, 11, 11, 11]);

  it('ประมวลผลชุดเดิมซ้ำไม่สร้างสัญญาณซ้ำ', () => {
    const store = memStore();
    const r1 = processClosedBars(store, K, bars, SP, PP);
    expect(r1.newSignals).toBe(2);
    expect(r1.origin).toBe('backfill');
    const r2 = processClosedBars(store, K, bars, SP, PP);
    expect(r2.processed).toBe(0);
    expect(store.listSignals({ dataset: 'test' })).toHaveLength(2);
  });

  it('แม้ state หาย (เช่นเปลี่ยนเครื่อง) unique key กันสัญญาณซ้ำในฐานข้อมูล', () => {
    const store = memStore();
    processClosedBars(store, K, bars, SP, PP);
    store.db.prepare('DELETE FROM engine_state').run();
    processClosedBars(store, K, bars, SP, PP);
    expect(store.listSignals({ dataset: 'test' })).toHaveLength(2);
  });

  it('ประมวลผลทีละแท่ง (สด) ได้ผลเท่ากับ backtest — ใช้ logic เดียวกัน', () => {
    const store = memStore();
    for (let n = 3; n <= bars.length; n++) processClosedBars(store, K, bars.slice(0, n), SP, PP);
    const live = store.listSignals({ dataset: 'test' }).reverse();
    const bt = runBacktest(bars, { strategy: SP, portfolio: PP });
    if (!bt.ok) throw new Error(bt.error);
    expect(live.map((s) => [s.barTs, s.kind])).toEqual(bt.signals.map((s) => [s.barTs, s.kind]));
    expect(live.map((s) => s.origin)).toEqual(['live', 'live']);
    const pos = store.listPositions({ dataset: 'test' });
    expect(pos).toHaveLength(1);
    expect(pos[0].status).toBe('closed');
    expect(pos[0].pnl).toBeCloseTo(bt.trades[0].pnl);
  });

  it('strategy key เปลี่ยนเมื่อพารามิเตอร์เปลี่ยน', () => {
    expect(strategyKey(SP, PP)).not.toBe(strategyKey({ ...SP, breakoutLookback: 4 }, PP));
  });
});

describe('Demo Mode', () => {
  it('ข้อมูลทำซ้ำได้ (deterministic) และอยู่ใน regular session', () => {
    const a = new DemoMarket().day('AAPL', '2026-10-01')!;
    const b = new DemoMarket().day('AAPL', '2026-10-01')!;
    expect(a.minutes).toEqual(b.minutes);
    expect(a.minutes).toHaveLength(390);
    expect(a.minutes[0].t).toBe(sessionWindow('2026-10-01', 'regular')!.open);
    expect(new DemoMarket().day('AAPL', '2026-10-03')).toBeNull(); // วันเสาร์
  });

  it('แท่งรายวันสอดคล้องกับแท่งนาที และไม่คืนข้อมูลอนาคต', () => {
    const m = new DemoMarket();
    const w = sessionWindow('2026-10-01', 'regular')!;
    const mid = w.open + 30 * 60_000;
    const mins = m.minuteBars('MSFT', w.open, w.close, mid);
    expect(mins).toHaveLength(30);
    const d = m.dailyBar('MSFT', '2026-10-01', mid)!;
    expect(d.c).toBe(mins[29].c);
    expect(d.h).toBe(Math.max(...mins.map((x) => x.h)));
  });

  it('นาฬิกาจำลองข้ามช่วงตลาดปิด', () => {
    const fri = parseNyLocal('2026-10-02T16:30');
    expect(nyDateKey(normalizeToSession(fri))).toBe('2026-10-05');
  });
});

describe('stream utilities', () => {
  it('BoundedQueue ทิ้งรายการเก่าสุดเมื่อเต็มและนับจำนวน', () => {
    const q = new BoundedQueue<number>(3);
    [1, 2, 3, 4, 5].forEach((x) => q.push(x));
    expect(q.dropped).toBe(2);
    expect(q.drain()).toEqual([3, 4, 5]);
    expect(q.length).toBe(0);
  });
  it('exponential backoff เพิ่มเป็นเท่าตัวและมีเพดาน', () => {
    const o = { baseMs: 1000, maxMs: 8000, jitter: 0 };
    expect([1, 2, 3, 4, 5, 6].map((a) => backoffDelay(a, o))).toEqual([1000, 2000, 4000, 8000, 8000, 8000]);
    const j = backoffDelay(1, { ...o, jitter: 0.2 }, () => 1);
    expect(j).toBe(1200);
  });
});

describe('Alpaca (ไม่ต้องใช้ API key)', () => {
  it('ป้ายกำกับ feed: delayed_sip ไม่ถูกเรียกว่า live', () => {
    expect(alpacaInfo('delayed_sip', 'split').mode).toBe('delayed');
    expect(alpacaInfo('iex', 'split').mode).toBe('live');
    expect(alpacaInfo('iex', 'split').coverage).toContain('IEX');
    expect(alpacaInfo('sip', 'all').dataset).toBe('alpaca-sip-all');
  });
  it('แท่งรายวัน (เที่ยงคืน ET) normalize เป็นวันที่ซื้อขาย', () => {
    expect(toBar({ t: '2026-10-01T04:00:00Z', o: 1, h: 1, l: 1, c: 1, v: 1 }, '1Day').t).toBe(Date.UTC(2026, 9, 1));
    expect(toBar({ t: '2026-12-01T05:00:00Z', o: 1, h: 1, l: 1, c: 1, v: 1 }, '1Day').t).toBe(Date.UTC(2026, 11, 1));
  });
});

describe('LiveRunner + Demo (จำลองเวลาจริง)', () => {
  function setup(dropEverySec = 0) {
    let real = 1_000_000;
    const realNow = () => real;
    const cfg: ServerConfig = {
      dbPath: ':memory:',
      provider: 'demo',
      alpaca: { keyId: '', secretKey: '', feed: 'iex', adjustment: 'split' },
      uiRefreshMs: 2000,
      workerTickMs: 1000,
      staleAfterSec: 120,
      closeGraceSec: 15,
      dailyCloseGraceMin: 20,
      intradayHistoryDays: 5,
      dailyHistoryDays: 120,
      queueCapacity: 10_000,
      demo: { start: '2026-10-01T10:00', speed: 60, dropEverySec },
      settings: { ...DEFAULT_SETTINGS },
    };
    const store = memStore();
    store.db.prepare("INSERT INTO app_state (key,json,updated_at) VALUES ('watchlist_seeded','true',0)").run();
    store.addToWatchlist('AAPL');
    const provider = new DemoProvider({ start: parseNyLocal(cfg.demo.start), speed: 60, dropEverySec, realNow });
    const runner = new LiveRunner(cfg, store, provider, 'test', () => {}, realNow);
    return { store, provider, runner, advance: (ms: number) => (real += ms) };
  }

  it('backfill → stream → แท่ง 5 นาทีปิด → บันทึกสัญญาณ/สถานะ โดยไม่ซ้ำ', async () => {
    const { store, runner, advance } = setup();
    await runner.start(false);
    const before = store.countBars('demo', 'AAPL', '1Min').n;
    expect(before).toBeGreaterThan(390 * 3);
    for (let i = 0; i < 40; i++) {
      advance(1000); // 1 วินาทีจริง = 60 วินาทีจำลอง
      await runner.loop();
    }
    const st = runner.getStatus();
    expect(st.dataState).toBe('ok');
    expect(st.signalsPaused).toBe(false);
    expect(store.countBars('demo', 'AAPL', '1Min').n).toBeGreaterThanOrEqual(before + 38);
    const state = store.listEngineStates<{ sim: { lastBarTs: number } }>('tracker|demo|AAPL|5Min');
    expect(state).toHaveLength(1);
    // แท่ง 5 นาทีล่าสุดที่ประมวลผลต้องปิดแล้ว ณ เวลาจำลอง
    expect(state[0].value.sim.lastBarTs + 300_000 + 15_000).toBeLessThanOrEqual(st.clockNow);
    const n = store.listSignals({ dataset: 'demo' }).length;
    await runner.loop();
    expect(store.listSignals({ dataset: 'demo' }).length).toBe(n);
  });

  it('หลุดการเชื่อมต่อ → พักสัญญาณ → reconnect → backfill เติมช่วงที่ขาดครบ', async () => {
    const { store, runner, advance, provider } = setup(10);
    await runner.start(false);
    let sawPaused = false;
    // หลุดที่วินาทีจริง ~10–25 แล้วเชื่อมต่อใหม่ (หลุดครั้งถัดไป ~35) → จบที่ 30 วินาทีขณะเชื่อมต่ออยู่
    for (let i = 0; i < 30; i++) {
      advance(1000);
      await runner.loop();
      if (runner.getStatus().connection.state === 'reconnecting') {
        sawPaused ||= runner.getStatus().signalsPaused;
      }
    }
    expect(sawPaused).toBe(true);
    expect(runner.getStatus().stats.reconnects).toBeGreaterThanOrEqual(1);
    expect(runner.getStatus().connection.state).toBe('connected');
    expect(runner.getStatus().stats.backfills).toBeGreaterThanOrEqual(2);
    // ไม่มีนาทีขาดหายใน session ของวันจำลอง
    const now = provider.now();
    const w = sessionWindow(nyDateKey(now), 'regular')!;
    const mins = store.getBars('demo', 'AAPL', '1Min', { from: w.open });
    const expected = Math.floor((now - w.open) / 60_000);
    expect(mins.length).toBeGreaterThanOrEqual(expected - 1);
  });
});
