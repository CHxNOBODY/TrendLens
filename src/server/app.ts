/** singleton สำหรับ Next.js route handlers (ฝั่ง server เท่านั้น) */
import { NextResponse } from 'next/server';
import { Store, openDb } from './db';
import { getConfig, type ServerConfig } from './env';
import { WORKER_DEAD_AFTER_MS, type WorkerStatus } from './status';

const g = globalThis as unknown as { __trendlens?: { store: Store; cfg: ServerConfig } };

export function ctx(): { store: Store; cfg: ServerConfig } {
  if (!g.__trendlens) {
    const cfg = getConfig();
    g.__trendlens = { cfg, store: new Store(openDb(cfg.dbPath)) };
  }
  return g.__trendlens;
}

export function workerStatus(store: Store): { status: WorkerStatus | null; workerAlive: boolean } {
  const status = store.getState<WorkerStatus>('status');
  return { status, workerAlive: !!status && Date.now() - status.heartbeatAt < WORKER_DEAD_AFTER_MS };
}

/** dataset ที่ใช้แสดงผล = ของ provider ที่ worker ใช้อยู่ (ค่าเริ่มต้น demo) */
export function activeDataset(store: Store): string {
  return workerStatus(store).status?.provider.dataset ?? 'demo';
}

export function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}
