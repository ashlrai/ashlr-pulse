import type { NextConfig } from "next";

const config: NextConfig = {
  // Keep strict, log every dev warning to stderr so we catch drift fast.
  reactStrictMode: true,
  logging: { fetches: { fullUrl: true } },
};

export default config;
