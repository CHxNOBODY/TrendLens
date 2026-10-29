'use client';

import { useCallback, useEffect, useState } from 'react';
import type { PortfolioParams } from '@/core/config';
import { formatTs } from '@/core/time';
import type { StoredPosition } from '@/server/db';
import { api, fmtMoney, fmtPct, fmtPrice, useInterval } from '@/components/api';
import { usePrefs } from '@/components/prefs';

interface Resp {
  dataset: string;
  strategyKey: string;
  portfolio: PortfolioParams;
  positions: StoredPosition[];
  marks: Record<string, { lastClose: number; lastTs: number } | null>;
  accounts: { symbol: string; tf: string; cash: number; pending: string | null; lastBarTs: number | null }[];
}

export default function PositionsPage() {
  const { tz } = usePrefs();
  const [data, setData] = useState<Resp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setData(await api<Resp>('/api/positions'));
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useInterval(load, 5000);

  const open = data?.positions.filter((p) => p.status === 'open') ?? [];
  const closed = data?.positions.filter((p) => p.status === 'closed') ?? [];
  const skipped = data?.positions.filter((p) => p.status === 'skipped') ?? [];
  const realized = closed.reduce((s, p) => s + (p.pnl ?? 0), 0);
  const cls = (x: number) => (x > 0 ? 'up' : x < 0 ? 'down' : '');

  return (
    <div className="page">
      <div className="notice info">
        สถานะจำลอง (paper tracking) เกิดจากสัญญาณที่ยืนยันแล้วของ worker: สัญญาณจากราคาปิด → จำลองซื้อ/ขายที่ราคาเปิดแท่งถัดไป (รวมค่าธรรมเนียม/slippage ตาม config) ·
        <b> ไม่มีการส่งคำสั่งซื้อขายจริง</b> · แต่ละหุ้น/timeframe มีบัญชีจำลองแยกกัน เงินตั้งต้น {fmtMoney(data?.portfolio.initialCash)}
      </div>
      {err && <div className="notice err">{err}</div>}
      <div className="metrics">
        <div className="metric">
          <div className="k">สถานะเปิดอยู่</div>
          <div className="v">{open.length}</div>
        </div>
        <div className="metric">
          <div className="k">เทรดที่ปิดแล้ว</div>
          <div className="v">{closed.length}</div>
        </div>
        <div className="metric">
          <div className="k">กำไร/ขาดทุนที่รับรู้แล้ว (รวม)</div>
          <div className={`v num ${cls(realized)}`}>{fmtMoney(realized)}</div>
        </div>
        <div className="metric">
          <div className="k">ชุดข้อมูล / strategy key</div>
          <div className="s" style={{ fontSize: 12 }}>
            {data?.dataset} · {data?.strategyKey}
          </div>
        </div>
      </div>

      <div className="card">
        <h2>สถานะที่เปิดอยู่ (mark-to-market ด้วยราคาปิดแท่งล่าสุด)</h2>
        {open.length === 0 ? (
          <div className="muted small">ไม่มีสถานะเปิด</div>
        ) : (
          <div className="table-wrap">
            <table className="t">
              <thead>
                <tr>
                  <th>หุ้น</th>
                  <th>TF</th>
                  <th>สัญญาณเข้า</th>
                  <th>ซื้อเมื่อ</th>
                  <th className="r">ราคาซื้อ</th>
                  <th className="r">จำนวน</th>
                  <th className="r">ราคาปิดล่าสุด</th>
                  <th className="r">กำไร/ขาดทุนยังไม่รับรู้</th>
                </tr>
              </thead>
              <tbody>
                {open.map((p) => {
                  const m = data?.marks[`${p.symbol}|${p.tf}`];
                  const u = m ? p.qty * m.lastClose - (p.qty * p.entryPrice + p.entryFee) : null;
                  return (
                    <tr key={p.id}>
                      <td>{p.symbol}</td>
                      <td>{p.tf}</td>
                      <td>{formatTs(p.entrySignalTs, tz)}</td>
                      <td>{formatTs(p.entryTs, tz)}</td>
                      <td className="r num">{fmtPrice(p.entryPrice)}</td>
                      <td className="r num">{fmtPrice(p.qty, 6)}</td>
                      <td className="r num">{m ? fmtPrice(m.lastClose) : '-'}</td>
                      <td className={`r num ${u !== null ? cls(u) : ''}`}>{fmtMoney(u)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h2>รายการที่ปิดแล้ว</h2>
        {closed.length === 0 ? (
          <div className="muted small">ยังไม่มี</div>
        ) : (
          <div className="table-wrap">
            <table className="t">
              <thead>
                <tr>
                  <th>หุ้น</th>
                  <th>TF</th>
                  <th>ซื้อ</th>
                  <th className="r">ราคาซื้อ</th>
                  <th>ขาย</th>
                  <th className="r">ราคาขาย</th>
                  <th className="r">จำนวน</th>
                  <th className="r">ค่าธรรมเนียม</th>
                  <th className="r">กำไร/ขาดทุน</th>
                  <th className="r">%</th>
                </tr>
              </thead>
              <tbody>
                {closed.map((p) => {
                  const invested = p.qty * p.entryPrice + p.entryFee;
                  return (
                    <tr key={p.id}>
                      <td>{p.symbol}</td>
                      <td>{p.tf}</td>
                      <td>{formatTs(p.entryTs, tz)}</td>
                      <td className="r num">{fmtPrice(p.entryPrice)}</td>
                      <td>{formatTs(p.exitTs, tz)}</td>
                      <td className="r num">{fmtPrice(p.exitPrice)}</td>
                      <td className="r num">{fmtPrice(p.qty, 6)}</td>
                      <td className="r num">{fmtPrice(p.entryFee + (p.exitFee ?? 0))}</td>
                      <td className={`r num ${cls(p.pnl ?? 0)}`}>{fmtMoney(p.pnl)}</td>
                      <td className={`r num ${cls(p.pnl ?? 0)}`}>{fmtPct(invested ? ((p.pnl ?? 0) / invested) * 100 : null)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h2>บัญชีจำลองต่อหุ้น</h2>
        <table className="t">
          <thead>
            <tr>
              <th>หุ้น</th>
              <th>TF</th>
              <th className="r">เงินสด</th>
              <th>คำสั่งรอ execute</th>
              <th>แท่งล่าสุดที่ประมวลผล</th>
            </tr>
          </thead>
          <tbody>
            {data?.accounts.map((a) => (
              <tr key={`${a.symbol}|${a.tf}`}>
                <td>{a.symbol}</td>
                <td>{a.tf}</td>
                <td className="r num">{fmtMoney(a.cash)}</td>
                <td>{a.pending === 'enter' ? 'ซื้อที่ราคาเปิดแท่งถัดไป' : a.pending === 'exit' ? 'ขายที่ราคาเปิดแท่งถัดไป' : '-'}</td>
                <td>{formatTs(a.lastBarTs, tz)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {skipped.length > 0 && <div className="small muted" style={{ marginTop: 6 }}>ข้ามการซื้อเพราะเงินไม่พอ {skipped.length} ครั้ง</div>}
      </div>
    </div>
  );
}
