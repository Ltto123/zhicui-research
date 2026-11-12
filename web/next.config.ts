import type { NextConfig } from 'next';

// Keep validation builds separate from any running local workspace.
const isolatedDist=process.env.ZHICUI_NEXT_DIST_DIR;
if(isolatedDist&&!/^\.next-check-[a-z0-9-]{1,50}$/.test(isolatedDist))throw new Error('隔离构建目录必须位于项目内并使用 .next-check- 前缀');
const config: NextConfig = {
  poweredByHeader: false,
  devIndicators: false,
  // Source readers and verified deletion have bounded client deadlines;
  // keep the rewrite alive through the longest 120-second operation.
  experimental: { proxyTimeout: 130_000 },
  distDir: isolatedDist ?? (process.env.NODE_ENV === 'development' ? '.next-dev' : '.next'),
  async rewrites() {
    return [{ source: '/api/:path*', destination: 'http://127.0.0.1:4310/api/:path*' }];
  },
};
export default config;
