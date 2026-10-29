import { afterEach, describe, expect, it, vi } from 'vitest';
import { AlpacaProvider } from '@/server/providers/alpaca';
import type { ConnectionStatus, StreamEvent } from '@/server/providers/types';

/** WebSocket ปลอมสำหรับทดสอบ protocol ของ Alpaca โดยไม่ต่อเครือข่าย */
class FakeWS {
  static OPEN = 1;
  static instances: FakeWS[] = [];
  readyState = 1;
  sent: unknown[] = [];
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeWS.instances.push(this);
  }
  send(s: string) {
    this.sent.push(JSON.parse(s));
  }
  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }
  emit(msgs: unknown[]) {
    this.onmessage?.({ data: JSON.stringify(msgs) });
  }
}

function setup(feed: 'iex' | 'delayed_sip' = 'iex') {
  FakeWS.instances = [];
  const events: StreamEvent[] = [];
  const statuses: ConnectionStatus[] = [];
  const p = new AlpacaProvider({ keyId: 'KEY', secretKey: 'SECRET', feed, adjustment: 'split', WebSocketImpl: FakeWS as unknown as typeof WebSocket });
  const conn = p.connect(['AAPL'], { onEvent: (e) => events.push(e), onStatus: (s) => statuses.push(s) });
  return { p, conn, events, statuses, ws: () => FakeWS.instances[FakeWS.instances.length - 1] };
}

afterEach(() => vi.useRealTimers());

describe('AlpacaStream protocol', () => {
  it('เชื่อมต่อ feed ที่ถูกต้อง → auth → subscribe bars/updatedBars/dailyBars/trades', () => {
    const { ws, statuses } = setup('delayed_sip');
    expect(ws().url).toBe('wss://stream.data.alpaca.markets/v2/delayed_sip');
    ws().emit([{ T: 'success', msg: 'connected' }]);
    expect(ws().sent[0]).toEqual({ action: 'auth', key: 'KEY', secret: 'SECRET' });
    ws().emit([{ T: 'success', msg: 'authenticated' }]);
    expect(ws().sent[1]).toEqual({ action: 'subscribe', bars: ['AAPL'], updatedBars: ['AAPL'], dailyBars: ['AAPL'], trades: ['AAPL'] });
    expect(statuses.at(-1)?.state).toBe('connected');
    expect(statuses.at(-1)?.reconnected).toBe(false);
  });

  it('แปลงข้อความ b/u/d/t เป็น event', () => {
    const { ws, events } = setup();
    ws().emit([
      { T: 'b', S: 'AAPL', o: 1, h: 2, l: 0.5, c: 1.5, v: 10, t: '2026-10-01T13:30:00Z' },
      { T: 'u', S: 'AAPL', o: 1, h: 2, l: 0.5, c: 1.6, v: 11, t: '2026-10-01T13:30:00Z' },
      { T: 'd', S: 'AAPL', o: 1, h: 2, l: 0.5, c: 1.6, v: 11, t: '2026-10-01T04:00:00Z' },
      { T: 't', S: 'AAPL', p: 1.7, s: 5, t: '2026-10-01T13:31:05.123456789Z' },
    ]);
    expect(events.map((e) => e.type)).toEqual(['minuteBar', 'minuteBar', 'dailyBar', 'trade']);
    expect(events[1]).toMatchObject({ corrected: true });
    expect(events[2]).toMatchObject({ bar: { t: Date.UTC(2026, 9, 1) } });
    expect(events[3]).toMatchObject({ price: 1.7, ts: Date.parse('2026-10-01T13:31:05.123Z') });
  });

  it('หลุดการเชื่อมต่อ → reconnect ด้วย backoff → แจ้ง reconnected เพื่อ backfill', () => {
    vi.useFakeTimers();
    const { ws, statuses } = setup();
    ws().emit([{ T: 'success', msg: 'connected' }, { T: 'success', msg: 'authenticated' }]);
    ws().onclose?.({ code: 1006 });
    expect(statuses.at(-1)).toMatchObject({ state: 'reconnecting', attempt: 1 });
    vi.advanceTimersByTime(2000);
    expect(FakeWS.instances).toHaveLength(2);
    ws().emit([{ T: 'success', msg: 'connected' }, { T: 'success', msg: 'authenticated' }]);
    expect(statuses.at(-1)).toMatchObject({ state: 'connected', reconnected: true });
  });

  it('auth ผิด (402) → หยุด reconnect และแจ้ง error โดยไม่แสดง secret', () => {
    vi.useFakeTimers();
    const { ws, statuses } = setup();
    ws().emit([{ T: 'error', code: 402, msg: 'auth failed' }]);
    vi.advanceTimersByTime(120_000);
    expect(FakeWS.instances).toHaveLength(1);
    const last = statuses.at(-1)!;
    expect(last.state).toBe('error');
    expect(JSON.stringify(statuses)).not.toContain('SECRET');
  });
});

describe('Alpaca REST', () => {
  it('ส่ง header, แบ่งหน้า page_token, normalize แท่งรายวัน และไม่ขอข้อมูล 15 นาทีล่าสุดสำหรับ delayed', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const pages = [
      { bars: { AAPL: [{ t: '2026-09-30T04:00:00Z', o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }] }, next_page_token: 'abc' },
      { bars: { AAPL: [{ t: '2026-10-01T04:00:00Z', o: 1.5, h: 2, l: 1, c: 1.8, v: 12 }] }, next_page_token: null },
    ];
    const fetchImpl = (async (url: string, init: { headers: Record<string, string> }) => {
      calls.push({ url, headers: init.headers });
      return new Response(JSON.stringify(pages[calls.length - 1]), { status: 200 });
    }) as unknown as typeof fetch;
    const p = new AlpacaProvider({ keyId: 'K', secretKey: 'S', feed: 'delayed_sip', adjustment: 'split', fetchImpl });
    const now = Date.now();
    const r = await p.fetchBars(['AAPL'], '1Day', now - 10 * 86_400_000, now);
    expect(r.get('AAPL')!.map((b) => b.t)).toEqual([Date.UTC(2026, 8, 30), Date.UTC(2026, 9, 1)]);
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toContain('page_token=abc');
    const q = new URL(calls[0].url).searchParams;
    expect(q.get('feed')).toBe('sip');
    expect(q.get('adjustment')).toBe('split');
    expect(Date.parse(q.get('end')!)).toBeLessThanOrEqual(now - 15 * 60_000);
    expect(calls[0].headers['APCA-API-KEY-ID']).toBe('K');
  });

  it('HTTP 403 → ข้อความอธิบายสิทธิ์ feed', async () => {
    const fetchImpl = (async () => new Response('forbidden', { status: 403 })) as unknown as typeof fetch;
    const p = new AlpacaProvider({ keyId: 'K', secretKey: 'S', feed: 'sip', adjustment: 'split', fetchImpl });
    await expect(p.fetchBars(['AAPL'], '1Min', 0, 1000)).rejects.toThrow('ไม่มีสิทธิ์');
  });
});
