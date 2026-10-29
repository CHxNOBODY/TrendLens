'use client';

import { ACTION_LABELS, type Decision } from '@/core/strategy';
import { formatDailyTs, formatTs } from '@/core/time';
import { TIMEFRAMES, type Timeframe } from '@/core/types';
import type { StoredSignal } from '@/server/db';
import { TF_LABEL, fmtPrice, type ChartResponse } from './api';
import { usePrefs } from './prefs';

function tsLabel(ms: number | null | undefined, tf: Timeframe | string, tz: Parameters<typeof formatTs>[1]) {
  if (ms === null || ms === undefined) return '-';
  return tf === '1Day' ? formatDailyTs(ms) : formatTs(ms, tz);
}

export function TrendPanel({ data, maPeriod }: { data: ChartResponse; maPeriod: number }) {
  const { tz } = usePrefs();
  return (
    <div className="card">
      <h2>แนวโน้มแยกตาม timeframe</h2>
      <div className="grid-3">
        {TIMEFRAMES.map((tf) => {
          const t = data.trends[tf];
          return (
            <div key={tf} className="trend-card">
              <div className="tf">
                {TF_LABEL[tf]} · MA{maPeriod} = {maPeriod} แท่ง{TF_LABEL[tf]}
              </div>
              <div className={`label trend-${t.trend}`}>{t.label}</div>
              <div className="small muted">ณ แท่งที่ปิดแล้ว: {tsLabel(t.asOf, tf, tz)}</div>
              <ul className="reasons">
                {t.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ValuesTable({ d }: { d: Decision }) {
  const v = d.values;
  const rows: [string, string][] = [
    ['Close', fmtPrice(v.close)],
    ['High สูงสุดแท่งก่อนหน้า (breakout)', fmtPrice(v.highestPrev)],
    ['Low ต่ำสุดแท่งก่อนหน้า (exit)', fmtPrice(v.lowestPrev)],
    ['MA (แนวโน้ม)', fmtPrice(v.ma)],
    ['MA เมื่อ lookback แท่งก่อน', fmtPrice(v.maPrev)],
    ['ATR', fmtPrice(v.atr, 3)],
    ['ความชัน MA / ATR', fmtPrice(v.slopeAtr, 2)],
    ['ระยะห่างจาก MA / ATR', fmtPrice(v.distanceAtr, 2)],
    ['RSI14 (ข้อมูลประกอบ ไม่ใช้ในเงื่อนไข)', fmtPrice(v.rsi14, 1)],
  ];
  return (
    <table className="t" style={{ marginTop: 8 }}>
      <tbody>
        {rows.map(([k, val]) => (
          <tr key={k}>
            <td className="muted">{k}</td>
            <td className="r num">{val}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function DecisionPanel({ data }: { data: ChartResponse }) {
  const { tz } = usePrefs();
  const d = data.decision;
  const p = data.preview;
  return (
    <div className="card">
      <h2>สัญญาณ ({TF_LABEL[data.tf]}) และเหตุผล</h2>
      {!data.tracked && (
        <div className="notice info" style={{ marginBottom: 8 }}>
          timeframe นี้ไม่ได้ติดตามสัญญาณสด (ค่าเริ่มต้นติดตามเฉพาะ 5 นาที) — ผลด้านล่างคำนวณจากแท่งที่ปิดแล้วโดยถือว่าไม่มีสถานะ และไม่ถูกบันทึก
        </div>
      )}
      {data.signalsPaused && data.tracked && <div className="notice" style={{ marginBottom: 8 }}>พักการสร้างสัญญาณใหม่: {data.pauseReason ?? 'ข้อมูลไม่พร้อม'}</div>}
      {d ? (
        <>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
            <span className={`action ${d.action}`}>{ACTION_LABELS[d.action]}</span>
            <span className="badge neutral">ยืนยันแล้ว (แท่งปิด)</span>
            <span className="small muted">แท่ง {tsLabel(d.barTs, data.tf, tz)}</span>
            <span className="small muted">สถานะจำลอง: {data.inPosition ? 'ถือ long อยู่' : 'ไม่มีสถานะ'}</span>
          </div>
          {data.pendingOrder && (
            <div className="small" style={{ marginTop: 4 }}>
              คำสั่งจำลองรอ execute ที่ราคาเปิดแท่งถัดไป: {data.pendingOrder.kind === 'enter' ? 'ซื้อ' : 'ขาย/ปิดสถานะ'}
            </div>
          )}
          <ul className="reasons">
            {d.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          <ValuesTable d={d} />
        </>
      ) : (
        <div className="muted">ข้อมูลไม่เพียงพอ</div>
      )}
      {p && (
        <div style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="badge pending">รอยืนยัน</span>
            <span className="small">
              ระหว่างแท่ง ({tsLabel(p.barTs, data.tf, tz)}): ถ้าปิดที่ราคานี้จะเป็น <b>{ACTION_LABELS[p.action]}</b>
            </span>
          </div>
          <div className="small muted">ยังไม่ใช่สัญญาณ — ไม่บันทึกจนกว่าแท่งจะปิด</div>
        </div>
      )}
      <div className="small muted" style={{ marginTop: 10 }}>
        กติกาอธิบายได้ ไม่ใช่คำแนะนำการลงทุน และไม่มีการแสดงความน่าจะเป็นของกำไร
      </div>
    </div>
  );
}

export function SignalTable({ signals, tz }: { signals: StoredSignal[]; tz: Parameters<typeof formatTs>[1] }) {
  if (!signals.length) return <div className="muted small">ยังไม่มีสัญญาณที่ยืนยันแล้ว</div>;
  return (
    <div className="table-wrap">
      <table className="t">
        <thead>
          <tr>
            <th>เวลาแท่ง</th>
            <th>TF</th>
            <th>สัญญาณ</th>
            <th className="r">Close</th>
            <th>แนวโน้ม</th>
            <th>ที่มา</th>
            <th>เหตุผล</th>
          </tr>
        </thead>
        <tbody>
          {signals.map((s) => (
            <tr key={s.id}>
              <td>{tsLabel(s.barTs, s.tf, tz)}</td>
              <td>{s.tf}</td>
              <td className={s.kind === 'enter' ? 'up' : 'down'}>{s.kind === 'enter' ? 'พิจารณาซื้อ' : 'ออกจากสถานะ'}</td>
              <td className="r num">{fmtPrice(s.close)}</td>
              <td>{s.trend}</td>
              <td title="backfill = ไล่จากข้อมูลย้อนหลังตอนเริ่ม, catchup = ตามเก็บหลังข้อมูลขาด, live = แท่งปิดล่าสุด">{s.origin}</td>
              <td className="wrap">{s.reasons.join(' · ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
