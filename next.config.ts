import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: false,
  // La PWA vive en public/pedidos; Next no sirve índices de directorio
  async redirects() {
    return [
      { source: '/', destination: '/pedidos/index.html', permanent: false },
      { source: '/pedidos', destination: '/pedidos/index.html', permanent: false },
    ];
  },
};

export default nextConfig;
