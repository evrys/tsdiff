import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { diffDeclarations } from "../src/index.js";

interface Expected {
  description?: string;
  breakingCount?: number;
  breakingCountAtLeast?: number;
  nonBreakingCount?: number;
  infoCount?: number;
  changes?: Array<{
    kind?: string;
    severity?: string;
    name?: string;
  }>;
}

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

const fixtureNames = readdirSync(FIXTURES_DIR).filter((name) =>
  statSync(join(FIXTURES_DIR, name)).isDirectory(),
);

describe("diffDeclarations (fixtures)", () => {
  for (const name of fixtureNames) {
    const dir = join(FIXTURES_DIR, name);
    const expected: Expected = JSON.parse(
      readFileSync(join(dir, "expected.json"), "utf8"),
    );
    const title = expected.description ?? name;

    it(`[${name}] ${title}`, () => {
      const result = diffDeclarations(
        join(dir, "old.d.ts"),
        join(dir, "new.d.ts"),
      );

      if (expected.breakingCount !== undefined) {
        expect(result.breakingCount, "breakingCount").toBe(
          expected.breakingCount,
        );
      }
      if (expected.breakingCountAtLeast !== undefined) {
        expect(result.breakingCount, "breakingCount").toBeGreaterThanOrEqual(
          expected.breakingCountAtLeast,
        );
      }
      if (expected.nonBreakingCount !== undefined) {
        expect(result.nonBreakingCount, "nonBreakingCount").toBe(
          expected.nonBreakingCount,
        );
      }
      if (expected.infoCount !== undefined) {
        expect(result.infoCount, "infoCount").toBe(expected.infoCount);
      }

      if (expected.changes) {
        for (const want of expected.changes) {
          const matched = result.changes.some((c) => {
            if (want.kind && c.kind !== want.kind) return false;
            if (want.severity && c.severity !== want.severity) return false;
            if (want.name && c.name !== want.name) return false;
            return true;
          });
          expect(
            matched,
            `expected a change matching ${JSON.stringify(want)}; got ${JSON.stringify(result.changes, null, 2)}`,
          ).toBe(true);
        }
      }
    });
  }
});

// Regression test for the unbounded `typeToString` expansion in src/diff.ts.
// On chained-builder APIs (zod, mui, ...), `typeToString` produces megabytes
// of structural fingerprint per change, blowing up wall-clock time and heap.
// The recursive-builder fixture is a reduced repro: a single added method on
// a self-referential generic interface currently emits ~4.5 KB of redundant
// text per change (extrapolating to 100+ KB on real zod and OOM on
// @mui/material at the default Node heap).
//
// Marked `.fails` because the bug is currently present; remove the `.fails`
// when fixing diff.ts (e.g. by capping fingerprint depth/size, sharing a
// type-string memoization cache, or short-circuiting on identical Type ids).
describe("regression: chained-builder type-string size", () => {
  const dir = join(FIXTURES_DIR, "recursive-builder");

  it.fails("produces compact type-strings", () => {
    const result = diffDeclarations(
      join(dir, "old.d.ts"),
      join(dir, "new.d.ts"),
    );

    // Each per-change `details.oldType` / `details.newType` should be
    // bounded; today the worst case is ~4.5 KB on this 70-line fixture.
    const SIZE_BOUND = 1500;
    for (const c of result.changes) {
      const oldLen = String(c.details?.oldType ?? "").length;
      const newLen = String(c.details?.newType ?? "").length;
      expect(
        Math.max(oldLen, newLen),
        `change \`${c.name}\` has oversized type-string (old=${oldLen}, new=${newLen})`,
      ).toBeLessThan(SIZE_BOUND);
    }
  });
});
