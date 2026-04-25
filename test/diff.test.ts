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
