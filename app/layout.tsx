import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Nav } from '@/components/Nav';
import { PrefsProvider } from '@/components/prefs';
import './globals.css';

export const metadata: Metadata = {
  title: 'TrendLens',
  description: 'ติดตามและวิเคราะห์หุ้นเทคสหรัฐฯ (ใช้งานส่วนตัว)',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="th">
      <body>
        <PrefsProvider>
          <Nav />
          {children}
        </PrefsProvider>
      </body>
    </html>
  );
}
