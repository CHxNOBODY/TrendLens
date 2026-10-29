'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_TREND } from '@/core/config';
import { formatDailyTs, formatTs } from '@/core/time';
import type { Bar, Timeframe } from '@/core/types';
import type { StoredSignal } from '@/server/db';
import { DecisionPanel, SignalTable, TrendPanel } from '@/components/AnalysisPanels';
import { NotesPanel } from '@/components/NotesPanel';
import { PriceChart, type ChartToggles } from '@/components/PriceChart';
import { StatusPanel, feedBadge } from '@/components/StatusPanel';
import { TF_LABEL, api, fmtPct, fmtPrice, useInterval, type ChartResponse, type StatusResponse } from '@/components/api';
import { useLocalState, usePrefs } from '@/components/prefs';

/** ช่วงย้อนหลัง (วันปฏิทินนับจากแท่งล่าสุด) ต่อ timeframe */
const RANGES: Record<Timeframe, { label: string; days: number }[]> = {
  '1Min': [
    { label: '1 วัน', days: 1 },
    { label: '2 วัน', days: 2 },
    { label: '5 วัน', days: 5 },
  ],
  '5Min': [
    { label: '3 วัน', days: 3 },
    { label: '7 วัน', days: 7 },
    { label: '14 วัน', days: 14 },
    { label: '30 วัน', days: 30 },
  ],
  '1Day': [
    { label: '6 เดือน', days: 183 },
    { label: '1 ปี', days: 365 },
    { label: '2 ปี', days: 730 },
    { label: '3 ปี', days: 1095 },
  ],
};

function mergeBars(prev: Bar[], incoming: Bar[]): Bar[] {
  if (!incoming.length) return prev;
  const first = incoming[0].t;
  const keep = prev.filter((b) => b.t < first);
  return [...keep, ...incoming];
}

