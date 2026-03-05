/** @type {import('next').NextConfig} */
const nextConfig = {
  // Yahoo Finance API 호출 시 CORS 우회를 위한 헤더
  async headers() {
    return [
      {
        source: '/api/:path*',
        headers: [
          { key: 'Access-Control-Allow-Origin', value: '*' },
        ],
      },
    ];
  },
};

export default nextConfig;

import('@opennextjs/cloudflare').then(m => m.initOpenNextCloudflareForDev());
