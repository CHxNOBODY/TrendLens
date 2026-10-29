'use client';

import { useEffect, useRef } from 'react';
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { rsi, sma } from '@/core/indicators';
import type { DisplayTimeZone } from '@/core/market';
import { formatDailyTs, formatTs } from '@/core/time';
import type { Bar, Timeframe } from '@/core/types';
import type { StoredSignal } from '@/server/db';

export interface ChartToggles {
  ma20: boolean;
  ma50: boolean;
  ma200: boolean;
  rsi: boolean;
}

const MA_COLORS = { ma20: '#f0b429', ma50: '#58a6ff', ma200: '#b48ead' } as const;
const MA_PERIOD = { ma20: 20, ma50: 50, ma200: 200 } as const;

const toTime = (ms: number) => (ms / 1000) as UTCTimestamp;

interface Props {
  bars: Bar[];
  tf: Timeframe;
  tz: DisplayTimeZone;
  toggles: ChartToggles;
  signals: StoredSignal[];
  /** เปลี่ยนค่านี้เมื่อต้องโหลดข้อมูลใหม่ทั้งหมด (เปลี่ยนหุ้น/timeframe/ช่วง) */
  resetKey: string;
}

/**
 * กราฟแท่งเทียน + Volume + MA + RSI (pane แยก)
 * เวลาเก็บเป็น UTC; แสดงผลตาม timezone ที่เลือกผ่าน formatter (รายวันแสดงวันที่ตามตลาด)
 */
