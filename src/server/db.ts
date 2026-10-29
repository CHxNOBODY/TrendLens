/**
 * SQLite storage (better-sqlite3, WAL) — ใช้ร่วมกันระหว่าง Next.js และ worker บนเครื่องเดียว
 * ไฟล์ฐานข้อมูลอยู่ในโฟลเดอร์ data/ ของโปรเจกต์ (อยู่ใน .gitignore)
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { emptyStats, isValidBar, type MergeStats } from '@/core/aggregation';
import { DEFAULT_WATCHLIST } from '@/core/config';
import type { SignalEvent } from '@/core/engine';
import type { Bar, BaseTimeframe } from '@/core/types';

export type DB = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bars (
  dataset TEXT NOT NULL, symbol TEXT NOT NULL, tf TEXT NOT NULL, t INTEGER NOT NULL,
  o REAL NOT NULL, h REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL, v REAL NOT NULL,
  rev INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
  PRIMARY KEY (dataset, symbol, tf, t)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS datasets (
  dataset TEXT PRIMARY KEY, label TEXT NOT NULL, adjustment TEXT NOT NULL, meta TEXT, updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS watchlist (
  symbol TEXT PRIMARY KEY, pos INTEGER NOT NULL, added_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS notes_symbol ON notes(symbol, created_at);

CREATE TABLE IF NOT EXISTS signal_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset TEXT NOT NULL, symbol TEXT NOT NULL, tf TEXT NOT NULL, strategy_key TEXT NOT NULL,
  bar_t INTEGER NOT NULL, kind TEXT NOT NULL, close REAL NOT NULL, trend TEXT NOT NULL,
  reasons TEXT NOT NULL, vals TEXT NOT NULL, origin TEXT NOT NULL, created_at INTEGER NOT NULL,
  UNIQUE (dataset, symbol, tf, strategy_key, bar_t, kind)
);

CREATE TABLE IF NOT EXISTS sim_positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset TEXT NOT NULL, symbol TEXT NOT NULL, tf TEXT NOT NULL, strategy_key TEXT NOT NULL,
  status TEXT NOT NULL, -- open | closed | skipped
  entry_signal_t INTEGER NOT NULL, entry_t INTEGER NOT NULL, entry_price REAL NOT NULL, qty REAL NOT NULL, entry_fee REAL NOT NULL,
  exit_signal_t INTEGER, exit_t INTEGER, exit_price REAL, exit_fee REAL, pnl REAL, note TEXT,
  UNIQUE (dataset, symbol, tf, strategy_key, entry_t)
);

CREATE TABLE IF NOT EXISTS engine_state (key TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER NOT NULL);
`;

export function openDb(file: string): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  db.exec(SCHEMA);
  return db;
}

export interface StoredSignal {
  id: number;
  dataset: string;
  symbol: string;
  tf: string;
  strategyKey: string;
  barTs: number;
  kind: 'enter' | 'exit';
  close: number;
  trend: string;
  reasons: string[];
  values: Record<string, number | null>;
  origin: string;
  createdAt: number;
}

export interface StoredPosition {
  id: number;
  dataset: string;
  symbol: string;
  tf: string;
  strategyKey: string;
  status: 'open' | 'closed' | 'skipped';
  entrySignalTs: number;
  entryTs: number;
  entryPrice: number;
  qty: number;
  entryFee: number;
  exitSignalTs: number | null;
  exitTs: number | null;
  exitPrice: number | null;
  exitFee: number | null;
  pnl: number | null;
  note: string | null;
}

export interface Note {
  id: number;
  symbol: string;
  body: string;
  createdAt: number;
}

const SYMBOL_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;
export function normalizeSymbol(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  const u = s.trim().toUpperCase();
  return SYMBOL_RE.test(u) ? u : null;
}

export class Store {
  constructor(readonly db: DB) {}

  // ---------- bars ----------
  /** upsert ตามนโยบายใน core/aggregation (ซ้ำ=ข้าม, ค่าต่าง=แก้ไข, เก่ากว่า=late) */
  upsertBars(dataset: string, symbol: string, tf: BaseTimeframe, bars: Bar[]): MergeStats {
    const stats = emptyStats();
    if (!bars.length) return stats;
    const sel = this.db.prepare('SELECT o,h,l,c,v FROM bars WHERE dataset=? AND symbol=? AND tf=? AND t=?');
    const ins = this.db.prepare('INSERT INTO bars (dataset,symbol,tf,t,o,h,l,c,v,rev,updated_at) VALUES (?,?,?,?,?,?,?,?,?,0,?)');
    const upd = this.db.prepare('UPDATE bars SET o=?,h=?,l=?,c=?,v=?,rev=rev+1,updated_at=? WHERE dataset=? AND symbol=? AND tf=? AND t=?');
    const now = Date.now();
    this.db.transaction(() => {
      let last = this.lastBarTs(dataset, symbol, tf) ?? -Infinity;
      for (const b of bars) {
        if (!isValidBar(b)) {
          stats.invalid++;
          continue;
        }
        const prev = sel.get(dataset, symbol, tf, b.t) as Omit<Bar, 't'> | undefined;
        if (prev) {
          if (prev.o === b.o && prev.h === b.h && prev.l === b.l && prev.c === b.c && prev.v === b.v) stats.duplicates++;
          else {
            upd.run(b.o, b.h, b.l, b.c, b.v, now, dataset, symbol, tf, b.t);
            stats.corrections++;
          }
          continue;
        }
        ins.run(dataset, symbol, tf, b.t, b.o, b.h, b.l, b.c, b.v, now);
        if (b.t < last) stats.late++;
        else {
          stats.added++;
          last = b.t;
        }
      }
    })();
    return stats;
  }

  getBars(dataset: string, symbol: string, tf: BaseTimeframe, opts: { from?: number; to?: number; limit?: number } = {}): Bar[] {
    const from = opts.from ?? -8.64e15;
    const to = opts.to ?? 8.64e15;
    if (opts.limit) {
      const rows = this.db
        .prepare('SELECT t,o,h,l,c,v FROM bars WHERE dataset=? AND symbol=? AND tf=? AND t>=? AND t<=? ORDER BY t DESC LIMIT ?')
        .all(dataset, symbol, tf, from, to, opts.limit) as Bar[];
      return rows.reverse();
    }
    return this.db
      .prepare('SELECT t,o,h,l,c,v FROM bars WHERE dataset=? AND symbol=? AND tf=? AND t>=? AND t<=? ORDER BY t ASC')
      .all(dataset, symbol, tf, from, to) as Bar[];
  }

  lastBarTs(dataset: string, symbol: string, tf: BaseTimeframe): number | null {
    const r = this.db.prepare('SELECT MAX(t) AS t FROM bars WHERE dataset=? AND symbol=? AND tf=?').get(dataset, symbol, tf) as { t: number | null };
    return r.t;
  }

  countBars(dataset: string, symbol: string, tf: BaseTimeframe): { n: number; first: number | null; last: number | null } {
    return this.db
      .prepare('SELECT COUNT(*) AS n, MIN(t) AS first, MAX(t) AS last FROM bars WHERE dataset=? AND symbol=? AND tf=?')
      .get(dataset, symbol, tf) as { n: number; first: number | null; last: number | null };
  }

  deleteBars(dataset: string, symbol: string, tf?: BaseTimeframe): number {
    return tf
      ? this.db.prepare('DELETE FROM bars WHERE dataset=? AND symbol=? AND tf=?').run(dataset, symbol, tf).changes
      : this.db.prepare('DELETE FROM bars WHERE dataset=? AND symbol=?').run(dataset, symbol).changes;
  }

  registerDataset(dataset: string, label: string, adjustment: string, meta: unknown = null): void {
    this.db
      .prepare('INSERT INTO datasets (dataset,label,adjustment,meta,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(dataset) DO UPDATE SET label=excluded.label, adjustment=excluded.adjustment, meta=excluded.meta, updated_at=excluded.updated_at')
      .run(dataset, label, adjustment, JSON.stringify(meta), Date.now());
  }

  listDatasets(symbol?: string): { dataset: string; label: string; adjustment: string; tf: string; n: number; first: number; last: number }[] {
    const rows = this.db
      .prepare(
        `SELECT b.dataset, COALESCE(d.label, b.dataset) AS label, COALESCE(d.adjustment,'unknown') AS adjustment, b.tf, COUNT(*) AS n, MIN(b.t) AS first, MAX(b.t) AS last
         FROM bars b LEFT JOIN datasets d ON d.dataset=b.dataset ${symbol ? 'WHERE b.symbol=?' : ''}
         GROUP BY b.dataset, b.tf ORDER BY b.dataset, b.tf`,
      )
      .all(...(symbol ? [symbol] : []));
    return rows as never;
  }

  // ---------- watchlist ----------
  getWatchlist(): string[] {
    const seeded = this.getState<boolean>('watchlist_seeded');
    if (!seeded) {
      this.db.transaction(() => {
        DEFAULT_WATCHLIST.forEach((s, i) => this.db.prepare('INSERT OR IGNORE INTO watchlist (symbol,pos,added_at) VALUES (?,?,?)').run(s, i, Date.now()));
        this.setState('watchlist_seeded', true);
      })();
    }
    return (this.db.prepare('SELECT symbol FROM watchlist ORDER BY pos, symbol').all() as { symbol: string }[]).map((r) => r.symbol);
  }

  addToWatchlist(symbol: string): void {
    this.getWatchlist();
    const r = this.db.prepare('SELECT COALESCE(MAX(pos),-1)+1 AS p FROM watchlist').get() as { p: number };
    this.db.prepare('INSERT OR IGNORE INTO watchlist (symbol,pos,added_at) VALUES (?,?,?)').run(symbol, r.p, Date.now());
  }

  removeFromWatchlist(symbol: string): void {
    this.getWatchlist();
    this.db.prepare('DELETE FROM watchlist WHERE symbol=?').run(symbol);
  }

  // ---------- notes ----------
  listNotes(symbol: string): Note[] {
    return this.db.prepare('SELECT id, symbol, body, created_at AS createdAt FROM notes WHERE symbol=? ORDER BY created_at DESC, id DESC').all(symbol) as Note[];
  }

  addNote(symbol: string, body: string): Note {
    const createdAt = Date.now();
    const r = this.db.prepare('INSERT INTO notes (symbol, body, created_at) VALUES (?,?,?)').run(symbol, body, createdAt);
    return { id: Number(r.lastInsertRowid), symbol, body, createdAt };
  }

  deleteNote(id: number): boolean {
    return this.db.prepare('DELETE FROM notes WHERE id=?').run(id).changes > 0;
  }

  // ---------- signals (เหตุการณ์สัญญาณ) ----------
  /** INSERT OR IGNORE บน unique key → ประมวลผลซ้ำ/rerun ไม่สร้างสัญญาณซ้ำ; คืน true ถ้าเพิ่มใหม่ */
  insertSignal(k: { dataset: string; symbol: string; tf: string; strategyKey: string }, s: SignalEvent, origin: string): boolean {
    const r = this.db
      .prepare(
        'INSERT OR IGNORE INTO signal_events (dataset,symbol,tf,strategy_key,bar_t,kind,close,trend,reasons,vals,origin,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(k.dataset, k.symbol, k.tf, k.strategyKey, s.barTs, s.kind, s.close, s.trend, JSON.stringify(s.reasons), JSON.stringify(s.values), origin, Date.now());
    return r.changes > 0;
  }

  listSignals(f: { dataset: string; symbol?: string; tf?: string; strategyKey?: string; from?: number; limit?: number }): StoredSignal[] {
    const where = ['dataset=?'];
    const args: unknown[] = [f.dataset];
    if (f.symbol) (where.push('symbol=?'), args.push(f.symbol));
    if (f.tf) (where.push('tf=?'), args.push(f.tf));
    if (f.strategyKey) (where.push('strategy_key=?'), args.push(f.strategyKey));
    if (f.from !== undefined) (where.push('bar_t>=?'), args.push(f.from));
    args.push(f.limit ?? 500);
    const rows = this.db
      .prepare(`SELECT * FROM signal_events WHERE ${where.join(' AND ')} ORDER BY bar_t DESC, id DESC LIMIT ?`)
      .all(...args) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as number,
      dataset: r.dataset as string,
      symbol: r.symbol as string,
      tf: r.tf as string,
      strategyKey: r.strategy_key as string,
      barTs: r.bar_t as number,
      kind: r.kind as 'enter' | 'exit',
      close: r.close as number,
      trend: r.trend as string,
      reasons: JSON.parse(r.reasons as string),
      values: JSON.parse(r.vals as string),
      origin: r.origin as string,
      createdAt: r.created_at as number,
    }));
  }

  // ---------- simulated positions (สถานะจำลอง แยกจากสัญญาณ) ----------
  openPosition(k: { dataset: string; symbol: string; tf: string; strategyKey: string }, p: { entrySignalTs: number; entryTs: number; entryPrice: number; qty: number; entryFee: number; status?: 'open' | 'skipped'; note?: string }): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO sim_positions (dataset,symbol,tf,strategy_key,status,entry_signal_t,entry_t,entry_price,qty,entry_fee,note) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(k.dataset, k.symbol, k.tf, k.strategyKey, p.status ?? 'open', p.entrySignalTs, p.entryTs, p.entryPrice, p.qty, p.entryFee, p.note ?? null);
  }

  closePosition(k: { dataset: string; symbol: string; tf: string; strategyKey: string }, c: { exitSignalTs: number; exitTs: number; exitPrice: number; exitFee: number; pnl: number }): void {
    this.db
      .prepare(
        `UPDATE sim_positions SET status='closed', exit_signal_t=?, exit_t=?, exit_price=?, exit_fee=?, pnl=?
         WHERE id = (SELECT id FROM sim_positions WHERE dataset=? AND symbol=? AND tf=? AND strategy_key=? AND status='open' ORDER BY entry_t DESC LIMIT 1)`,
      )
      .run(c.exitSignalTs, c.exitTs, c.exitPrice, c.exitFee, c.pnl, k.dataset, k.symbol, k.tf, k.strategyKey);
  }

  listPositions(f: { dataset: string; symbol?: string; strategyKey?: string }): StoredPosition[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM sim_positions WHERE dataset=? ${f.symbol ? 'AND symbol=?' : ''} ${f.strategyKey ? 'AND strategy_key=?' : ''} ORDER BY entry_t DESC LIMIT 1000`,
      )
      .all(f.dataset, ...(f.symbol ? [f.symbol] : []), ...(f.strategyKey ? [f.strategyKey] : [])) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as number,
      dataset: r.dataset as string,
      symbol: r.symbol as string,
      tf: r.tf as string,
      strategyKey: r.strategy_key as string,
      status: r.status as StoredPosition['status'],
      entrySignalTs: r.entry_signal_t as number,
      entryTs: r.entry_t as number,
      entryPrice: r.entry_price as number,
      qty: r.qty as number,
      entryFee: r.entry_fee as number,
      exitSignalTs: r.exit_signal_t as number | null,
      exitTs: r.exit_t as number | null,
      exitPrice: r.exit_price as number | null,
      exitFee: r.exit_fee as number | null,
      pnl: r.pnl as number | null,
      note: r.note as string | null,
    }));
  }

  // ---------- key/value state ----------
  getEngineState<T>(key: string): T | null {
    const r = this.db.prepare('SELECT json FROM engine_state WHERE key=?').get(key) as { json: string } | undefined;
    return r ? (JSON.parse(r.json) as T) : null;
  }
  setEngineState(key: string, v: unknown): void {
    this.db.prepare('INSERT INTO engine_state (key,json,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at').run(key, JSON.stringify(v), Date.now());
  }
  listEngineStates<T>(prefix: string): { key: string; value: T }[] {
    return (this.db.prepare('SELECT key, json FROM engine_state WHERE key LIKE ?').all(`${prefix}%`) as { key: string; json: string }[]).map((r) => ({ key: r.key, value: JSON.parse(r.json) as T }));
  }

  getState<T>(key: string): T | null {
    const r = this.db.prepare('SELECT json FROM app_state WHERE key=?').get(key) as { json: string } | undefined;
    return r ? (JSON.parse(r.json) as T) : null;
  }
  setState(key: string, v: unknown): void {
    this.db.prepare('INSERT INTO app_state (key,json,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at').run(key, JSON.stringify(v), Date.now());
  }
}
