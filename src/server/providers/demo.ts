/**
 * Demo Mode — ข้อมูลสังเคราะห์ที่ทำซ้ำได้ (seed คงที่จากชื่อหุ้นและวันที่) ไม่ใช่ราคาจริง
 *
 * โมเดล:
 *  - เส้นทางรายวัน: random walk แบบ regime (ขาขึ้น/ขาลง/ออกข้างสลับกัน) เริ่มจาก DEMO_ANCHOR
 *  - ภายในวัน: tick ทุก 10 วินาที (6 tick/นาที) แบบ Brownian bridge จากราคาเปิดไปราคาปิดของวัน
 *  - แท่งนาที = รวม tick, แท่งรายวัน = รวมแท่งนาที → ข้อมูลทุก timeframe สอดคล้องกัน
 *  - เฉพาะ regular session (09:30–16:00 ET)
 *  - นาฬิกาจำลอง: เริ่มที่ DEMO_START (เวลานิวยอร์ก) เดินเร็ว DEMO_SPEED เท่า และข้ามช่วงตลาดปิด
 *    ค่าเวลาจำลองถูกบันทึกใน SQLite เพื่อเปิดใหม่แล้วเดินต่อจากเดิม
 */
import { mulberry32, seedFrom } from '@/core/hash';
import { NY_TZ, dailyBarTs, isTradingDay, nextTradingDay, nyDateKey, sessionWindow, zonedTimeToUtc } from '@/core/market';
import type { Bar, BaseTimeframe } from '@/core/types';
import type { DataProvider, ProviderInfo, StreamConnection, StreamHandlers } from './types';

export const DEMO_ANCHOR = '2024-01-02';
const TICKS_PER_MIN = 6;
const TICK_MS = 10_000;

const BASE_PRICE: Record<string, number> = { AAPL: 185, MSFT: 375, NVDA: 48, AMD: 140, GOOGL: 140, AMZN: 150, META: 345 };
const HIGH_VOL = new Set(['NVDA', 'AMD']);

