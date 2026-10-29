'use client';

import { useEffect, useState } from 'react';
import { formatTs } from '@/core/time';
import type { Note } from '@/server/db';
import { api } from './api';
import { usePrefs } from './prefs';

export function NotesPanel({ symbol }: { symbol: string }) {
  const { tz } = usePrefs();
  const [notes, setNotes] = useState<Note[]>([]);
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    api<{ notes: Note[] }>(`/api/notes?symbol=${symbol}`)
      .then((r) => alive && setNotes(r.notes))
      .catch((e) => alive && setErr(e.message));
    return () => {
      alive = false;
    };
  }, [symbol]);

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      const r = await api<{ note: Note }>('/api/notes', { method: 'POST', body: JSON.stringify({ symbol, body: text }) });
      setNotes([r.note, ...notes]);
      setText('');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: number) {
    await api(`/api/notes?id=${id}`, { method: 'DELETE' });
    setNotes(notes.filter((n) => n.id !== id));
  }

  return (
    <div className="card">
      <h2>บันทึกส่วนตัว — {symbol}</h2>
      <textarea
        className="input"
        rows={3}
        placeholder={`จดบันทึกเกี่ยวกับ ${symbol} (เก็บใน SQLite บนเครื่องนี้)`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && text.trim()) void save();
        }}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6 }}>
        <span className="small muted">Ctrl+Enter เพื่อบันทึก</span>
        <button className="btn primary" disabled={!text.trim() || saving} onClick={save}>
          บันทึก
        </button>
      </div>
      {err && <div className="notice err small" style={{ marginTop: 6 }}>{err}</div>}
      <div style={{ marginTop: 8, maxHeight: 260, overflow: 'auto' }}>
        {notes.length === 0 && <div className="muted small">ยังไม่มีบันทึก</div>}
        {notes.map((n) => (
          <div key={n.id} className="note">
            <div className="meta">
              <span>{formatTs(n.createdAt, tz)}</span>
              <button className="btn small" onClick={() => remove(n.id)}>
                ลบ
              </button>
            </div>
            <div className="body">{n.body}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
