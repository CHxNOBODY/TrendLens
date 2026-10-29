/**
 * Alpaca Market Data (v2) — REST สำหรับข้อมูลย้อนหลัง, WebSocket สำหรับข้อมูลระหว่างวัน
 *
 * ข้อจำกัดตามเอกสาร Alpaca (ตรวจสอบ ต.ค. 2026 — docs.alpaca.markets):
 *  - Basic (ฟรี): real-time เฉพาะ IEX exchange, WebSocket ได้ 30 symbols, REST 200 ครั้ง/นาที,
 *    ข้อมูลย้อนหลัง SIP ดึงได้ถึง "15 นาทีล่าสุด" ไม่ได้ (ล่าช้า 15 นาที)
 *  - Algo Trader Plus: SIP ครบทุกตลาด real-time
 *  - WebSocket: wss://stream.data.alpaca.markets/v2/{iex|sip|delayed_sip}
 *    delayed_sip = SIP ล่าช้า 15 นาที
 *  - bars (นาที) ส่งหลังขึ้นนาทีใหม่และรวม pre/after-hours, updatedBars แก้แท่งนาทีก่อนหน้าเมื่อมี trade มาช้า,
 *    dailyBars อัปเดตทุกนาทีหลังตลาดเปิด
 *  - การเชื่อมต่อ WebSocket ต่อบัญชีมีจำกัด (error 406 = connection limit exceeded)
 * secret ใช้เฉพาะใน header/ข้อความ auth และไม่ถูก log
 */
import { dailyBarTs, nyDateKey } from '@/core/market';
import type { Bar, BaseTimeframe } from '@/core/types';
import type { AlpacaFeed, Adjustment } from '../env';
import { backoffDelay } from '../stream';
import type { ConnectionStatus, DataProvider, ProviderInfo, StreamConnection, StreamHandlers } from './types';

const REST_BASE = 'https://data.alpaca.markets/v2';
const WS_BASE = 'wss://stream.data.alpaca.markets/v2';

export interface AlpacaOptions {
  keyId: string;
  secretKey: string;
  feed: AlpacaFeed;
  adjustment: Adjustment;
  fetchImpl?: typeof fetch;
  WebSocketImpl?: typeof WebSocket;
}

interface RawBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export function alpacaInfo(feed: AlpacaFeed, adjustment: Adjustment): ProviderInfo {
  const adjLabel = adjustment === 'split' ? 'ปรับ split' : adjustment === 'all' ? 'ปรับ split + เงินปันผล' : 'ราคาดิบ (ไม่ปรับ)';
  const base = { id: 'alpaca' as const, dataset: `alpaca-${feed}-${adjustment}`, adjustment, virtualClock: false };
  const adjNote = `ข้อมูลย้อนหลัง: ${adjLabel}; ข้อมูลสดเป็นราคาดิบเสมอ`;
  if (feed === 'iex') {
    return {
      ...base,
      displayName: 'Alpaca — IEX',
      feed: 'iex',
      mode: 'live',
      coverage: 'เฉพาะการซื้อขายบน IEX exchange (ส่วนน้อยของปริมาณทั้งตลาด) — ราคา/ปริมาณอาจต่างจากตลาดรวม',
      delayMinutes: 0,
      notes: ['real-time แต่ครอบคลุมเฉพาะ IEX', adjNote],
    };
  }
  if (feed === 'sip') {
    return {
      ...base,
      displayName: 'Alpaca — SIP',
      feed: 'sip',
      mode: 'live',
      coverage: 'ทุกตลาดหลักทรัพย์สหรัฐฯ (SIP) — ต้องมีแผน Algo Trader Plus',
      delayMinutes: 0,
      notes: [adjNote],
    };
  }
  return {
    ...base,
    displayName: 'Alpaca — SIP (ล่าช้า 15 นาที)',
    feed: 'delayed_sip',
    mode: 'delayed',
    coverage: 'ทุกตลาด (SIP) แต่ล่าช้า 15 นาที — ไม่ใช่ real-time',
    delayMinutes: 15,
    notes: ['ข้อมูลล่าช้า 15 นาที', adjNote],
  };
}

