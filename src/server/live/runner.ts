/**
 * Worker หลัก: รับ stream → queue → บันทึกแท่ง → ประเมินสัญญาณจากแท่งที่ปิดแล้ว → เขียนสถานะให้ UI
 * - สร้าง connection ครั้งเดียว (ไม่ผูกกับการ refresh หน้าจอ)
 * - หลัง reconnect หรือ queue ล้น → backfill ผ่าน REST ก่อน แล้วค่อยประเมินสัญญาณต่อ
 * - พักการสร้างสัญญาณใหม่เมื่อข้อมูลไม่พร้อม (หลุด, ค้าง, กำลัง backfill)
 */
import { MinuteBarBuilder, emptyStats, type MergeStats } from '@/core/aggregation';
import { marketStatus } from '@/core/market';
import type { Bar, Timeframe } from '@/core/types';
import type { Store } from '../db';
import { graceFor, loadBars, splitClosed } from '../data';
import type { ServerConfig } from '../env';
import type { DataProvider, StreamConnection, StreamEvent } from '../providers/types';
import type { DataState, LiveSnapshot, WorkerStatus } from '../status';
import { BoundedQueue } from '../stream';
import { processClosedBars, strategyKey } from './tracker';

const DAY = 86_400_000;
const TF_MS: Record<Timeframe, number> = { '1Min': 60_000, '5Min': 300_000, '1Day': DAY };

const DATA_STATE_LABEL: Record<DataState, string> = {
  starting: 'กำลังเริ่มต้น',
  backfilling: 'กำลังดึงข้อมูลย้อนหลังเติมช่วงที่ขาด',
  ok: 'ข้อมูลพร้อม',
  'market-closed': 'ตลาดปิด (ไม่ใช่ข้อมูลค้าง)',
  stale: 'ข้อมูลค้าง — ไม่ได้รับข้อมูลใหม่ทั้งที่ตลาดเปิด',
  disconnected: 'การเชื่อมต่อหลุด',
  error: 'เกิดข้อผิดพลาดกับ provider',
};

type Log = (msg: string) => void;

export class LiveRunner {
  private queue: BoundedQueue<StreamEvent>;
  private builder = new MinuteBarBuilder();
  private snapshots = new Map<string, LiveSnapshot>();
  private stream: StreamConnection | null = null;
  private symbols: string[] = [];
  private status: WorkerStatus;
  private needsBackfill = false;
  /** แท่งนาทีล่าสุดที่มีก่อนเกิดช่วงขาด (บันทึกตอนหลุด/queue ล้น) → backfill เริ่มจากตรงนี้ */
  private gapFrom = new Map<string, number | null>();
  private pendingNewSymbols = new Set<string>();
  private backfilling = false;
  private backfillRetryAt = 0;
  private dirty = new Set<string>();
  private lastCutoff = new Map<string, number>();
  private lastWatchlistCheck = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private sKey: string;

  constructor(
    private cfg: ServerConfig,
    private store: Store,
    private provider: DataProvider,
    providerReason: string,
    private log: Log = (m) => console.log(`[worker] ${m}`),
    private realNow: () => number = Date.now,
  ) {
    this.queue = new BoundedQueue(cfg.queueCapacity);
    this.sKey = strategyKey(cfg.settings.strategy, cfg.settings.portfolio);
    const now = provider.now();
    this.status = {
      provider: provider.info,
      providerReason,
      connection: { state: 'connecting', since: realNow() },
      market: marketStatus(now),
      clockNow: now,
      lastMessageAt: null,
      lastDataTs: null,
      dataState: 'starting',
      dataStateLabel: DATA_STATE_LABEL.starting,
      signalsPaused: true,
      pauseReason: 'กำลังเริ่มต้น',
      session: cfg.settings.session,
      strategyTimeframes: cfg.settings.strategyTimeframes,
      strategyKey: this.sKey,
      symbols: [],
      stats: { ...emptyStats(), queueDropped: 0, backfills: 0, reconnects: 0, lastBackfillAt: null, lastError: null },
      heartbeatAt: realNow(),
      startedAt: realNow(),
      uiRefreshMs: cfg.uiRefreshMs,
    };
  }

