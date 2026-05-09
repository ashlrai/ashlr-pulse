import type { NextConfig } from "next";

const config: NextConfig = {
  // Keep strict, log every dev warning to stderr so we catch drift fast.
  reactStrictMode: true,
  logging: { fetches: { fullUrl: true } },
  // Pino's worker_threads-based transport doesn't survive Next.js' bundler:
  // the dynamic require('lib/worker.js') resolves to a vendor-chunk path
  // that's never emitted, throwing MODULE_NOT_FOUND on the first request
  // after a fresh dev start. Externalising pino keeps the require resolving
  // through Node's normal node_modules resolution.
  serverExternalPackages: ["pino"],
};

export default config;
