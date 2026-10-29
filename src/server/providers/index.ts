import { hasAlpacaCredentials, type ServerConfig } from '../env';
import { AlpacaProvider } from './alpaca';
import { DemoProvider, parseNyLocal } from './demo';
import type { DataProvider } from './types';

export interface ProviderChoiceResult {
  provider: DataProvider;
  reason: string;
}

/**
 * เลือก provider:
 *  - --demo หรือ DATA_PROVIDER=demo → Demo
 *  - DATA_PROVIDER=alpaca แต่ไม่มี key → Demo พร้อมเหตุผล
 *  - auto: มี key → Alpaca, ไม่มี → Demo
 */
export function createProvider(cfg: ServerConfig, opts: { forceDemo: boolean; demoClock?: number | null; saveDemoClock?: (v: number) => void }): ProviderChoiceResult {
  const keys = hasAlpacaCredentials(cfg);
  const demo = () =>
    new DemoProvider({
      start: opts.demoClock ?? parseNyLocal(cfg.demo.start),
      speed: cfg.demo.speed,
      dropEverySec: cfg.demo.dropEverySec,
      saveClock: opts.saveDemoClock,
    });
  if (opts.forceDemo || cfg.provider === 'demo') return { provider: demo(), reason: 'เลือก Demo Mode' };
  if (!keys) {
    return {
      provider: demo(),
      reason: cfg.provider === 'alpaca' ? 'DATA_PROVIDER=alpaca แต่ไม่พบ API key → เปิด Demo Mode แทน' : 'ไม่พบ API key → เปิด Demo Mode อัตโนมัติ',
    };
  }
  return {
    provider: new AlpacaProvider({ keyId: cfg.alpaca.keyId, secretKey: cfg.alpaca.secretKey, feed: cfg.alpaca.feed, adjustment: cfg.alpaca.adjustment }),
    reason: `ใช้ Alpaca feed=${cfg.alpaca.feed}`,
  };
}
