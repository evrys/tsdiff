import { defineConfig } from "vitest/config";

// Default config: run only the unit-test fixture suite. Integration tests
// (which hit the network via TypeScript's Automatic Type Acquisition) live
// in `test/integration/**/*.test.ts` and are run separately via
// `pnpm test:integration` (see package.json).
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/integration/**", "node_modules/**", "dist/**"],
  },
});
