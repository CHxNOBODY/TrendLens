/**
 * การตั้งค่าฝั่ง server/worker เท่านั้น — ห้าม import จาก client component
 * secret อ่านจาก environment variables (ไม่มี NEXT_PUBLIC_) และไม่ถูกส่งออกไปยัง API/UI/log
 */
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_SETTINGS, mergeSettings, type AppSettings } from '@/core/config';

export const ROOT = /*turbopackIgnore: true*/ process.cwd();

let envLoaded = false;
/** worker ต้องโหลด .env เอง (Next.js โหลดให้อัตโนมัติ) */
export function loadDotEnv(): void {
  if (envLoaded) return;
  envLoaded = true;
  const p = path.join(/*turbopackIgnore: true*/ ROOT, '.env');
  if (fs.existsSync(p)) process.loadEnvFile(p);
}

export type ProviderChoice = 'auto' | 'demo' | 'alpaca';
export type AlpacaFeed = 'iex' | 'sip' | 'delayed_sip';
export type Adjustment = 'raw' | 'split' | 'all';

export interface ServerConfig {
  dbPath: string;
  provider: ProviderChoice;
  alpaca: { keyId: string; secretKey: string; feed: AlpacaFeed; adjustment: Adjustment };
  uiRefreshMs: number;
  workerTickMs: number;
  staleAfterSec: number;
  closeGraceSec: number;
  dailyCloseGraceMin: number;
  intradayHistoryDays: number;
  dailyHistoryDays: number;
  queueCapacity: number;
  demo: { start: string; speed: number; dropEverySec: number };
  settings: AppSettings;
}

function num(name: string, def: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return def;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

function pick<T extends string>(name: string, allowed: readonly T[], def: T): T {
  const raw = (process.env[name] ?? '').trim().toLowerCase();
  return (allowed as readonly string[]).includes(raw) ? (raw as T) : def;
}

function readSettingsFile(): AppSettings {
  const p = path.join(/*turbopackIgnore: true*/ ROOT, 'trendlens.config.json');
  if (!fs.existsSync(p)) return DEFAULT_SETTINGS;
  try {
    return mergeSettings(DEFAULT_SETTINGS, JSON.parse(fs.readFileSync(p, 'utf8')));
  } catch (e) {
    console.warn(`[config] อ่าน trendlens.config.json ไม่ได้ ใช้ค่าเริ่มต้นแทน: ${(e as Error).message}`);
    return DEFAULT_SETTINGS;
  }
}

export function getConfig(): ServerConfig {
  const settings = readSettingsFile();
  const sessionEnv = pick('MARKET_SESSION', ['regular', 'extended'] as const, settings.session);
  return {
    dbPath: path.resolve(/*turbopackIgnore: true*/ ROOT, process.env.TRENDLENS_DB_PATH || 'data/trendlens.db'),
    provider: pick('DATA_PROVIDER', ['auto', 'demo', 'alpaca'] as const, 'auto'),
    alpaca: {
      keyId: (process.env.ALPACA_API_KEY_ID ?? '').trim(),
      secretKey: (process.env.ALPACA_API_SECRET_KEY ?? '').trim(),
      feed: pick('ALPACA_FEED', ['iex', 'sip', 'delayed_sip'] as const, 'iex'),
      adjustment: pick('ALPACA_ADJUSTMENT', ['raw', 'split', 'all'] as const, 'split'),
    },
    uiRefreshMs: num('UI_REFRESH_MS', 2000, 500, 60_000),
    workerTickMs: num('WORKER_TICK_MS', 1000, 200, 10_000),
    staleAfterSec: num('STALE_AFTER_SEC', 120, 10, 3600),
    closeGraceSec: num('BAR_CLOSE_GRACE_SEC', 15, 0, 300),
    dailyCloseGraceMin: num('DAILY_CLOSE_GRACE_MIN', 20, 0, 240),
    intradayHistoryDays: num('INTRADAY_HISTORY_DAYS', 30, 2, 365),
    dailyHistoryDays: num('DAILY_HISTORY_DAYS', 1100, 30, 3650),
    queueCapacity: num('STREAM_QUEUE_CAPACITY', 20_000, 100, 1_000_000),
    demo: {
      start: process.env.DEMO_START?.trim() || '2026-10-01T10:00',
      speed: num('DEMO_SPEED', 10, 1, 120),
      dropEverySec: num('DEMO_DROP_EVERY_SEC', 0, 0, 86_400),
    },
    settings: { ...settings, session: sessionEnv },
  };
}

export function hasAlpacaCredentials(c: ServerConfig): boolean {
  return c.alpaca.keyId.length > 0 && c.alpaca.secretKey.length > 0;
}
