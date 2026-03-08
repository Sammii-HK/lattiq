import type { NextConfig } from "next";
import path from "path";

/**
 * next.config.ts — Next.js configuration for Lattiq.
 *
 * ## The yjs + webpack binary encoding problem
 *
 * yjs.mjs contains binary lookup tables (Uint8Array data) that are
 * evaluated at module load time via lib0/decoding.js. Webpack's module
 * evaluation corrupts this binary data, causing "Unexpected end of array".
 *
 * The fix: force ALL imports of `yjs` to resolve to `yjs/dist/yjs.cjs`
 * instead of `yjs/dist/yjs.mjs`. The CJS build is generated from the
 * same source and works correctly with webpack's CommonJS handling.
 *
 * We also deduplicate lib0 to prevent "Yjs was already imported" errors
 * from multiple copies resolving through different node_modules paths.
 */
const nextConfig: NextConfig = {
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      // Force CJS build of yjs — the ESM build has binary encoding
      // that webpack corrupts during module evaluation.
      yjs: path.resolve(__dirname, "node_modules/yjs/dist/yjs.cjs"),
      // Deduplicate lib0 to a single copy.
      lib0: path.resolve(__dirname, "node_modules/lib0"),
    };
    return config;
  },
};

export default nextConfig;