export function PriceChart({ bars, tf, tz, toggles, signals, resetKey }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const s = useRef<{
    candle: ISeriesApi<'Candlestick'>;
    vol: ISeriesApi<'Histogram'>;
    ma: Record<keyof typeof MA_PERIOD, ISeriesApi<'Line'>>;
    rsi: ISeriesApi<'Line'> | null;
    markers: ISeriesMarkersPluginApi<Time>;
    lastT: number | null;
    count: number;
  } | null>(null);

  // สร้างกราฟใหม่เมื่อเปลี่ยนชุดข้อมูล / timezone / เปิดปิด RSI
  useEffect(() => {
    if (!box.current) return;
    const fmt = (t: Time) => {
      const ms = (t as number) * 1000;
      return tf === '1Day' ? formatDailyTs(ms) : formatTs(ms, tz);
    };
    const c = createChart(box.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: '#151b23' },
        textColor: '#8b98a8',
        fontFamily: "'Segoe UI', Tahoma, sans-serif",
        panes: { separatorColor: '#2a3340', enableResize: true },
      },
      grid: { vertLines: { color: '#1e2630' }, horzLines: { color: '#1e2630' } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#2a3340' },
      timeScale: {
        borderColor: '#2a3340',
        timeVisible: tf !== '1Day',
        secondsVisible: false,
        // tickMarkType < 3 = ขึ้นวัน/เดือน/ปีใหม่ → แสดงวันที่, นอกนั้นแสดงเวลา (ตาม timezone ที่เลือก)
        tickMarkFormatter: (t: Time, tickMarkType: number) => {
          const ms = (t as number) * 1000;
          if (tf === '1Day') return formatDailyTs(ms).slice(5);
          const full = formatTs(ms, tz); // dd/mm/yyyy hh:mm
          return tickMarkType < 3 ? full.slice(0, 5) : full.slice(11);
        },
      },
      localization: { timeFormatter: fmt, locale: 'en-US' },
    });
    const candle = c.addSeries(CandlestickSeries, {
      upColor: '#26a69a',
      downColor: '#ef5350',
      borderVisible: false,
      wickUpColor: '#26a69a',
      wickDownColor: '#ef5350',
    });
    const vol = c.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false });
    c.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    candle.priceScale().applyOptions({ scaleMargins: { top: 0.06, bottom: 0.22 } });
    const ma = {
      ma20: c.addSeries(LineSeries, { color: MA_COLORS.ma20, lineWidth: 1, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false }),
      ma50: c.addSeries(LineSeries, { color: MA_COLORS.ma50, lineWidth: 2, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false }),
      ma200: c.addSeries(LineSeries, { color: MA_COLORS.ma200, lineWidth: 2, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false }),
    };
    let rsiSeries: ISeriesApi<'Line'> | null = null;
    if (toggles.rsi) {
      rsiSeries = c.addSeries(LineSeries, { color: '#b48ead', lineWidth: 1, priceLineVisible: false }, 1);
      rsiSeries.createPriceLine({ price: 70, color: '#ef535088', lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: '' });
      rsiSeries.createPriceLine({ price: 30, color: '#26a69a88', lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: '' });
      const panes = c.panes();
      if (panes[1]) panes[1].setHeight(130);
    }
    const markers = createSeriesMarkers(candle, []);
    chart.current = c;
    s.current = { candle, vol, ma, rsi: rsiSeries, markers, lastT: null, count: 0 };
    return () => {
      c.remove();
      chart.current = null;
      s.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey, tz, toggles.rsi, tf]);

  // ข้อมูล: โหลดครั้งแรกด้วย setData แล้วอัปเดตเฉพาะแท่งท้ายด้วย update() เพื่อไม่ให้มุมมองกระโดด
  useEffect(() => {
    const cur = s.current;
    if (!cur) return;
    const candles = bars.map((b) => ({ time: toTime(b.t), open: b.o, high: b.h, low: b.l, close: b.c }));
    const vols = bars.map((b) => ({ time: toTime(b.t), value: b.v, color: b.c >= b.o ? '#26a69a55' : '#ef535055' }));
    const incremental = cur.lastT !== null && bars.length >= cur.count && bars.length - cur.count <= 5 && bars.length > 0 && bars[0].t <= cur.lastT;
    if (incremental) {
      const from = bars.findIndex((b) => b.t >= cur.lastT!);
      for (let i = Math.max(0, from); i < bars.length; i++) {
        cur.candle.update(candles[i]);
        cur.vol.update(vols[i]);
      }
    } else {
      cur.candle.setData(candles);
      cur.vol.setData(vols);
      if (bars.length) chart.current?.timeScale().scrollToRealTime();
    }
    cur.lastT = bars.length ? bars[bars.length - 1].t : null;
    cur.count = bars.length;

    const closes = bars.map((b) => b.c);
    (Object.keys(MA_PERIOD) as (keyof typeof MA_PERIOD)[]).forEach((k) => {
      const vals = sma(closes, MA_PERIOD[k]);
      cur.ma[k].setData(bars.flatMap((b, i) => (vals[i] === null ? [] : [{ time: toTime(b.t), value: vals[i] as number }])));
    });
    if (cur.rsi) {
      const r = rsi(closes, 14);
      cur.rsi.setData(bars.flatMap((b, i) => (r[i] === null ? [] : [{ time: toTime(b.t), value: r[i] as number }])));
    }
  }, [bars, resetKey, tz, toggles.rsi, tf]);

  useEffect(() => {
    const cur = s.current;
    if (!cur) return;
    (Object.keys(MA_PERIOD) as (keyof typeof MA_PERIOD)[]).forEach((k) => cur.ma[k].applyOptions({ visible: toggles[k] }));
  }, [toggles, resetKey, tz, tf]);

  // เครื่องหมายสัญญาณ (จากเหตุการณ์ที่ worker บันทึกไว้เท่านั้น)
  useEffect(() => {
    const cur = s.current;
    if (!cur) return;
    const first = bars.length ? bars[0].t : Infinity;
    const ms: SeriesMarker<Time>[] = signals
      .filter((sg) => sg.barTs >= first)
      .sort((a, b) => a.barTs - b.barTs)
      .map((sg) =>
        sg.kind === 'enter'
          ? { time: toTime(sg.barTs), position: 'belowBar', color: '#26a69a', shape: 'arrowUp', text: 'ซื้อ' }
          : { time: toTime(sg.barTs), position: 'aboveBar', color: '#ef5350', shape: 'arrowDown', text: 'ออก' },
      );
    cur.markers.setMarkers(ms);
  }, [signals, bars, resetKey, tz, toggles.rsi, tf]);

  return (
    <div className={`chart-box${toggles.rsi ? ' with-rsi' : ''}`}>
      <div className="chart-legend">
        {(Object.keys(MA_PERIOD) as (keyof typeof MA_PERIOD)[])
          .filter((k) => toggles[k])
          .map((k) => (
            <span key={k} style={{ color: MA_COLORS[k] }}>
              MA{MA_PERIOD[k]}
            </span>
          ))}
        {toggles.rsi && <span style={{ color: '#b48ead' }}>RSI14 (pane ล่าง)</span>}
      </div>
      <div ref={box} style={{ position: 'absolute', inset: 0 }} />
      {!bars.length && <div className="chart-empty">ยังไม่มีข้อมูลสำหรับ timeframe นี้</div>}
    </div>
  );
}
