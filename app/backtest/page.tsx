'use client';

import { useEffect, useState } from 'react';
import type { BacktestError, BacktestResult, SplitBacktest } from '@/core/backtest';
import { DEFAULT_PORTFOLIO, DEFAULT_STRATEGY, type PortfolioParams, type StrategyParams } from '@/core/config';
import { formatDailyTs, formatTs } from '@/core/time';
import type { Timeframe } from '@/core/types';
import { EquityChart } from '@/components/EquityChart';
import { TF_LABEL, api, fmtMoney, fmtPct, fmtPrice, type StatusResponse } from '@/components/api';
import { usePrefs } from '@/components/prefs';

interface Dataset {
  dataset: string;
  label: string;
  adjustment: string;
  tf: string;
  n: number;
  first: number;
  last: number;
}

interface Response {
  symbol: string;
  tf: Timeframe;
  dataset: string;
  datasetLabel: string;
  adjustment: string;
  session: string;
  availableFrom: number;
  availableTo: number;
  full: BacktestResult | BacktestError;
  split: SplitBacktest | null;
}

function Metric({ k, v, s, cls }: { k: string; v: string; s?: string; cls?: string }) {
  return (
    <div className="metric">
      <div className="k">{k}</div>
      <div className={`v num ${cls ?? ''}`}>{v}</div>
      {s && <div className="s">{s}</div>}
    </div>
  );
}

