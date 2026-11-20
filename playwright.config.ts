import { defineConfig } from "@playwright/test";
import { APP_PORT, ROOM_SECRET, WS_PORT } from "./e2e/env";

/**
 * End-to-end tests and benchmarks run against a production build:
 *
 *   pnpm test:e2e   # builds with NEXT_PUBLIC_WS_URL pointing at the test server, then tests
 *   pnpm bench      # same build, runs the @bench specs and writes bench/results.json
 *
 * The room server is started by the tests themselves (e2e/room-server.ts)
 * because the offline tests need to stop and restart it.
 */
export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  // Benchmarks only run with BENCH=1 (pnpm bench); tests skip them.
  grep: process.env.BENCH ? /@bench/ : undefined,
  grepInvert: process.env.BENCH ? undefined : /@bench/,
  use: {
    baseURL: `http://localhost:${APP_PORT}`,
    // System Chrome, so no browser download is needed.
    channel: "chrome",
    headless: true,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `pnpm exec next start -p ${APP_PORT}`,
    url: `http://localhost:${APP_PORT}`,
    reuseExistingServer: false,
    env: { LATTIQ_ROOM_SECRET: ROOM_SECRET, NEXT_DIST_DIR: ".next-e2e" },
    timeout: 60_000,
  },
  metadata: { wsPort: WS_PORT },
});
