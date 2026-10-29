'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { BKK_TZ, NY_TZ } from '@/core/market';
import { usePrefs } from './prefs';

const LINKS = [
  { href: '/', label: 'แดชบอร์ด' },
  { href: '/backtest', label: 'ทดสอบย้อนหลัง' },
  { href: '/positions', label: 'สถานะจำลอง' },
  { href: '/data', label: 'ข้อมูล / CSV' },
];

export function Nav() {
  const path = usePathname();
  const { tz, setTz } = usePrefs();
  return (
    <nav className="topnav">
      <div className="brand">
        Trend<span>Lens</span>
      </div>
      {LINKS.map((l) => (
        <Link key={l.href} href={l.href} className={path === l.href ? 'active' : ''}>
          {l.label}
        </Link>
      ))}
      <div className="spacer" />
      <span className="muted small" style={{ marginRight: 8 }}>
        แสดงเวลา
      </span>
      <div className="tz-switch" role="group" aria-label="เลือกเขตเวลา">
        <button className={tz === BKK_TZ ? 'on' : ''} onClick={() => setTz(BKK_TZ)}>
          กรุงเทพฯ
        </button>
        <button className={tz === NY_TZ ? 'on' : ''} onClick={() => setTz(NY_TZ)}>
          นิวยอร์ก
        </button>
      </div>
    </nav>
  );
}
