import path from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // better-sqlite3 เป็น native module → ไม่ bundle
  serverExternalPackages: ['better-sqlite3'],
  turbopack: { root: path.resolve(process.cwd()) },
  devIndicators: false,
  poweredByHeader: false,
};

export default nextConfig;
