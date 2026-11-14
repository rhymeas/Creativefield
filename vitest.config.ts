import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Test-only config (vite build keeps using vite.config.ts). The global
// setup boots a throwaway embedded PostgreSQL so integration suites run.
export default defineConfig({
  plugins: [react()],
  test: {
    globalSetup: ["./test/global-setup.ts"],
    // Integration suites boot the real server and run migrations against
    // the throwaway database; real FFmpeg cases also take 10-60 s while the
    // full suite runs in parallel. The 5 s default is far too small.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // The media suites are CPU-bound: each contract test starts several
    // FFmpeg/FFprobe processes. More than four forks makes the short
    // 15-60 s cases time out and leaves scratch attempts behind, which then
    // breaks later cancellation assertions. Four forks keep the full suite
    // at roughly the same wall time without that contention.
    poolOptions: { forks: { minForks: 1, maxForks: 4 } },
  },
});
