import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false, // reloaded: gmv index v4
  // Optimasi produksi: sembunyikan header x-powered-by + buang console.log dari bundle
  // (console.error/warn dipertahankan untuk diagnosa).
  poweredByHeader: false,
  compiler: {
    removeConsole: process.env.NODE_ENV === "production" ? { exclude: ["error", "warn"] } : false,
  },
  // Prisma client diregenerasi (index windowBucket+sales) — trigger agar dev server memuat ulang modul node_modules
  // v5.1: instrumentation.ts (bot-anchor) — next-server kini menjaga rantai supervisor→bot 24/7.
  // v5.1b: anchor fix — stdio node-style + venv PATH deterministik.
};

export default nextConfig;