function Result({ r, title, tf }: { r: BacktestResult | BacktestError; title: string; tf: Timeframe }) {
  const { tz } = usePrefs();
  const ts = (ms: number) => (tf === '1Day' ? formatDailyTs(ms) : formatTs(ms, tz));
  if (!r.ok) return <div className="card"><h2>{title}</h2><div className="notice err">{r.error}</div></div>;
  const m = r.metrics;
  const b = r.benchmark;
  const signCls = (x: number) => (x > 0 ? 'up' : x < 0 ? 'down' : '');
  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h2>
        {title} <span className="small muted">({ts(r.startTs)} → {ts(r.endTs)} · {r.bars} แท่ง · warm-up ก่อนช่วง {r.warmupBars} แท่ง)</span>
      </h2>
      {r.warnings.map((w) => (
        <div key={w} className="notice small">{w}</div>
      ))}
      <div className="metrics">
        <Metric k="Total return (กลยุทธ์)" v={fmtPct(m.totalReturnPct)} cls={signCls(m.totalReturnPct)} s={`มูลค่าสุดท้าย ${fmtMoney(m.finalEquity)}`} />
        <Metric k="Total return (Buy & Hold)" v={b ? fmtPct(b.metrics.totalReturnPct) : '-'} cls={b ? signCls(b.metrics.totalReturnPct) : ''} s={b ? `มูลค่าสุดท้าย ${fmtMoney(b.metrics.finalEquity)}` : 'ซื้อไม่ได้ด้วยเงินที่มี'} />
        <Metric k="Max drawdown (กลยุทธ์)" v={`${m.maxDrawdownPct.toFixed(2)}%`} />
        <Metric k="Max drawdown (Buy & Hold)" v={b ? `${b.metrics.maxDrawdownPct.toFixed(2)}%` : '-'} />
        <Metric k="จำนวนเทรด (ปิดแล้ว)" v={String(m.closedTrades)} s={`ชนะ ${m.wins} / แพ้หรือเสมอ ${m.losses}`} />
        <Metric k="Win rate" v={m.winRatePct === null ? '-' : `${m.winRatePct.toFixed(1)}%`} s={m.winRatePct === null ? 'ไม่มีเทรดที่ปิดแล้ว' : undefined} />
        <Metric k="Profit factor" v={m.profitFactor === null ? '-' : m.profitFactor.toFixed(2)} s={m.profitFactorNote ?? `กำไรรวม ${fmtMoney(m.grossProfit)} / ขาดทุนรวม ${fmtMoney(m.grossLoss)}`} />
      </div>
      <EquityChart strategy={r.equity} benchmark={b?.equity ?? null} daily={tf === '1Day'} tz={tz} />
      <div className="small muted">เส้นทึบ = กลยุทธ์, เส้นประ = Buy &amp; Hold (ซื้อที่ราคาเปิดแท่งแรกของช่วง ด้วยค่าธรรมเนียม/slippage/สัดส่วนเงินเดียวกัน) · มูลค่าคิดแบบ mark-to-market ที่ราคาปิด</div>

      {r.openPosition && (
        <div className="notice info">
          <b>สถานะยังเปิดเมื่อจบช่วง (mark-to-market แยกจากเทรดที่ปิดแล้ว):</b> {fmtPrice(r.openPosition.qty, 6)} หุ้น ซื้อ {ts(r.openPosition.entryTs)} ที่ {fmtPrice(r.openPosition.entryPrice)} · ราคาปิดล่าสุด {fmtPrice(r.openPosition.lastClose)} · มูลค่า {fmtMoney(r.openPosition.marketValue)} · กำไร/ขาดทุนยังไม่รับรู้ {fmtMoney(r.openPosition.unrealizedPnl)} · ประมาณการต้นทุนขายออก {fmtMoney(r.openPosition.estimatedExitCosts)} (ยังไม่หักใน total return)
        </div>
      )}

      <details open={r.trades.length > 0 && r.trades.length <= 30}>
        <summary>รายการซื้อขายที่ปิดแล้ว ({r.trades.length})</summary>
        {r.trades.length === 0 ? (
          <div className="muted small">ไม่มีเทรดที่ปิดแล้ว</div>
        ) : (
          <div className="table-wrap">
            <table className="t">
              <thead>
                <tr>
                  <th>#</th>
                  <th>สัญญาณเข้า (ปิดแท่ง)</th>
                  <th>ซื้อ (เปิดแท่งถัดไป)</th>
                  <th className="r">ราคาซื้อ*</th>
                  <th>สัญญาณออก</th>
                  <th>ขาย</th>
                  <th className="r">ราคาขาย*</th>
                  <th className="r">จำนวน</th>
                  <th className="r">ค่าธรรมเนียม</th>
                  <th className="r">กำไร/ขาดทุน</th>
                  <th className="r">%</th>
                </tr>
              </thead>
              <tbody>
                {r.trades.map((t, i) => (
                  <tr key={i}>
                    <td>{i + 1}</td>
                    <td>{ts(t.entrySignalTs)}</td>
                    <td>{ts(t.entryTs)}</td>
                    <td className="r num">{fmtPrice(t.entryPrice)}</td>
                    <td>{ts(t.exitSignalTs)}</td>
                    <td>{ts(t.exitTs)}</td>
                    <td className="r num">{fmtPrice(t.exitPrice)}</td>
                    <td className="r num">{fmtPrice(t.qty, 6)}</td>
                    <td className="r num">{fmtPrice(t.entryFee + t.exitFee)}</td>
                    <td className={`r num ${signCls(t.pnl)}`}>{fmtMoney(t.pnl)}</td>
                    <td className={`r num ${signCls(t.pnl)}`}>{fmtPct(t.returnPct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="small muted">* ราคาหลัง slippage แล้ว</div>
      </details>

      <details>
        <summary>บันทึกการ execute ทั้งหมด ({r.fills.length}) และสัญญาณ ({r.signals.length})</summary>
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>เวลา execute</th>
                <th>ประเภท</th>
                <th>จากสัญญาณ</th>
                <th className="r">ราคาเปิด</th>
                <th className="r">ราคาจริง</th>
                <th className="r">จำนวน</th>
                <th className="r">ค่าธรรมเนียม</th>
                <th className="r">เงินสดคงเหลือ</th>
                <th>หมายเหตุ</th>
              </tr>
            </thead>
            <tbody>
              {r.fills.map((f, i) => (
                <tr key={i}>
                  <td>{ts(f.ts)}</td>
                  <td>{f.kind === 'buy' ? 'ซื้อ' : f.kind === 'sell' ? 'ขาย' : 'ข้าม'}</td>
                  <td>{ts(f.signalTs)}</td>
                  <td className="r num">{fmtPrice(f.rawPrice)}</td>
                  <td className="r num">{fmtPrice(f.price)}</td>
                  <td className="r num">{fmtPrice(f.qty, 6)}</td>
                  <td className="r num">{fmtPrice(f.fee)}</td>
                  <td className="r num">{fmtMoney(f.cashAfter)}</td>
                  <td>{f.note ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

type NumField = [string, number, (v: number) => void, string?];

export default function BacktestPage() {
  const [watchlist, setWatchlist] = useState<string[]>([]);
  const [symbol, setSymbol] = useState('AAPL');
  const [tf, setTf] = useState<Timeframe>('5Min');
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [active, setActive] = useState('demo');
  const [dataset, setDataset] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [split, setSplit] = useState('');
  const [sp, setSp] = useState<StrategyParams>(DEFAULT_STRATEGY);
  const [pp, setPp] = useState<PortfolioParams>(DEFAULT_PORTFOLIO);
  const [res, setRes] = useState<Response | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<StatusResponse>('/api/status').then((s) => {
      setWatchlist(s.watchlist);
      setSp(s.config.strategy as StrategyParams);
      setPp(s.config.portfolio as PortfolioParams);
    });
  }, []);

  useEffect(() => {
    api<{ active: string; datasets: Dataset[] }>(`/api/datasets?symbol=${symbol}`).then((d) => {
      setDatasets(d.datasets);
      setActive(d.active);
    });
  }, [symbol]);

  const base = tf === '1Day' ? '1Day' : '1Min';
  const options = [...new Set(datasets.filter((d) => d.tf === base).map((d) => d.dataset))];
  const effDataset = options.includes(dataset) ? dataset : options.includes(active) ? active : options[0] ?? '';
  const dsInfo = datasets.find((d) => d.dataset === effDataset && d.tf === base);

  async function run() {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<Response>('/api/backtest', {
        method: 'POST',
        body: JSON.stringify({ symbol, tf, dataset: effDataset, from: from || undefined, to: to || undefined, split: split || undefined, strategy: sp, portfolio: pp }),
      });
      setRes(r);
    } catch (e) {
      setErr((e as Error).message);
      setRes(null);
    } finally {
      setBusy(false);
    }
  }

  const strategyFields: NumField[] = [
    ['Breakout: High ของ N แท่งก่อนหน้า', sp.breakoutLookback, (v) => setSp({ ...sp, breakoutLookback: v })],
    ['Exit: Low ของ N แท่งก่อนหน้า', sp.exitLookback, (v) => setSp({ ...sp, exitLookback: v })],
    ['MA แนวโน้ม (แท่ง)', sp.trend.maPeriod, (v) => setSp({ ...sp, trend: { ...sp.trend, maPeriod: v } })],
    ['เทียบ MA กับ N แท่งก่อน', sp.trend.slopeLookback, (v) => setSp({ ...sp, trend: { ...sp.trend, slopeLookback: v } })],
    ['ATR (แท่ง)', sp.trend.atrPeriod, (v) => setSp({ ...sp, trend: { ...sp.trend, atrPeriod: v } })],
    ['ออกข้าง: ความชัน < (ATR)', sp.trend.sidewaysMaxSlopeAtr, (v) => setSp({ ...sp, trend: { ...sp.trend, sidewaysMaxSlopeAtr: v } })],
    ['ออกข้าง: ระยะห่าง ≤ (ATR)', sp.trend.sidewaysMaxDistanceAtr, (v) => setSp({ ...sp, trend: { ...sp.trend, sidewaysMaxDistanceAtr: v } })],
  ];
  const portfolioFields: NumField[] = [
    ['เงินตั้งต้น (USD)', pp.initialCash, (v) => setPp({ ...pp, initialCash: v })],
    ['สัดส่วนเงินต่อการเข้า (%)', pp.allocationPct, (v) => setPp({ ...pp, allocationPct: v }), 'สูงสุด 100 (ไม่ใช้ leverage)'],
    ['ค่าธรรมเนียม (% ต่อขา)', pp.feePct, (v) => setPp({ ...pp, feePct: v })],
    ['ค่าธรรมเนียมคงที่ (USD ต่อขา)', pp.feeFixed, (v) => setPp({ ...pp, feeFixed: v })],
    ['Slippage (% ต่อขา)', pp.slippagePct, (v) => setPp({ ...pp, slippagePct: v })],
  ];
  const numInput = ([label, value, set, hint]: NumField) => (
    <label key={label} className="field">
      <span>{label}</span>
      <input className="input num" type="number" step="any" value={value} onChange={(e) => set(Number(e.target.value))} title={hint} />
    </label>
  );

  return (
    <div className="page">
      <div className="notice">
        ผลทดสอบย้อนหลังเป็น<b>ผลจำลอง</b> ไม่รับประกันผลในอนาคต และไม่ใช่คำแนะนำการลงทุน · ใช้กติกาเดียวกับระบบติดตามสด: สัญญาณจากราคาปิด, execute ที่ราคาเปิดแท่งถัดไป, long-only, ไม่เปิดสถานะซ้อน
      </div>
      <div className="card">
        <h2>ตั้งค่าการทดสอบ</h2>
        <div className="form-grid">
          <label className="field">
            <span>หุ้น</span>
            <input className="input" list="wl-symbols" value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase().trim())} />
            <datalist id="wl-symbols">
              {watchlist.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </label>
          <label className="field">
            <span>Timeframe</span>
            <select className="select" value={tf} onChange={(e) => setTf(e.target.value as Timeframe)}>
              {(['5Min', '1Min', '1Day'] as Timeframe[]).map((t) => (
                <option key={t} value={t}>
                  {TF_LABEL[t]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>ชุดข้อมูล</span>
            <select className="select" value={effDataset} onChange={(e) => setDataset(e.target.value)}>
              {options.length === 0 && <option value="">ไม่มีข้อมูล</option>}
              {options.map((d) => (
                <option key={d} value={d}>
                  {datasets.find((x) => x.dataset === d)?.label ?? d}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>เริ่ม (YYYY-MM-DD, ว่าง = ทั้งหมด)</span>
            <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="field">
            <span>สิ้นสุด</span>
            <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <label className="field">
            <span>แยกช่วงนอกตัวอย่าง (OOS) เริ่มวันที่</span>
            <input className="input" type="date" value={split} onChange={(e) => setSplit(e.target.value)} />
          </label>
        </div>
        {dsInfo && (
          <div className="small muted" style={{ marginTop: 8 }}>
            ข้อมูลที่มี: {dsInfo.n.toLocaleString()} แท่ง {dsInfo.tf} ({tf === '1Day' ? formatDailyTs(dsInfo.first) : new Date(dsInfo.first).toISOString().slice(0, 10)} → {tf === '1Day' ? formatDailyTs(dsInfo.last) : new Date(dsInfo.last).toISOString().slice(0, 10)}) · การปรับราคา: {dsInfo.adjustment}
          </div>
        )}
        <div className="grid-2" style={{ marginTop: 12 }}>
          <div>
            <div className="section-title">กติกากลยุทธ์</div>
            <div className="form-grid">{strategyFields.map(numInput)}</div>
          </div>
          <div>
            <div className="section-title">เงินทุนและต้นทุน</div>
            <div className="form-grid">
              {portfolioFields.map(numInput)}
              <label className="field">
                <span>หุ้นเศษส่วน</span>
                <select className="select" value={pp.fractional ? 'y' : 'n'} onChange={(e) => setPp({ ...pp, fractional: e.target.value === 'y' })}>
                  <option value="y">อนุญาต (ปัดลง 6 ตำแหน่ง)</option>
                  <option value="n">จำนวนเต็มเท่านั้น</option>
                </select>
              </label>
            </div>
          </div>
        </div>
        <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="btn primary" onClick={run} disabled={busy || !effDataset}>
            {busy ? 'กำลังคำนวณ…' : 'รัน Backtest'}
          </button>
          <button
            className="btn"
            onClick={() => {
              setSp(DEFAULT_STRATEGY);
              setPp(DEFAULT_PORTFOLIO);
            }}
          >
            คืนค่าเริ่มต้น
          </button>
        </div>
      </div>

      {err && <div className="notice err">{err}</div>}
      {res && (
        <>
          <div className="small muted">
            {res.symbol} · {TF_LABEL[res.tf]} · ชุดข้อมูล: {res.datasetLabel} · การปรับราคา: {res.adjustment} · session: {res.session}
          </div>
          <Result r={res.full} title="ทั้งช่วง" tf={res.tf} />
          {res.split && (
            <div className="grid-2">
              <Result r={res.split.inSample} title="ช่วงพัฒนากติกา (in-sample)" tf={res.tf} />
              <Result r={res.split.outOfSample} title="ช่วงทดสอบนอกตัวอย่าง (out-of-sample)" tf={res.tf} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
