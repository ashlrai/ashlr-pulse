import type { NextConfig } from "next";

const config: NextConfig = {
  // Keep strict, log every dev warning to stderr so we catch drift fast.
  reactStrictMode: true,
  logging: { fetches: { fullUrl: true } },
  // Standalone output bundles a minimal Node server at .next/standalone/server.js
  // so we can run prod with `node server.js` (sidesteps Bun + Railway runtime issues).
  output: "standalone",
};

export default config;