export function toBar(r: RawBar, tf: BaseTimeframe): Bar {
  const ts = Date.parse(r.t);
  // แท่งรายวันของ Alpaca มี timestamp เป็นเที่ยงคืนเวลานิวยอร์ก → normalize เป็น Date.UTC ของวันที่ซื้อขาย
  return { t: tf === '1Day' ? dailyBarTs(nyDateKey(ts + 3_600_000)) : ts, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v };
}

export class AlpacaProvider implements DataProvider {
  readonly info: ProviderInfo;
  private fetchImpl: typeof fetch;

  constructor(private opts: AlpacaOptions) {
    this.info = alpacaInfo(opts.feed, opts.adjustment);
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  now(): number {
    return Date.now();
  }

  private headers() {
    return { 'APCA-API-KEY-ID': this.opts.keyId, 'APCA-API-SECRET-KEY': this.opts.secretKey, Accept: 'application/json' };
  }

  async fetchBars(symbols: string[], tf: BaseTimeframe, start: number, end: number): Promise<Map<string, Bar[]>> {
    const out = new Map<string, Bar[]>(symbols.map((s) => [s, []]));
    if (!symbols.length) return out;
    // REST: feed sip สำหรับทั้ง sip และ delayed_sip; delayed ต้องไม่ขอ 15 นาทีล่าสุด
    const restFeed = this.opts.feed === 'iex' ? 'iex' : 'sip';
    const effEnd = this.opts.feed === 'delayed_sip' ? Math.min(end, Date.now() - 16 * 60_000) : end;
    if (effEnd <= start) return out;
    let pageToken: string | null = null;
    let pages = 0;
    do {
      const q = new URLSearchParams({
        symbols: symbols.join(','),
        timeframe: tf,
        start: new Date(start).toISOString(),
        end: new Date(effEnd).toISOString(),
        limit: '10000',
        adjustment: this.opts.adjustment,
        feed: restFeed,
        sort: 'asc',
      });
      if (pageToken) q.set('page_token', pageToken);
      const json = (await this.getJson(`${REST_BASE}/stocks/bars?${q}`)) as { bars: Record<string, RawBar[]> | null; next_page_token: string | null };
      for (const [sym, arr] of Object.entries(json.bars ?? {})) {
        const list = out.get(sym) ?? [];
        for (const r of arr) list.push(toBar(r, tf));
        out.set(sym, list);
      }
      pageToken = json.next_page_token;
      pages++;
    } while (pageToken && pages < 200);
    return out;
  }

  private async getJson(url: string): Promise<unknown> {
    for (let attempt = 1; ; attempt++) {
      const res = await this.fetchImpl(url, { headers: this.headers() });
      if (res.ok) return res.json();
      const body = (await res.text()).slice(0, 200);
      if ((res.status === 429 || res.status >= 500) && attempt < 5) {
        await new Promise((r) => setTimeout(r, backoffDelay(attempt, { baseMs: 2000, maxMs: 30_000, jitter: 0.2 })));
        continue;
      }
      const hint =
        res.status === 401 || res.status === 403
          ? 'API key ไม่ถูกต้องหรือไม่มีสิทธิ์ใช้ feed นี้'
          : res.status === 422
            ? 'พารามิเตอร์ไม่ถูกต้อง (เช่น ขอข้อมูล SIP ล่าสุด 15 นาทีด้วยแผนฟรี)'
            : 'เรียก Alpaca REST ไม่สำเร็จ';
      throw new Error(`${hint} (HTTP ${res.status}): ${body}`);
    }
  }

  connect(symbols: string[], handlers: StreamHandlers): StreamConnection {
    return new AlpacaStream(this.opts, symbols, handlers);
  }
}

const FATAL_CODES = new Set([402, 409]); // auth failed, insufficient subscription → ต้องแก้ config ก่อน

class AlpacaStream implements StreamConnection {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private everConnected = false;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private subscribed = new Set<string>();
  private WS: typeof WebSocket;