  get dataset(): string {
    return this.provider.info.dataset;
  }

  async start(schedule = true): Promise<void> {
    const info = this.provider.info;
    this.store.registerDataset(info.dataset, info.displayName, info.adjustment, { feed: info.feed, mode: info.mode });
    this.symbols = this.store.getWatchlist();
    this.status.symbols = this.symbols;
    this.log(`provider=${info.displayName} dataset=${info.dataset} symbols=${this.symbols.join(',')}`);
    this.writeStatus();
    await this.backfill(this.symbols, 'initial');
    this.stream = this.provider.connect(this.symbols, {
      onEvent: (e) => {
        this.status.lastMessageAt = this.realNow();
        if (this.queue.push(e)) {
          this.markGap();
          this.needsBackfill = true;
        }
      },
      onStatus: (s) => {
        if (s.state !== 'connected' && s.state !== 'authenticating') this.markGap();
        this.status.connection = { ...s, since: this.realNow() };
        if (s.state === 'connected') this.status.lastMessageAt = this.realNow();
        if (s.reconnected) {
          this.status.stats.reconnects++;
          this.needsBackfill = true;
          this.log('reconnected → จะ backfill ช่วงที่ขาด');
        }
        if (s.state === 'error' || s.state === 'reconnecting') this.log(`connection: ${s.state} ${s.message ?? ''}`);
      },
    });
    if (schedule) this.timer = setInterval(() => void this.loop(), this.cfg.workerTickMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.stream?.close();
    this.status.connection = { state: 'disconnected', since: this.realNow(), message: 'worker หยุดทำงาน' };
    this.status.dataState = 'disconnected';
    this.status.dataStateLabel = 'worker หยุดทำงาน';
    this.writeStatus();
  }

  /** รอบการทำงานหนึ่งครั้ง (public เพื่อให้ทดสอบได้) */
  async loop(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      this.provider.tick?.();
      this.drain();
      this.checkWatchlist();
      const connected = this.status.connection.state === 'connected';
      if (connected && (this.needsBackfill || this.pendingNewSymbols.size) && this.realNow() >= this.backfillRetryAt) {
        const targets = this.needsBackfill ? this.symbols : [...this.pendingNewSymbols];
        const ok = await this.backfill(targets, this.needsBackfill ? 'gap' : 'new-symbols');
        if (ok) {
          this.needsBackfill = false;
          this.pendingNewSymbols.clear();
        }
        this.drain();
      }
      this.updateDataState();
      if (!this.status.signalsPaused) this.evaluateSignals();
      this.writeSnapshots();
      this.writeStatus();
    } catch (e) {
      this.status.stats.lastError = (e as Error).message;
      this.log(`loop error: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  private addStats(s: MergeStats) {
    const st = this.status.stats;
    st.added += s.added;
    st.duplicates += s.duplicates;
    st.corrections += s.corrections;
    st.late += s.late;
    st.invalid += s.invalid;
  }

  private drain(): void {
    const events = this.queue.drain();
    this.status.stats.queueDropped = this.queue.dropped;
    if (!events.length) return;
    const minutes = new Map<string, Bar[]>();
    const daily = new Map<string, Bar[]>();
    for (const e of events) {
      if (!this.symbols.includes(e.symbol)) continue;
      if (e.type === 'trade') {
        const forming = this.builder.onTrade(e.symbol, e.price, e.size, e.ts);
        const snap = this.snap(e.symbol);
        if (snap.lastTradeTs === null || e.ts >= snap.lastTradeTs) {
          snap.lastPrice = e.price;
          snap.lastTradeTs = e.ts;
        }
        snap.forming = { ...forming };
        this.status.lastDataTs = Math.max(this.status.lastDataTs ?? 0, e.ts);
      } else if (e.type === 'minuteBar') {
        (minutes.get(e.symbol) ?? minutes.set(e.symbol, []).get(e.symbol)!).push(e.bar);
        this.builder.confirm(e.symbol, e.bar.t);
        const snap = this.snap(e.symbol);
        if (snap.forming && snap.forming.t <= e.bar.t) snap.forming = null;
        if (snap.lastPrice === null || (snap.lastTradeTs ?? 0) < e.bar.t + 60_000) {
          snap.lastPrice = e.bar.c;
          snap.lastTradeTs = e.bar.t + 60_000 - 1;
        }
        this.status.lastDataTs = Math.max(this.status.lastDataTs ?? 0, e.bar.t + 60_000);
      } else {
        (daily.get(e.symbol) ?? daily.set(e.symbol, []).get(e.symbol)!).push(e.bar);
      }
    }
    for (const [sym, bars] of minutes) {
      this.addStats(this.store.upsertBars(this.dataset, sym, '1Min', bars));
      this.dirty.add(sym);
    }
    for (const [sym, bars] of daily) {
      // dailyBars เป็นการอัปเดตแท่งเดิมระหว่างวัน → นับเป็น correction ได้ตามปกติ ไม่ใช่ข้อผิดพลาด
      this.store.upsertBars(this.dataset, sym, '1Day', bars);
      this.dirty.add(sym);
    }
  }

  private snap(symbol: string): LiveSnapshot {
    let s = this.snapshots.get(symbol);
    if (!s) {
      s = { symbol, lastPrice: null, lastTradeTs: null, forming: null, updatedAt: this.realNow() };
      this.snapshots.set(symbol, s);
    }
    return s;
  }

  private checkWatchlist(): void {
    const real = this.realNow();
    if (real - this.lastWatchlistCheck < 5000) return;
    this.lastWatchlistCheck = real;
    const wl = this.store.getWatchlist();
    if (wl.join(',') === this.symbols.join(',')) return;
    const added = wl.filter((s) => !this.symbols.includes(s));
    this.symbols = wl;
    this.status.symbols = wl;
    this.stream?.setSymbols(wl);
    for (const s of added) this.pendingNewSymbols.add(s);
    this.log(`watchlist เปลี่ยน: ${wl.join(',')}`);
  }

  /** จำจุดเริ่มช่วงที่ขาดของทุก symbol (ครั้งแรกที่พบเท่านั้น จนกว่า backfill สำเร็จ) */
  private markGap(): void {
    for (const sym of this.symbols) {
      if (!this.gapFrom.has(sym)) this.gapFrom.set(sym, this.store.lastBarTs(this.dataset, sym, '1Min'));
    }
  }

  /** ดึงข้อมูลย้อนหลัง — ต่อจากจุดเริ่มช่วงขาดหรือแท่งล่าสุดที่มี (ทับซ้อน 5 นาทีเพื่อรับการแก้ไข) */
  async backfill(symbols: string[], reason: string): Promise<boolean> {
    if (!symbols.length) return true;
    this.backfilling = true;
    this.updateDataState();
    this.writeStatus();
    try {
      const now = this.provider.now();
      for (const sym of symbols) {
        const lastMin = this.gapFrom.has(sym) ? this.gapFrom.get(sym)! : this.store.lastBarTs(this.dataset, sym, '1Min');
        const startMin = lastMin !== null ? lastMin - 5 * 60_000 : now - this.cfg.intradayHistoryDays * DAY;
        const m = await this.provider.fetchBars([sym], '1Min', startMin, now);
        this.addStats(this.store.upsertBars(this.dataset, sym, '1Min', m.get(sym) ?? []));
        const lastDay = this.store.lastBarTs(this.dataset, sym, '1Day');
        const startDay = lastDay !== null ? lastDay - 5 * DAY : now - this.cfg.dailyHistoryDays * DAY;
        const d = await this.provider.fetchBars([sym], '1Day', startDay, now);
        this.store.upsertBars(this.dataset, sym, '1Day', d.get(sym) ?? []);
        this.dirty.add(sym);
      }
      for (const sym of symbols) this.gapFrom.delete(sym);
      this.status.stats.backfills++;
      this.status.stats.lastBackfillAt = this.realNow();
      this.log(`backfill (${reason}) สำเร็จ: ${symbols.join(',')}`);
      return true;
    } catch (e) {
      this.status.stats.lastError = (e as Error).message;
      this.backfillRetryAt = this.realNow() + 30_000;
      this.log(`backfill (${reason}) ล้มเหลว: ${(e as Error).message} — ลองใหม่ใน 30 วินาที`);
      this.needsBackfill = true;
      return false;
    } finally {
      this.backfilling = false;
    }
  }

  private updateDataState(): void {
    const now = this.provider.now();
    const market = marketStatus(now);
    this.status.market = market;
    this.status.clockNow = now;
    const conn = this.status.connection.state;
    const active = market.state === 'open' || (this.cfg.settings.session === 'extended' && (market.state === 'pre' || market.state === 'post'));
    let st: DataState;
    if (conn === 'error') st = 'error';
    else if (this.backfilling) st = 'backfilling';
    else if (conn !== 'connected') st = 'disconnected';
    else if (!active) st = 'market-closed';
    else if (this.status.lastMessageAt !== null && this.realNow() - this.status.lastMessageAt > this.cfg.staleAfterSec * 1000) st = 'stale';
    else st = 'ok';
    this.status.dataState = st;
    this.status.dataStateLabel = DATA_STATE_LABEL[st];
    const paused = !(st === 'ok' || st === 'market-closed') || this.needsBackfill;
    this.status.signalsPaused = paused;
    this.status.pauseReason = paused ? (this.needsBackfill && st === 'ok' ? 'รอ backfill ช่วงข้อมูลที่ขาด' : DATA_STATE_LABEL[st]) : null;
  }

  private evaluateSignals(): void {
    const now = this.provider.now();
    const { strategy, portfolio, session, strategyTimeframes } = this.cfg.settings;
    for (const sym of this.symbols) {
      for (const tf of strategyTimeframes) {
        const grace = graceFor(tf, this.cfg);
        const memoKey = `${sym}|${tf}`;
        const cutoff = Math.floor((now - grace) / TF_MS[tf]);
        if (!this.dirty.has(sym) && this.lastCutoff.get(memoKey) === cutoff) continue;
        this.lastCutoff.set(memoKey, cutoff);
        const state = this.store.getEngineState<{ sim: { lastBarTs: number | null } }>(`tracker|${this.dataset}|${sym}|${tf}|${this.sKey}`);
        const lastTs = state?.sim.lastBarTs ?? null;
        const minDays = tf === '1Day' ? 800 : 7;
        const days = lastTs === null ? (tf === '1Day' ? this.cfg.dailyHistoryDays : this.cfg.intradayHistoryDays) : Math.max(minDays, Math.ceil((now - lastTs) / DAY) + 3);
        const bars = loadBars(this.store, this.dataset, sym, tf, session, { days });
        const { closed } = splitClosed(bars, tf, now, session, grace);
        const r = processClosedBars(this.store, { dataset: this.dataset, symbol: sym, tf }, closed, strategy, portfolio);
        if (r.newSignals) this.log(`${sym} ${tf}: สัญญาณใหม่ ${r.newSignals} รายการ (${r.origin})`);
      }
      this.dirty.delete(sym);
    }
  }

  private writeSnapshots(): void {
    this.store.db.transaction(() => {
      for (const s of this.snapshots.values()) {
        s.updatedAt = this.realNow();
        this.store.setState(`live:${this.dataset}:${s.symbol}`, s);
      }
    })();
  }

  private writeStatus(): void {
    this.status.heartbeatAt = this.realNow();
    this.store.setState('status', this.status);
  }

  getStatus(): WorkerStatus {
    return this.status;
  }
}