function gauss(rng: () => number): number {
  const u = Math.max(rng(), 1e-12);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const r2 = (x: number) => Math.round(x * 100) / 100;

interface DayPath {
  keys: string[];
  index: Map<string, number>;
  opens: number[];
  closes: number[];
  rng: () => number;
  regimeLeft: number;
  drift: number;
}

interface DayData {
  minutes: Bar[];
  ticks: number[]; // ราคา tick เรียงตามเวลา
  open: number; // UTC ms เวลาเปิด session
}

export class DemoMarket {
  private paths = new Map<string, DayPath>();
  private days = new Map<string, DayData>();
  /** สรุปแท่งรายวันที่จบแล้ว (เล็ก เก็บได้ทั้งหมด) */
  private fullDays = new Map<string, Bar>();

  private vol(symbol: string): number {
    return HIGH_VOL.has(symbol) ? 0.028 : 0.017;
  }

  private basePrice(symbol: string): number {
    return BASE_PRICE[symbol] ?? 40 + (seedFrom(`base:${symbol}`) % 260);
  }

  private path(symbol: string, upTo: string): DayPath {
    let p = this.paths.get(symbol);
    if (!p) {
      p = { keys: [], index: new Map(), opens: [], closes: [], rng: mulberry32(seedFrom(`daily:${symbol}`)), regimeLeft: 0, drift: 0 };
      this.paths.set(symbol, p);
    }
    const vol = this.vol(symbol);
    while (!p.keys.length || p.keys[p.keys.length - 1] < upTo) {
      const key = p.keys.length ? nextTradingDay(p.keys[p.keys.length - 1]) : isTradingDay(DEMO_ANCHOR) ? DEMO_ANCHOR : nextTradingDay(DEMO_ANCHOR);
      if (p.regimeLeft <= 0) {
        const drifts = [-0.004, -0.0015, 0, 0.0015, 0.004, 0.002];
        p.drift = drifts[Math.floor(p.rng() * drifts.length)];
        p.regimeLeft = 10 + Math.floor(p.rng() * 30);
      }
      p.regimeLeft--;
      const prev = p.closes.length ? p.closes[p.closes.length - 1] : this.basePrice(symbol);
      const open = r2(prev * (1 + 0.25 * vol * gauss(p.rng)));
      const close = r2(prev * Math.exp(p.drift + vol * gauss(p.rng)));
      p.index.set(key, p.keys.length);
      p.keys.push(key);
      p.opens.push(Math.max(0.5, open));
      p.closes.push(Math.max(0.5, close));
    }
    return p;
  }

  /** ข้อมูลทั้งวัน (ไม่ขึ้นกับเวลาปัจจุบัน) — ทำซ้ำได้เสมอ */
  day(symbol: string, key: string): DayData | null {
    if (key < DEMO_ANCHOR) return null;
    const w = sessionWindow(key, 'regular');
    if (!w) return null;
    const cacheKey = `${symbol}|${key}`;
    const cached = this.days.get(cacheKey);
    if (cached) return cached;

    const p = this.path(symbol, key);
    const idx = p.index.get(key)!;
    const dayOpen = p.opens[idx];
    const dayClose = p.closes[idx];
    const nMin = Math.round((w.close - w.open) / 60_000);
    const n = nMin * TICKS_PER_MIN;
    const rng = mulberry32(seedFrom(`intraday:${symbol}:${key}`));
    const sigma = (this.vol(symbol) * 1.1) / Math.sqrt(n);

    // random walk + ช่วง momentum สั้น ๆ เพื่อให้เกิดแนวโน้มระหว่างวัน
    const w0: number[] = new Array(n);
    let acc = 0;
    let segLeft = 0;
    let segDrift = 0;
    for (let k = 0; k < n; k++) {
      if (segLeft <= 0) {
        segLeft = TICKS_PER_MIN * (20 + Math.floor(rng() * 70));
        segDrift = (rng() * 2 - 1) * sigma * 0.6;
      }
      segLeft--;
      acc += k === 0 ? 0 : segDrift + sigma * gauss(rng);
      w0[k] = acc;
    }
    const lo = Math.log(dayOpen);
    const target = Math.log(dayClose) - lo;
    const ticks = w0.map((x, k) => r2(Math.exp(lo + x - (k / (n - 1)) * (w0[n - 1] - target))));

    const baseVol = 8_000 + (seedFrom(`vol:${symbol}`) % 20_000);
    const minutes: Bar[] = [];
    for (let m = 0; m < nMin; m++) {
      const seg = ticks.slice(m * TICKS_PER_MIN, (m + 1) * TICKS_PER_MIN);
      const x = (m / nMin - 0.5) * 2;
      const v = Math.round(baseVol * (1 + 2 * x * x) * (0.5 + rng()));
      minutes.push({ t: w.open + m * 60_000, o: seg[0], h: Math.max(...seg), l: Math.min(...seg), c: seg[seg.length - 1], v });
    }
    const data: DayData = { minutes, ticks, open: w.open };
    if (this.days.size > 300) this.days.delete(this.days.keys().next().value!); // จำกัดหน่วยความจำ
    this.days.set(cacheKey, data);
    return data;
  }

  /** แท่งนาทีที่ "ปิดแล้ว" ณ เวลา now ในช่วง [start, end] */
  minuteBars(symbol: string, start: number, end: number, now: number): Bar[] {
    const out: Bar[] = [];
    const last = Math.min(end, now);
    for (let key = nyDateKey(Math.max(start, dailyBarTs(DEMO_ANCHOR))); key <= nyDateKey(last); key = nextTradingDay(key)) {
      const d = this.day(symbol, key);
      if (!d) continue;
      for (const b of d.minutes) if (b.t >= start && b.t + 60_000 <= last) out.push(b);
    }
    return out;
  }

  /** แท่งรายวัน — วันที่ยังไม่จบ session ใช้เฉพาะนาทีที่ปิดแล้ว (แท่งกำลังก่อตัว) */
  dailyBar(symbol: string, key: string, now: number): Bar | null {
    const w = sessionWindow(key, 'regular');
    const complete = !!w && now >= w.close;
    const cacheKey = `${symbol}|${key}`;
    if (complete && this.fullDays.has(cacheKey)) return this.fullDays.get(cacheKey)!;
    const d = this.day(symbol, key);
    if (!d) return null;
    const mins = d.minutes.filter((b) => b.t + 60_000 <= now);
    if (!mins.length) return null;
    let h = -Infinity;
    let l = Infinity;
    let v = 0;
    for (const b of mins) {
      h = Math.max(h, b.h);
      l = Math.min(l, b.l);
      v += b.v;
    }
    const bar = { t: dailyBarTs(key), o: mins[0].o, h, l, c: mins[mins.length - 1].c, v };
    if (complete) this.fullDays.set(cacheKey, bar);
    return bar;
  }

  tickPrice(symbol: string, ts: number): number | null {
    const key = nyDateKey(ts);
    const d = this.day(symbol, key);
    if (!d) return null;
    const k = Math.floor((ts - d.open) / TICK_MS);
    return k >= 0 && k < d.ticks.length ? d.ticks[k] : null;
  }
}

/** แปลง "YYYY-MM-DDTHH:mm" (เวลานิวยอร์ก) เป็น UTC ms */
export function parseNyLocal(s: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/.exec(s.trim());
  if (!m) throw new Error(`DEMO_START ไม่ถูกต้อง: ${s} (ใช้รูปแบบ YYYY-MM-DDTHH:mm เวลานิวยอร์ก)`);
  return zonedTimeToUtc(+m[1], +m[2], +m[3], m[4] ? +m[4] : 9, m[5] ? +m[5] : 30, NY_TZ);
}

/** เลื่อนเวลาจำลองให้อยู่ใน regular session (ข้ามช่วงตลาดปิด) */
export function normalizeToSession(v: number): number {
  let key = nyDateKey(v);
  const w = sessionWindow(key, 'regular');
  if (w && v >= w.open && v < w.close) return v;
  if (w && v < w.open) return w.open;
  key = nextTradingDay(key);
  return sessionWindow(key, 'regular')!.open;
}

export class DemoClock {
  private baseVirtual: number;
  private baseReal: number;

  constructor(virtualStart: number, private speed: number, private realNow: () => number = Date.now) {
    this.baseVirtual = normalizeToSession(virtualStart);
    this.baseReal = realNow();
  }

  now(): number {
    const v = this.baseVirtual + (this.realNow() - this.baseReal) * this.speed;
    const n = normalizeToSession(v);
    if (n !== v) {
      this.baseVirtual = n;
      this.baseReal = this.realNow();
    }
    return n;
  }
}

export interface DemoOptions {
  start: number;
  speed: number;
  dropEverySec: number;
  saveClock?: (virtualNow: number) => void;
  realNow?: () => number;
}

export class DemoProvider implements DataProvider {
  readonly market = new DemoMarket();
  readonly clock: DemoClock;
  readonly info: ProviderInfo;
  private conn: { symbols: string[]; handlers: StreamHandlers; lastEmitted: number; closed: boolean } | null = null;
  private realNow: () => number;
  private dropUntil = 0;
  private nextDropAt = 0;

  constructor(private opts: DemoOptions) {
    this.realNow = opts.realNow ?? Date.now;
    this.clock = new DemoClock(opts.start, opts.speed, this.realNow);
    this.info = {
      id: 'demo',
      dataset: 'demo',
      displayName: 'Demo Mode (ข้อมูลจำลอง)',
      feed: 'demo',
      mode: 'demo',
      coverage: 'ข้อมูลสังเคราะห์ที่ทำซ้ำได้ ไม่ใช่ราคาตลาดจริง',
      delayMinutes: 0,
      adjustment: 'none',
      virtualClock: true,
      notes: [
        `นาฬิกาจำลองเดินเร็ว ${opts.speed} เท่า และข้ามช่วงตลาดปิด`,
        'มีเฉพาะ regular session (09:30–16:00 ET)',
        ...(opts.dropEverySec > 0 ? [`จำลองการหลุดการเชื่อมต่อทุก ${opts.dropEverySec} วินาที`] : []),
      ],
    };
    this.nextDropAt = this.realNow() + opts.dropEverySec * 1000;
  }

  now(): number {
    return this.clock.now();
  }

  async fetchBars(symbols: string[], tf: BaseTimeframe, start: number, end: number): Promise<Map<string, Bar[]>> {
    const now = this.now();
    const out = new Map<string, Bar[]>();
    for (const s of symbols) {
      if (tf === '1Min') out.set(s, this.market.minuteBars(s, start, end, now));
      else {
        const bars: Bar[] = [];
        const first = nyDateKey(Math.max(start, dailyBarTs(DEMO_ANCHOR)));
        const last = nyDateKey(Math.min(end, now));
        for (let k = isTradingDay(first) ? first : nextTradingDay(first); k <= last; k = nextTradingDay(k)) {
          const b = this.market.dailyBar(s, k, now);
          if (b) bars.push(b);
        }
        out.set(s, bars);
      }
    }
    return out;
  }

  connect(symbols: string[], handlers: StreamHandlers): StreamConnection {
    this.conn = { symbols: [...symbols], handlers, lastEmitted: this.now(), closed: false };
    handlers.onStatus({ state: 'connected', message: 'Demo stream พร้อม' });
    return {
      setSymbols: (s) => {
        if (this.conn) this.conn.symbols = [...s];
      },
      close: () => {
        if (this.conn) this.conn.closed = true;
        this.conn = null;
      },
    };
  }

  tick(): void {
    const c = this.conn;
    if (!c || c.closed) return;
    const now = this.now();
    this.opts.saveClock?.(now);
    const real = this.realNow();

    // จำลองการหลุดการเชื่อมต่อ: ข้อมูลช่วงนั้นหายไป แล้วต้อง backfill หลัง reconnect
    if (this.opts.dropEverySec > 0) {
      if (this.dropUntil === 0 && real >= this.nextDropAt) {
        this.dropUntil = real + 15_000;
        c.handlers.onStatus({ state: 'reconnecting', attempt: 1, nextRetryAt: this.dropUntil, message: 'จำลองการหลุดการเชื่อมต่อ' });
      }
      if (this.dropUntil > 0) {
        if (real < this.dropUntil) {
          c.lastEmitted = now;
          return;
        }
        this.dropUntil = 0;
        this.nextDropAt = real + this.opts.dropEverySec * 1000;
        c.handlers.onStatus({ state: 'connected', reconnected: true, message: 'เชื่อมต่อใหม่ (จำลอง)' });
      }
    }

    const from = c.lastEmitted;
    if (now <= from) return;
    for (const symbol of c.symbols) {
      // trade ระหว่าง (from, now] — ไม่ส่ง trade ย้อนหลังเกิน 1 ชม. (แท่งนาทียังส่งครบด้านล่าง)
      const tradeFrom = Math.max(from, now - 3_600_000);
      for (let ts = Math.floor(tradeFrom / TICK_MS) * TICK_MS + TICK_MS; ts <= now; ts += TICK_MS) {
        const p = this.market.tickPrice(symbol, ts);
        if (p !== null) c.handlers.onEvent({ type: 'trade', symbol, price: p, size: 10 + (Math.floor(ts / TICK_MS) % 90), ts });
      }
      // แท่งนาทีที่ปิดระหว่าง (from, now]
      const bars = this.market.minuteBars(symbol, from - 60_000, now, now).filter((b) => b.t + 60_000 > from);
      for (const bar of bars) c.handlers.onEvent({ type: 'minuteBar', symbol, bar, corrected: false });
      if (bars.length) {
        const d = this.market.dailyBar(symbol, nyDateKey(now), now) ?? this.market.dailyBar(symbol, nyDateKey(bars[bars.length - 1].t), now);
        if (d) c.handlers.onEvent({ type: 'dailyBar', symbol, bar: d });
      }
    }
    c.lastEmitted = now;
  }
}
