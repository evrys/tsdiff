import { defineConfig } from "vitest/config";

// Integration tests: diff real published npm packages via TypeScript ATA.
// These hit the network and are slow, so they are gated behind
// `pnpm test:integration` and excluded from the default `pnpm test` run.
export default defineConfig({
  test: {
    include: ["test/integration/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