export default function Dashboard() {
  const { tz } = usePrefs();
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [symbol, setSymbol] = useLocalState('trendlens.symbol', 'AAPL');
  const [tf, setTf] = useLocalState<Timeframe>('trendlens.tf', '5Min');
  const [days, setDays] = useLocalState('trendlens.days', 7);
  const [toggles, setToggles] = useLocalState<ChartToggles>('trendlens.toggles', { ma20: true, ma50: true, ma200: false, rsi: true });
  const [chart, setChart] = useState<ChartResponse | null>(null);
  const [bars, setBars] = useState<Bar[]>([]);
  const [signals, setSignals] = useState<StoredSignal[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [newSym, setNewSym] = useState('');
  const reqId = useRef(0);
  const barsRef = useRef<Bar[]>([]);
  barsRef.current = bars;

  const watchlist = status?.watchlist ?? [];
  const refreshMs = status?.config.uiRefreshMs ?? 2000;
  const rangeOk = RANGES[tf].some((r) => r.days === days);
  const effDays = rangeOk ? days : RANGES[tf][1].days;
  const resetKey = `${symbol}|${tf}|${effDays}`;

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await api<StatusResponse>('/api/status'));
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  // โหลดเต็มเมื่อเปลี่ยนหุ้น/timeframe/ช่วง
  useEffect(() => {
    const id = ++reqId.current;
    setChart(null);
    setBars([]);
    api<ChartResponse>(`/api/chart?symbol=${symbol}&tf=${tf}&days=${effDays}`)
      .then((r) => {
        if (id !== reqId.current) return;
        setChart(r);
        setBars(r.bars);
        setErr(null);
      })
      .catch((e) => id === reqId.current && setErr(e.message));
  }, [symbol, tf, effDays]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const loadSignals = useCallback(async () => {
    try {
      setSignals((await api<{ signals: StoredSignal[] }>(`/api/signals?symbol=${symbol}`)).signals);
    } catch {}
  }, [symbol]);
  useEffect(() => {
    void loadSignals();
  }, [loadSignals]);

  // อัปเดตต่อเนื่อง: ดึงเฉพาะแท่งตั้งแต่แท่งสุดท้ายที่มี
  useInterval(async () => {
    await loadStatus();
    const last = barsRef.current[barsRef.current.length - 1];
    const id = reqId.current;
    try {
      const r = await api<ChartResponse>(`/api/chart?symbol=${symbol}&tf=${tf}&days=${effDays}${last ? `&since=${last.t}` : ''}`);
      if (id !== reqId.current) return;
      setChart(r);
      setBars((prev) => (last ? mergeBars(prev, r.bars) : r.bars));
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
    await loadSignals();
  }, refreshMs);

  async function addSymbol() {
    try {
      const r = await api<{ watchlist: string[] }>('/api/watchlist', { method: 'POST', body: JSON.stringify({ symbol: newSym }) });
      setStatus((s) => (s ? { ...s, watchlist: r.watchlist } : s));
      setNewSym('');
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function removeSymbol(s: string) {
    const r = await api<{ watchlist: string[] }>(`/api/watchlist?symbol=${s}`, { method: 'DELETE' });
    setStatus((st) => (st ? { ...st, watchlist: r.watchlist } : st));
    if (s === symbol && r.watchlist.length) setSymbol(r.watchlist[0]);
  }

  const h = chart?.header;
  const badge = feedBadge(status?.status ?? null, status?.workerAlive ?? false);
  const chgCls = (h?.change ?? 0) > 0 ? 'up' : (h?.change ?? 0) < 0 ? 'down' : 'muted';
  const tracked = status?.config.strategyTimeframes ?? ['5Min'];

  return (
    <div className="layout">
      <aside className="sidebar">
        <div>
          <div className="section-title">Watchlist</div>
          <div className="wl">
            {watchlist.map((s) => (
              <div key={s} className={`wl-item${s === symbol ? ' active' : ''}`} onClick={() => setSymbol(s)}>
                <span className="sym">{s}</span>
                <button
                  className="x"
                  title={`ลบ ${s} ออกจาก Watchlist`}
                  onClick={(e) => {
                    e.stopPropagation();
                    void removeSymbol(s);
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
          <div className="wl-add">
            <input className="input" placeholder="เพิ่ม ticker เช่น TSLA" value={newSym} onChange={(e) => setNewSym(e.target.value.toUpperCase())} onKeyDown={(e) => e.key === 'Enter' && newSym && addSymbol()} />
            <button className="btn" onClick={addSymbol} disabled={!newSym}>
              เพิ่ม
            </button>
          </div>
        </div>

        <div>
          <div className="section-title">Timeframe</div>
          <div className="seg">
            {(['1Min', '5Min', '1Day'] as Timeframe[]).map((t) => (
              <button key={t} className={tf === t ? 'on' : ''} onClick={() => setTf(t)}>
                {TF_LABEL[t]}
              </button>
            ))}
          </div>
          <div className="small muted" style={{ marginTop: 4 }}>
            ติดตามสัญญาณสด: {tracked.map((t) => TF_LABEL[t]).join(', ')}
          </div>
        </div>

        <div>
          <div className="section-title">ช่วงย้อนหลัง</div>
          <select className="select" value={effDays} onChange={(e) => setDays(Number(e.target.value))}>
            {RANGES[tf].map((r) => (
              <option key={r.days} value={r.days}>
                {r.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <div className="section-title">Indicators</div>
          <div className="toggles">
            {(
              [
                ['ma20', 'MA20', '#f0b429'],
                ['ma50', 'MA50', '#58a6ff'],
                ['ma200', 'MA200', '#b48ead'],
                ['rsi', 'RSI14', '#b48ead'],
              ] as [keyof ChartToggles, string, string][]
            ).map(([k, label, color]) => (
              <label key={k} className="chip">
                <input type="checkbox" checked={toggles[k]} onChange={(e) => setToggles({ ...toggles, [k]: e.target.checked })} />
                <span className="dot" style={{ background: color }} />
                {label}
              </label>
            ))}
          </div>
        </div>

        <div>
          <div className="section-title">สถานะ Provider</div>
          <StatusPanel data={status} />
        </div>
      </aside>

      <main className="main">
        {err && <div className="notice err">{err}</div>}
        <div className="card">
          <div className="quote">
            <div className="sym">{symbol}</div>
            <div className="price num">{fmtPrice(h?.lastPrice)}</div>
            <div className={`chg num ${chgCls}`}>
              {h?.change !== null && h?.change !== undefined ? `${h.change >= 0 ? '+' : ''}${fmtPrice(h.change)} (${fmtPct(h.changePct)})` : '-'}
            </div>
            <div className="badges">
              <span className={`badge ${badge.cls}`} title={badge.title}>
                {badge.text}
              </span>
              {chart && <span className="badge neutral">{chart.market.label}</span>}
              {chart?.hasForming && <span className="badge pending">แท่งล่าสุดยังไม่ปิด</span>}
            </div>
          </div>
          <div className="small muted" style={{ marginTop: 6 }}>
            อัปเดตล่าสุด: {h?.lastTs ? formatTs(h.lastTs, tz, { seconds: true }) : '-'}
            {status?.status?.provider.virtualClock ? ' (เวลาจำลอง)' : ''} · เปลี่ยนแปลงเทียบราคาปิดวันก่อนหน้า{' '}
            {h?.refDailyTs ? `(แท่งรายวันอ้างอิง ${formatDailyTs(h.refDailyTs)})` : ''} · รีเฟรชทุก {(refreshMs / 1000).toFixed(1)} วินาที
          </div>
        </div>

        <div className="card" style={{ padding: 8 }}>
          <PriceChart bars={bars} tf={tf} tz={tz} toggles={toggles} signals={chart?.signals ?? []} resetKey={resetKey} />
        </div>

        {chart && (
          <>
            <TrendPanel data={chart} maPeriod={DEFAULT_TREND.maPeriod} />
            <div className="grid-2">
              <DecisionPanel data={chart} />
              <NotesPanel symbol={symbol} />
            </div>
          </>
        )}

        <div className="card">
          <h2>ประวัติสัญญาณที่ยืนยันแล้ว — {symbol}</h2>
          <div className="small muted" style={{ marginBottom: 8 }}>
            บันทึกโดย worker จากแท่งที่ปิดแล้วเท่านั้น หนึ่งรายการต่อแท่งต่อชนิด (ไม่ซ้ำเมื่อรีเฟรชหน้าจอหรือเปิดโปรแกรมใหม่) · สถานะจำลองดูที่หน้า “สถานะจำลอง”
          </div>
          <SignalTable signals={signals} tz={tz} />
        </div>
      </main>
    </div>
  );
}