  constructor(private opts: AlpacaOptions, private symbols: string[], private h: StreamHandlers) {
    this.WS = opts.WebSocketImpl ?? WebSocket;
    this.open();
  }

  private status(s: ConnectionStatus) {
    this.h.onStatus(s);
  }

  private open() {
    if (this.closed) return;
    this.status({ state: this.everConnected ? 'reconnecting' : 'connecting', attempt: this.attempt });
    const ws = new this.WS(`${WS_BASE}/${this.opts.feed}`);
    this.ws = ws;
    this.subscribed.clear();
    ws.onmessage = (ev) => this.onMessage(String(ev.data));
    ws.onerror = () => {
      /* รายละเอียดจะตามมาใน onclose */
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.closed) return;
      this.scheduleReconnect(`การเชื่อมต่อปิด (code ${ev.code})`);
    };
  }

  private scheduleReconnect(reason: string) {
    this.attempt++;
    const delay = backoffDelay(this.attempt);
    this.status({ state: 'reconnecting', attempt: this.attempt, nextRetryAt: Date.now() + delay, message: reason });
    this.timer = setTimeout(() => this.open(), delay);
  }

  private send(obj: unknown) {
    if (this.ws && this.ws.readyState === this.WS.OPEN) this.ws.send(JSON.stringify(obj));
  }

  private onMessage(text: string) {
    let msgs: Record<string, unknown>[];
    try {
      msgs = JSON.parse(text);
    } catch {
      return;
    }
    for (const m of msgs) {
      switch (m.T) {
        case 'success':
          if (m.msg === 'connected') {
            this.status({ state: 'authenticating' });
            this.send({ action: 'auth', key: this.opts.keyId, secret: this.opts.secretKey });
          } else if (m.msg === 'authenticated') {
            this.subscribe(this.symbols);
            const reconnected = this.everConnected;
            this.everConnected = true;
            this.attempt = 0;
            this.status({ state: 'connected', reconnected, message: `เชื่อมต่อ ${this.opts.feed} แล้ว` });
          }
          break;
        case 'subscription':
          break;
        case 'error': {
          const code = Number(m.code);
          const msg = `Alpaca error ${code}: ${String(m.msg)}`;
          if (FATAL_CODES.has(code)) {
            this.closed = true;
            this.status({ state: 'error', message: `${msg} — ตรวจสอบ API key และสิทธิ์ของ feed "${this.opts.feed}" แล้วเริ่มโปรแกรมใหม่` });
            this.ws?.close();
          } else {
            this.status({ state: 'reconnecting', attempt: this.attempt, message: msg });
          }
          break;
        }
        case 'b':
        case 'u':
          this.h.onEvent({ type: 'minuteBar', symbol: String(m.S), bar: toBar(m as unknown as RawBar, '1Min'), corrected: m.T === 'u' });
          break;
        case 'd':
          this.h.onEvent({ type: 'dailyBar', symbol: String(m.S), bar: toBar(m as unknown as RawBar, '1Day') });
          break;
        case 't':
          this.h.onEvent({ type: 'trade', symbol: String(m.S), price: Number(m.p), size: Number(m.s), ts: Date.parse(String(m.t)) });
          break;
      }
    }
  }

  private subscribe(symbols: string[]) {
    const add = symbols.filter((s) => !this.subscribed.has(s));
    const remove = [...this.subscribed].filter((s) => !symbols.includes(s));
    if (remove.length) this.send({ action: 'unsubscribe', bars: remove, updatedBars: remove, dailyBars: remove, trades: remove });
    if (add.length) this.send({ action: 'subscribe', bars: add, updatedBars: add, dailyBars: add, trades: add });
    this.subscribed = new Set(symbols);
  }

  setSymbols(symbols: string[]): void {
    this.symbols = [...symbols];
    if (this.everConnected && this.ws) this.subscribe(this.symbols);
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
    this.status({ state: 'disconnected' });
  }
}
