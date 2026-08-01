// Phase 6 — vitest project split.
//
// `unit`  — fast pure-function tests (backtest math, formatters, mode
//           summary, series builders). Run on every commit / pre-push.
// `ci`    — heavier suites: e2e component flows, integration, visual /
//           snapshot / contract / property / perf / regression / fuzz.
//           Run in CI.
//
// The split is filename-driven so contributors don't have to configure
// anything — pick the right suffix (`.e2e.test.tsx`, `.visual.test.ts`,
// `.contract.test.tsx`, etc.) and the file lands in the right project.

import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Suffixes that indicate a heavier CI-only test. Anything else is treated
// as a fast unit test.
const HEAVY_SUFFIXES = [
  "e2e",
  "integration",
  "visual",
  "contract",
  "property",
  "snapshot",
  "perf",
  "regression",
  "fuzz",
];

const heavyGlobs = HEAVY_SUFFIXES.flatMap((s) => [
  `src/**/*.${s}.test.ts`,
  `src/**/*.${s}.test.tsx`,
]);

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    // Suites that dynamically import heavy server modules can exceed the 5s
    // default when the full suite runs in parallel.
    testTimeout: 30000,
    hookTimeout: 30000,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
          exclude: [...heavyGlobs, "**/node_modules/**"],
        },
      },
      {
        extends: true,
        test: {
          name: "ci",
          environment: "node",
          include: heavyGlobs,
          exclude: ["**/node_modules/**"],
        },
      },
    ],
  },
});
