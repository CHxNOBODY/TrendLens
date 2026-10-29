/**
 * TrendLens worker — โปรเซสแยกจาก Next.js สำหรับรับข้อมูลสดและคำนวณสัญญาณ
 * ไม่เปิด port ใด ๆ (สื่อสารกับ Next.js ผ่าน SQLite เท่านั้น)
 */
import { Store, openDb } from '@/server/db';
import { getConfig, loadDotEnv } from '@/server/env';
import { LiveRunner } from '@/server/live/runner';
import { createProvider } from '@/server/providers';

loadDotEnv();
const cfg = getConfig();
const forceDemo = process.argv.includes('--demo');
const store = new Store(openDb(cfg.dbPath));

// นาฬิกา Demo เดินต่อจากครั้งก่อน (ถ้า DEMO_START ไม่เปลี่ยน)
const savedClock = store.getState<{ start: string; virtual: number }>('demo_clock');
const { provider, reason } = createProvider(cfg, {
  forceDemo,
  demoClock: savedClock && savedClock.start === cfg.demo.start ? savedClock.virtual : null,
  saveDemoClock: (v) => store.setState('demo_clock', { start: cfg.demo.start, virtual: v }),
});

console.log(`[worker] ${reason}`);
console.log(`[worker] database: ${cfg.dbPath}`);
console.log(`[worker] session=${cfg.settings.session} strategy timeframes=${cfg.settings.strategyTimeframes.join(',')}`);

const runner = new LiveRunner(cfg, store, provider, reason);

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log('[worker] กำลังหยุด...');
  runner.stop();
  store.db.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

runner.start().catch((e) => {
  console.error(`[worker] เริ่มทำงานไม่สำเร็จ: ${(e as Error).message}`);
  process.exit(1);
});
