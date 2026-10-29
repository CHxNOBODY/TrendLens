'use client';

import { useEffect, useRef } from 'react';
import { ColorType, LineSeries, createChart, type Time, type UTCTimestamp } from 'lightweight-charts';
import type { EquityPoint } from '@/core/backtest';
import type { DisplayTimeZone } from '@/core/market';
import { formatDailyTs, formatTs } from '@/core/time';

export function EquityChart({ strategy, benchmark, daily, tz }: { strategy: EquityPoint[]; benchmark: EquityPoint[] | null; daily: boolean; tz: DisplayTimeZone }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!box.current) return;
    const fmt = (t: Time) => (daily ? formatDailyTs((t as number) * 1000) : formatTs((t as number) * 1000, tz));
    const c = createChart(box.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: '#151b23' }, textColor: '#8b98a8' },
      grid: { vertLines: { color: '#1e2630' }, horzLines: { color: '#1e2630' } },
      timeScale: { timeVisible: !daily, borderColor: '#2a3340' },
      rightPriceScale: { borderColor: '#2a3340' },
      localization: { timeFormatter: fmt, locale: 'en-US' },
    });
    const toData = (pts: EquityPoint[]) => pts.map((p) => ({ time: (p.t / 1000) as UTCTimestamp, value: p.equity }));
    c.addSeries(LineSeries, { color: '#58a6ff', lineWidth: 2, title: 'กลยุทธ์' }).setData(toData(strategy));
    if (benchmark) c.addSeries(LineSeries, { color: '#8b98a8', lineWidth: 1, lineStyle: 2, title: 'Buy & Hold' }).setData(toData(benchmark));
    c.timeScale().fitContent();
    return () => c.remove();
  }, [strategy, benchmark, daily, tz]);
  return <div ref={box} style={{ height: 320 }} />;
}
