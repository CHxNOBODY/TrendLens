'use client';

import { formatDuration, formatTs } from '@/core/time';
import type { StatusResponse } from './api';
import { usePrefs } from './prefs';

const CONN_LABEL: Record<string, string> = {
  connecting: 'กำลังเชื่อมต่อ',
  authenticating: 'กำลังยืนยันตัวตน',
  connected: 'เชื่อมต่อแล้ว',
  reconnecting: 'กำลังเชื่อมต่อใหม่',
  disconnected: 'ไม่ได้เชื่อมต่อ',
  error: 'ผิดพลาด',
};

export function feedBadge(st: StatusResponse['status'], workerAlive: boolean): { cls: string; text: string; title: string } {
  if (!st || !workerAlive) return { cls: 'bad', text: 'WORKER OFFLINE', title: 'worker ไม่ทำงาน — ข้อมูลที่เห็นไม่อัปเดต' };
  const p = st.provider;
  if (p.mode === 'demo') return { cls: 'demo', text: 'DEMO', title: 'ข้อมูลจำลอง ไม่ใช่ราคาจริง' };
  if (p.mode === 'delayed') return { cls: 'delayed', text: `DELAYED ${p.delayMinutes}m`, title: p.coverage };
  if (st.dataState === 'stale' || st.dataState === 'disconnected' || st.dataState === 'error')
    return { cls: 'bad', text: `${p.feed.toUpperCase()} · ไม่อัปเดต`, title: st.dataStateLabel };
  return { cls: 'live', text: `LIVE · ${p.feed.toUpperCase()}`, title: p.coverage };
}

export function StatusPanel({ data }: { data: StatusResponse | null }) {
  const { tz } = usePrefs();
  if (!data) return <div className="muted small">กำลังโหลดสถานะ…</div>;
  const st = data.status;
  if (!st) {
    return (
      <div className="notice err">
        ยังไม่พบ worker — เปิดด้วย <code>npm run demo</code> หรือ <code>npm run dev</code>
      </div>
    );
  }
  const badge = feedBadge(st, data.workerAlive);
  const connColor = st.connection.state === 'connected' ? 'var(--up)' : st.connection.state === 'error' ? 'var(--down)' : 'var(--warn)';
  const sinceMsg = st.lastMessageAt ? `${formatDuration(Date.now() - st.lastMessageAt)} ที่แล้ว` : '-';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="badges">
        <span className={`badge ${badge.cls}`} title={badge.title}>
          {badge.text}
        </span>
        {!data.workerAlive && <span className="small muted">heartbeat ล่าสุด {formatTs(st.heartbeatAt, tz, { seconds: true })}</span>}
      </div>
      <dl className="kv">
        <dt>Provider</dt>
        <dd>{st.provider.displayName}</dd>
        <dt>Feed</dt>
        <dd>{st.provider.feed}</dd>
        <dt>ความครอบคลุม</dt>
        <dd>{st.provider.coverage}</dd>
        <dt>การเชื่อมต่อ</dt>
        <dd>
          <span className="status-dot" style={{ background: connColor }} />
          {CONN_LABEL[st.connection.state] ?? st.connection.state}
          {st.connection.state === 'reconnecting' && st.connection.nextRetryAt ? ` (ครั้งที่ ${st.connection.attempt ?? '?'})` : ''}
        </dd>
        <dt>ตลาด</dt>
        <dd>{st.market.label}</dd>
        <dt>สถานะข้อมูล</dt>
        <dd>{st.dataStateLabel}</dd>
        <dt>ข้อความล่าสุด</dt>
        <dd>{sinceMsg}</dd>
        <dt>{st.provider.virtualClock ? 'เวลาจำลอง' : 'เวลาข้อมูล'}</dt>
        <dd>{formatTs(st.clockNow, tz, { seconds: true })}</dd>
        <dt>Session</dt>
        <dd>{st.session === 'regular' ? 'Regular (09:30–16:00 ET)' : 'Extended (04:00–20:00 ET)'}</dd>
        <dt>Backfill / Reconnect</dt>
        <dd>
          {st.stats.backfills} / {st.stats.reconnects}
        </dd>
        <dt>ซ้ำ / แก้ไข / มาช้า</dt>
        <dd>
          {st.stats.duplicates} / {st.stats.corrections} / {st.stats.late}
        </dd>
        {st.stats.queueDropped > 0 && (
          <>
            <dt>ทิ้งจาก queue</dt>
            <dd>{st.stats.queueDropped}</dd>
          </>
        )}
      </dl>
      {st.signalsPaused && <div className="notice">พักการสร้างสัญญาณใหม่: {st.pauseReason}</div>}
      {st.stats.lastError && <div className="notice err small">ข้อผิดพลาดล่าสุด: {st.stats.lastError}</div>}
      {st.provider.notes.length > 0 && (
        <ul className="reasons" style={{ paddingLeft: 16 }}>
          {st.provider.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      <div className="small muted">{st.providerReason}</div>
    </div>
  );
}
